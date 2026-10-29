# 19. File uploads

> **Run order:** Prisma server, port 4010, auth on, cache off, deprecation headers off.
>
> Every request below is copied from `transcripts/19-file-uploads.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

You want to give the teacher a drawing for the class wall. You do not glue it into the rulebook. You hand it over in an **envelope** with a label: "drawing by Sam, for poster 3".

The teacher checks it is really a drawing (not a letter with "drawing" written on it), checks it is not too big for the wall, writes a **receipt** ("poster 12, stored in drawer 4"), and puts it in the drawer under your class's name.

Later, anyone with the right class card can say "show me poster 12", and the teacher brings exactly that drawing — not a different class's drawing.

---

## 2. Real name

A **file upload** sends binary data alongside metadata, usually with `Content-Type: multipart/form-data` (RFC 7578). The multipart body has parts; this API accepts exactly one part named `file`.

Design decisions:

| Decision | This API |
| --- | --- |
| Transport | `multipart/form-data`, one file part |
| Allowed types | PNG, JPEG, WebP |
| Type verification | **Magic bytes**, not the client's `Content-Type` or filename |
| Max size | 2 MiB (server) |
| Too large | `413 Content Too Large` |
| Wrong type | `415 Unsupported Media Type` |
| Missing file | `422` with a field error |
| Related resource | Optional `?productId=`, must exist **in this tenant** |
| Storage key | `{tenantId}/{uploadId}.{sniffedExt}` — never the client filename |
| Metadata | DB row (`uploads`) with tenant, size, sniffed type, checksum |
| Read | `GET /uploads/{id}`, tenant-scoped, `Content-Disposition`, `nosniff` |
| Response | `201 Created`, `Location`, size, SHA-256 checksum |

Why verify magic bytes? The client's `Content-Type` and filename are claims. A file named `logo.png` can be an HTML document or a PHP script. Magic-byte sniffing plus a server-chosen extension means the stored bytes and the served type agree, which defeats "polyglot" upload attacks and stored XSS. `X-Content-Type-Options: nosniff` stops browsers from second-guessing the declared type.

Why a DB row plus a storage key? The bytes live on disk (or object storage); the row is the authoritative metadata and the tenant boundary. Never serve a file by path from a client-supplied name.

---

## 3. Example

### Sniffing and limits

```ts
// src/routes/uploads.ts (excerpt)
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);

function sniffImage(bytes: Buffer): { contentType: string; ext: string } | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', ext: '.png' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: 'image/jpeg', ext: '.jpg' };
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { contentType: 'image/webp', ext: '.webp' };
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED.has(file.mimetype)) {
      callback(new HttpProblem(415, 'unsupported_media_type', 'Only PNG, JPEG, and WebP images are accepted.'));
      return;
    }
    callback(null, true);
  },
});
```

The `fileFilter` is a cheap early rejection based on the declared type; the sniff is the real check. Memory storage is fine for a 2 MiB image; for large media, stream to disk or object storage instead.

### Handler: auth, optional parent, sniff, isolate, store

```ts
// src/routes/uploads.ts (excerpt)
router.post('/', requireRole('ADMIN', 'PLATFORM_ADMIN'), singleFile, async (req, res) => {
  const tenantId = tenantIdOf(req);
  const file = req.file;
  if (!file) throw new HttpProblem(422, 'file_required', 'Send one file in the multipart field named "file".', { /* ... */ });

  const productIdRaw = typeof req.query.productId === 'string' ? req.query.productId : undefined;
  if (productIdRaw) {
    const product = await store.findProduct(tenantId, productIdRaw); // tenant-scoped parent check
    if (!product) throw notFound('Product not found.');
  }

  const sniffed = sniffImage(file.buffer);
  if (!sniffed) throw new HttpProblem(415, 'unsupported_media_type', 'The file content is not a PNG, JPEG, or WebP image.');

  const id = newId('upl');
  const storageKey = join(tenantId, `${id}${sniffed.ext}`); // server-chosen path
  // ... write bytes, create upload row with tenantId, sniffed contentType, size, storageKey ...
  res.status(201).location(`/v1/tenants/${tenantId}/uploads/${record.id}`).json({
    id: record.id, productId: record.productId, filename: record.filename,
    contentType: record.contentType, sizeBytes: record.sizeBytes,
    url: `/v1/tenants/${tenantId}/uploads/${record.id}`,
    checksumSha256: createHash('sha256').update(file.buffer).digest('hex'),
    createdAt: iso(record.createdAt),
  });
});
```

The storage key uses the generated id and the sniffed extension, so the client filename cannot influence where bytes go (no `../`), what extension they get (no `.php`), or which tenant directory they land in.

### Serving: tenant-scoped, safe headers

```ts
// src/routes/uploads.ts (excerpt)
router.get('/:uploadId', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const record = await prisma.upload.findFirst({ where: { id: pathParam(req, 'uploadId'), tenantId } });
  if (!record) throw notFound('Upload not found.');

  res.type(record.contentType);                       // sniffed at upload time
  res.set({
    'Content-Disposition': `inline; filename="${record.filename}"`,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  res.sendFile(join(config.uploadDir, record.storageKey));
});
```

`filename` is sanitized at upload time (path separators removed, unsafe characters replaced, length capped) so the header cannot be broken by quotes or newlines.

### Upload: 201 with metadata and checksum

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/uploads\?productId=prd_tee -H 'Authorization: Bearer tok_acme_admin' -F file=@requests/fixtures/pixel.png;type=image/png
HTTP/1.1 201 Created
X-Request-Id: 10719487-7439-45e7-a78c-0e76d980c4df
Cache-Control: no-store
Location: /v1/tenants/ten_acme/uploads/upl_04f56da6-b9c4-4c85-8e81-a28b96c30165
Content-Type: application/json; charset=utf-8
Content-Length: 336
Date: Thu, 29 Oct 2026 12:28:59 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"upl_04f56da6-b9c4-4c85-8e81-a28b96c30165","productId":"prd_tee","filename":"pixel.png","contentType":"image/png","sizeBytes":70,"url":"/v1/tenants/ten_acme/uploads/upl_04f56da6-b9c4-4c85-8e81-a28b96c30165","checksumSha256":"c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77","createdAt":"2026-10-29T12:28:59.656Z"}
```

`201` because an upload resource was created; `Location` points at it. The checksum lets a client verify the bytes arrived intact and supports deduplication later.

### Download: bytes with safe headers

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/uploads/upl_04f56da6-b9c4-4c85-8e81-a28b96c30165 -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 200 OK
X-Request-Id: 6d753af0-47fe-467a-b514-a897508253ff
Content-Type: image/png
Content-Disposition: inline; filename="pixel.png"
Cache-Control: private, max-age=300
X-Content-Type-Options: nosniff
Accept-Ranges: bytes
Last-Modified: Thu, 29 Oct 2026 12:28:59 GMT
Content-Length: 70
Date: Thu, 29 Oct 2026 12:28:59 GMT
Connection: keep-alive
Keep-Alive: timeout=5

<binary body: 70 bytes, image/png>
```

`Accept-Ranges: bytes` and `Last-Modified` come from `res.sendFile`; range requests work, which matters for large media. `private` because the file is tenant-private; a public CDN would need a signed URL design instead.

### Cross-tenant upload id under Acme's token: 403

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_globex/uploads/upl_04f56da6-b9c4-4c85-8e81-a28b96c30165 -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 403 Forbidden
X-Request-Id: af25c455-90cd-4ab3-b596-5ed385968af1
Content-Type: application/problem+json; charset=utf-8
Content-Length: 252
Date: Thu, 29 Oct 2026 12:28:59 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/forbidden","title":"Forbidden","status":403,"detail":"This token is not allowed to access that tenant.","instance":"/v1/tenants/ten_globex/uploads/upl_04f56da6-b9c4-4c85-8e81-a28b96c30165","code":"forbidden"}
```

The tenant boundary rejects the path before any upload lookup.

### Fake image: declared PNG, bytes are not: 415

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/uploads -H 'Authorization: Bearer tok_acme_admin' -F file=@requests/fixtures/not-an-image.png;type=image/png
HTTP/1.1 415 Unsupported Media Type
X-Request-Id: b9c25c73-f628-4011-870d-3b5ae4cc9fac
Content-Type: application/problem+json; charset=utf-8
Content-Length: 251
Date: Thu, 29 Oct 2026 12:28:59 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/unsupported_media_type","title":"Unsupported Media Type","status":415,"detail":"The file content is not a PNG, JPEG, or WebP image.","instance":"/v1/tenants/ten_acme/uploads","code":"unsupported_media_type"}
```

This is why `fileFilter` alone is not enough: the client sent `type=image/png` and a `.png` name, and the declared type passed. The sniff caught the content.

### Too large: 413 (after the client sends `100 Continue`)

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/uploads -H 'Authorization: Bearer tok_acme_admin' -F file=@requests/fixtures/too-big.png;type=image/png
HTTP/1.1 100 Continue

HTTP/1.1 413 Payload Too Large
X-Request-Id: 82dde6b8-0e8c-4691-afbb-dc7878660df6
Content-Type: application/problem+json; charset=utf-8
Content-Length: 216
Date: Thu, 29 Oct 2026 12:28:59 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/file_too_large","title":"Content Too Large","status":413,"detail":"Images must be at most 2097152 bytes.","instance":"/v1/tenants/ten_acme/uploads","code":"file_too_large"}
```

`100 Continue` is the client asking "may I send the body?"; the server is allowed to answer `413` early, but by then the body is already in flight (curl sends it after the interim response). Multer stops reading at the limit. Title is "Content Too Large" (RFC 9110's current reason name); the status line still says `Payload Too Large` because Node's HTTP module has not caught up to the RFC wording — a harmless vocabulary difference, not a different status.

### Missing parent product: 404 before storing

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/uploads\?productId=prd_missing -H 'Authorization: Bearer tok_acme_admin' -F file=@requests/fixtures/pixel.png;type=image/png
HTTP/1.1 404 Not Found
X-Request-Id: b86270b6-0f29-4300-adf3-8c6685435c7c
Content-Type: application/problem+json; charset=utf-8
Content-Length: 201
Date: Thu, 29 Oct 2026 12:28:59 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"Product not found.","instance":"/v1/tenants/ten_acme/uploads?productId=prd_missing","code":"not_found"}
```

The parent link is checked in the tenant before the file is written; no orphan file for a nonexistent product.

### Globex admin, Acme upload id, Globex path: 404

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_globex/uploads/upl_04f56da6-b9c4-4c85-8e81-a28b96c30165 -H 'Authorization: Bearer tok_globex_admin'
HTTP/1.1 404 Not Found
X-Request-Id: 7a51a84e-159f-4e6d-b131-1e536289e18d
Content-Type: application/problem+json; charset=utf-8
Content-Length: 221
Date: Thu, 29 Oct 2026 12:28:59 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"Upload not found.","instance":"/v1/tenants/ten_globex/uploads/upl_04f56da6-b9c4-4c85-8e81-a28b96c30165","code":"not_found"}
```

This is the in-tenant case: the token matches the path (Globex), but the upload id belongs to Acme. The tenant-scoped query returns no row → 404. There is no hint that the id exists elsewhere.

Matching `.http` file: [`requests/19-file-uploads.http`](../requests/19-file-uploads.http). Full capture: [`transcripts/19-file-uploads.txt`](../transcripts/19-file-uploads.txt).

---

## 4. Bad vs good

**Bad — trust the filename and type**

```ts
// DANGER DEMO — DO NOT SHIP
const dest = join(uploadDir, file.originalname); // ../../etc/passwd, .php, .html
await writeFile(dest, file.buffer);
```

Path traversal, executable extension, and stored XSS in one line. Even a "safe" filename can collide between tenants.

**Bad — trust `file.mimetype` only**

The multipart part declares its own type; an attacker sets it to `image/png`. Without sniffing, an HTML file is stored as a "PNG" and served back with `Content-Type: image/png` — that specific mismatch is usually harmless because of `nosniff`, but a stored `.html` served as `text/html` is not. Sniff, then choose both type and extension.

**Bad — serve files by path**

`res.sendFile(req.query.path)` is arbitrary file read. Serve by an id that maps to a stored key.

**Bad — no size limit**

Unbounded uploads fill memory (with `memoryStorage`) or disk, and one request can take the service down. Limit early; rejection after the full body is uploaded still consumes bandwidth, so enforce at the edge too.

**Bad — 500 on a wrong type or size**

These are client mistakes with precise statuses: `415` and `413`. A 500 page tells the client to retry.

**Good — sniff, isolate, record, scope**

```ts
const sniffed = sniffImage(file.buffer);
const storageKey = join(tenantId, `${id}${sniffed.ext}`);
const record = await prisma.upload.create({ data: { tenantId, contentType: sniffed.contentType, /* ... */ } });
```

**Trade-offs:**

- **Memory vs disk vs object storage.** `memoryStorage` is simple and fine for small images; it dies on large files. Disk spooling reduces memory; object storage (S3) scales and supports signed URLs, at the cost of a dependency. Stream large files directly to storage, never buffer them.
- **Magic bytes vs a full decoder.** Sniffing magic bytes is cheap and stops obvious fakes; it does not prove the image decodes safely. For untrusted images, re-encode with an image library (strips metadata and malicious payloads) or scan them. This tutorial sniffs only.
- **`201` + resource vs `200` with a URL.** 201 is correct: a resource was created. Some upload APIs return 200 for "processed"; if the upload is queued for processing, 202 + operation (chapter 18) is better.
- **Store bytes on disk vs in the DB.** DB blobs keep everything in one transaction and backup, but bloat the database and its WAL. Files + metadata rows are the common choice; they require an orphan-cleanup job when the row insert fails after the file write (or write to a temp key, insert, then move).
- **Serve inline vs attachment.** `inline` is right for images you display; `attachment` forces a download. For user-supplied HTML/SVG, prefer `attachment` or serve from a separate origin, because inline active content is an XSS risk. SVG is not accepted here.
- **Private direct URL vs signed URL.** This API serves through an authenticated endpoint, which is simple and auditable. A CDN needs signed, expiring URLs, and those URLs are bearer credentials — treat them as such.
- **Dedup by checksum.** A SHA-256 lets you return an existing upload for identical bytes, saving storage. It also leaks existence across tenants if the lookup is global; scope dedup by tenant.
- **Antivirus.** Images can carry malware or exploits for decoders. Production upload pipelines scan asynchronously and quarantine; the upload endpoint returns `202` and the file is not served until clean.

---

## 5. In a real multi-tenant e-commerce platform

A merchant uploads product photos from the admin UI. Each request is tenant-scoped; the file is stored under `uploads/{tenantId}/{uploadId}.{ext}` and a row links it to the product. The storefront later fetches images through a CDN, which uses a signed URL generated from the upload row — the raw storage path is never public.

A malicious seller uploads `photo.png` that is actually an HTML page. Sniffing rejects it with 415. A seller uploads a 50 MB file: 413 at the edge and at the app. A seller tries `../../ten_acme/pixel.png` as a filename: the name is sanitized for display, and the storage key never contains it. A Globex seller guesses an Acme upload id: path/token mismatch is 403; matching path but Acme id is 404.

On delete (not implemented here), the row is soft-deleted or removed and the bytes are removed by a cleanup worker, so a deleted product photo cannot be fetched by an old URL forever. Backups and retention policies apply to the storage bucket, not only the database.

---

## 6. When to use it and when NOT to

**Use multipart upload when:**

- Users submit files with metadata (product image, invoice PDF).
- Files are small enough to pass through the API.
- You need authorization, validation, and auditing at the boundary.

**When not to:**

- **Huge media (video, archives).** Use direct-to-storage presigned uploads; the API issues the URL and records the result. Proxying gigabytes through Node is wasteful.
- **Machine-to-machine data** that can be a JSON field or a URL reference.
- **Files already in object storage** — pass the object key, do not re-upload bytes.

**Do not** accept arbitrary types "for flexibility"; every type you accept is attack surface (SVG, HTML, archives with path traversal). Start with a small allowlist.

---

## 7. Common mistakes

1. **Using the client filename as a path.** Traversal and collisions.
2. **Trusting `Content-Type` or the extension.** Sniff the bytes.
3. **Serving with `nosniff` missing.** Browsers may reinterpret content.
4. **Letting a user-controlled `Content-Disposition` filename break the header.** Sanitize quotes/newlines.
5. **No size limit or a limit enforced only after buffering.** Memory exhaustion.
6. **Writing the file before checking tenant and parent.** Orphans and cross-tenant paths.
7. **Inserting the DB row before the file write succeeds.** Dangling rows that 500 on download. Pick an order and clean up on failure.
8. **No checksum.** Cannot verify integrity or dedupe.
9. **Serving private files with `public` caching.** CDN/shared cache leaks.
10. **Serving user HTML/SVG inline.** XSS. Reject or force download.
11. **No cleanup for deleted uploads.** Storage grows silently.
12. **No virus/malware scanning.** Images can carry exploits.
13. **Accepting multiple files when the API promises one.** Validate `files: 1` and reject extra parts.
14. **Returning a 500 for client errors.** Use 415/413/422 precisely.
15. **Leaking storage paths or internal URLs.** Return the API resource URL, not the filesystem key.
16. **Not recording who uploaded what.** Needed for abuse handling and audits (actor, tenant, time).

---

## 8. Try it yourself

**Exercise.** Allow PDF invoices up to 10 MiB, attached to an order.

1. Add the PDF magic bytes (`%PDF-`) to the sniffer and the allowed types. What extension do you choose?
2. Change the size limit to 10 MiB. Where else must the limit change (proxy, multer, storage)?
3. Should the file be served `inline` or `attachment`? Why?
4. The order id is supplied in the path (`/orders/{orderId}/invoices`). How do you prevent an Acme upload from attaching to a Globex order?
5. Two identical invoices are uploaded by the same tenant. How would you dedupe, and what would you return?

**Hint.** Sniff `%PDF-` → `application/pdf` + `.pdf`. Update `MAX_BYTES`, the gateway/body limit, and the error message. Use `attachment` (a PDF can contain scripts/links; forcing download is safer). Look up the order with `tenantId` from the token/path before creating the upload, and store `orderId` in the upload row with a composite FK. Dedupe by SHA-256 scoped to tenant: return `200` (or `201` with the existing id) and document which.

---

## 9. Next

[20. Webhooks →](20-webhooks.md)
