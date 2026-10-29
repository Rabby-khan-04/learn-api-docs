# 13c. Concurrency: ETags and If-Match

> **Run order:** Prisma server, port 4010, auth off, cache **on**, deprecation headers off.
>
> Every request below is copied from `transcripts/13c-concurrency-etags-if-match.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

Two children want to write on the same page of a notebook. Both read it, both start writing, and the second one's writing covers the first one's. Nobody notices, and the first child's work is gone.

The teacher fixes it with a **page number stamp** in the corner. When you start writing, you note the stamp. When you hand the page back, the teacher checks: "Is the stamp still the one you started with?" If not, the teacher says: "Someone else wrote here. Read it again first." Your words are not written over theirs.

The stamp is the **ETag**. "Only write if the stamp is still X" is **If-Match**. "No, it changed" is **412 Precondition Failed**.

---

## 2. Real name

An **ETag** is an entity tag: an opaque identifier for one representation of a resource (RFC 9110 §8.8.3). A strong ETag changes whenever the representation changes. The server computes one (here: SHA-256 of canonical JSON) and sends it in the `ETag` header.

**Conditional requests** compare validators:

| Header | Meaning here |
| --- | --- |
| `If-Match: "<etag>"` | Apply the write only if the current ETag is exactly this one |
| `If-Match: *` | Apply if the resource exists (any representation) |
| `If-None-Match: "<etag>"` | Read-only: if unchanged, answer `304 Not Modified` (chapter 15) |

The concurrency pattern is **optimistic locking**:

1. Client GETs the resource, receives `ETag` (and `version` in the body for humans).
2. Client sends PUT/PATCH with `If-Match: "<etag>"`.
3. Server compares. Mismatch → `412 Precondition Failed`, nothing written. Match → write, increment `version`, return the new representation and new `ETag`.

This prevents the **lost update**: two editors working from the same snapshot cannot both win silently.

Why both an ETag and a `version` field?

- **ETag is the wire validator.** It changes with any representation change, including ones you did not think to cover with a counter.
- **`version` is domain data.** It is readable, sortable, loggable, and usable in `bulk` payloads (13b) where a header cannot carry 50 values.
- **The client cannot forge either.** `version` is rejected if sent in the body (unknown key, chapter 13a); only the server increments it.

---

## 3. Example

### ETag computation and comparison

```ts
// src/http/cache.ts (excerpt)
export function etagFor(payload: unknown): string {
  const hash = createHash('sha256').update(canonicalJson(payload)).digest('base64url').slice(0, 20);
  return `"${hash}"`; // strong ETag: quoted opaque string
}
```

```ts
// src/routes/helpers.ts (excerpt)
export function expectedVersionFrom(req: Request, current: ProductRecord): number | undefined {
  const header = req.get('if-match');
  if (!header) return undefined; // optional in this tutorial, explained below

  const currentEtag = etagFor(productDto(current));
  const candidates = header.split(',').map((value) => value.trim()).filter(Boolean);
  if (!candidates.includes(currentEtag) && !candidates.includes('*')) {
    throw new HttpProblem(412, 'precondition_failed', 'If-Match does not match the current resource.', {
      headers: { ETag: currentEtag },                 // tell the client the current validator
      extensions: { currentVersion: current.version }, // human-friendly, non-standard member
    });
  }
  return current.version; // pass the expected version into the store
}
```

```ts
// src/routes/products.ts (excerpt)
router.patch('/:productId', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
  const tenantId = tenantIdOf(req);
  const current = await store.findProduct(tenantId, pathParam(req, 'productId'));
  if (!current) throw notFound('Product not found.');
  const expectedVersion = expectedVersionFrom(req, current);
  const input = parseInput(patchProductSchema, req.body);
  const record = await store.patchProduct(tenantId, current.id, input, expectedVersion);
  // ...
  res.set({ ETag: etagFor(dto), 'Cache-Control': 'private, max-age=60' });
  res.status(200).json(dto);
});
```

The store repeats the version check **inside** the write, so another transaction between the read and the write cannot slip in:

```ts
// src/store/prisma.ts (excerpt)
const updated = await this.prisma.product.updateMany({
  where: { id: productId, tenantId, deletedAt: null,
    ...(expectedVersion !== undefined ? { version: expectedVersion } : {}) },
  data,
});
if (updated.count === 0) return this.explainWriteMiss(tenantId, productId, expectedVersion);
```

`explainWriteMiss` distinguishes 404 (row gone) from 412 (version moved) and includes `currentVersion`.

### Read with an ETag

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_acme/products/prd_tee
HTTP/1.1 200 OK
X-Request-Id: be2a8e0a-c55f-49a5-8d06-1bc4b6323939
ETag: "XbeZlWWW1h_Nn0RCRZg5"
Cache-Control: private, max-age=60
Vary: Authorization
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:27:25 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:24.625Z"}
```

### Matching If-Match: write wins, new ETag

```console
$ curl -sS -i --request PATCH http://localhost:4010/api/tenants/ten_acme/products/prd_tee -H 'Content-Type: application/json' -H 'If-Match: "XbeZlWWW1h_Nn0RCRZg5"' --data-binary '{ "priceCents": 2199 }'
HTTP/1.1 200 OK
X-Request-Id: fc6d71b5-e573-4c24-b56c-4fef25a343b6
ETag: "CAZ-hCuHbJuTi9UXCiDn"
Cache-Control: private, max-age=60
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:27:25 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":2199,"currency":"USD","stock":50,"active":true,"version":2,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:25.038Z"}
```

The response carries the **new** ETag, so a client can chain edits without re-reading. A client that ignores it and reuses the old ETag will get 412.

### Reusing the old If-Match: 412, no write

```console
$ curl -sS -i --request PATCH http://localhost:4010/api/tenants/ten_acme/products/prd_tee -H 'Content-Type: application/json' -H 'If-Match: "XbeZlWWW1h_Nn0RCRZg5"' --data-binary '{ "priceCents": 2399 }'
HTTP/1.1 412 Precondition Failed
X-Request-Id: 68127ce4-9257-4cdc-a35c-f4867d47ad1c
ETag: "CAZ-hCuHbJuTi9UXCiDn"
Content-Type: application/problem+json; charset=utf-8
Content-Length: 265
Date: Thu, 29 Oct 2026 12:27:25 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/precondition_failed","title":"Precondition Failed","status":412,"detail":"If-Match does not match the current resource.","instance":"/api/tenants/ten_acme/products/prd_tee","code":"precondition_failed","currentVersion":2}
```

The price is still 2199; the rejected write never reached the store. The `ETag` response header and `currentVersion` extension give the client everything it needs to re-read and retry deliberately.

### If-Match: * — write if it exists

```console
$ curl -sS -i --request PATCH http://localhost:4010/api/tenants/ten_acme/products/prd_tee -H 'Content-Type: application/json' -H 'If-Match: *' --data-binary '{ "stock": 45 }'
HTTP/1.1 200 OK
X-Request-Id: 0c9a5787-2603-4a10-b8bc-1f9f1d8bb5f3
ETag: "AJ7oBtDRb-thQ4rRBA_b"
Cache-Control: private, max-age=60
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:27:25 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":2199,"currency":"USD","stock":45,"active":true,"version":3,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:25.073Z"}
```

`*` is the escape hatch for "I know this resource exists, I do not care which version" — useful for setting a field that is independent of others, dangerous for read-modify-write.

### Version in the body is not accepted

```console
$ curl -sS -i --request PATCH http://localhost:4010/api/tenants/ten_acme/products/prd_tee -H 'Content-Type: application/json' --data-binary '{ "version": 99 }'
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 298c6ccd-5740-4b4a-91be-df4db3149252
Content-Type: application/problem+json; charset=utf-8
Content-Length: 399
Date: Thu, 29 Oct 2026 12:27:25 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products/prd_tee","code":"validation_failed","errors":[{"pointer":"","code":"unrecognized_keys","message":"Unrecognized key: \"version\""},{"pointer":"","code":"custom","message":"Send at least one field to update."}]}
```

If the API allowed `version` in the body, a client could claim any version and defeat the lock. The header is the only validator.

Matching `.http` file: [`requests/13c-concurrency-etags-if-match.http`](../requests/13c-concurrency-etags-if-match.http). Full capture: [`transcripts/13c-concurrency-etags-if-match.txt`](../transcripts/13c-concurrency-etags-if-match.txt).

---

## 4. Bad vs good

**Bad — read, check in application code, then write**

```ts
// DANGER DEMO — DO NOT SHIP
const current = await store.findProduct(tenantId, id);
if (req.body.version !== current.version) throw conflict(...); // check
await store.replaceProduct(tenantId, id, input);               // ...then unconditional write
```

Two requests can both pass the check before either writes; the second overwrites the first. The check and the write must be the same atomic predicate (as `updateMany` does) or inside one serializable transaction.

**Bad — last write wins with no validator**

No `If-Match`, no `version` comparison. This is fine for genuinely independent fields (setting `active` from two places) and catastrophic for read-modify-write (stock, price based on old value, order status transitions).

**Bad — using `If-Match` but returning 200 on mismatch**

A body like `{"ok": false, "reason": "stale"}` with 200 hides the conflict from HTTP tooling, caches, and monitoring. Use 412.

**Good — server-issued validator, atomic predicate, 412 with context**

```ts
const expectedVersion = expectedVersionFrom(req, current); // 412 if stale
const record = await store.patchProduct(tenantId, id, input, expectedVersion); // conditional write
res.set('ETag', etagFor(dto)).json(dto);
```

**Trade-offs:**

- **Optional vs required If-Match.** This tutorial makes it optional so beginners can call PUT/PATCH directly (the comment in `helpers.ts` says so). Production should require it for read-modify-write endpoints, or document that omitting it means "force overwrite". Stripe uses explicit request options (not HTTP conditional headers) for some concurrency; Microsoft's guidelines recommend ETag/If-Match. Decide per resource.
- **Strong vs weak ETag.** Strong (`"..."`) promises byte-for-byte representation identity and can be used for writes and range requests. Weak (`W/"..."`) allows semantically equivalent representations and must not be used for `If-Match` writes. This API uses strong tags.
- **ETag on the DTO vs on a version column.** Hashing the DTO covers every public field automatically and changes on `updatedAt`; a version column is cheaper and more stable but must be maintained on every write path. Using both (this API) gives a reliable validator plus a readable domain counter.
- **412 vs 409.** 412 means "your precondition failed" and is the right status for `If-Match`. 409 means "the request conflicts with current state" (duplicate, quote already applied) and is better for business conflicts. Do not use 409 for stale versions if you advertise ETags.
- **Precondition on a collection (`If-Match` for DELETE).** Deleting a product that has changed since read is often worth guarding too. This course does not implement it; the same helper could.
- **Retry semantics.** A 412 should not be retried blindly; the client must re-read, merge, and decide. Document that; automatic retry loops on 412 can livelock.

---

## 5. In a real multi-tenant e-commerce platform

Two warehouse operators open the same product. Operator A sets stock to 45. Operator B, whose page was loaded a minute earlier, saves stock 50 and a lower price. Without validators, B's save silently erases A's stock change. With `If-Match`, B gets 412, the console refreshes, shows A's change, and B decides to keep 45.

The stock decrement on order creation uses a different, but complementary, mechanism: a conditional `UPDATE ... WHERE stock >= qty` inside a transaction (chapter 12 / `createOrder`). ETags protect human edits; predicates protect counters. Both are optimistic concurrency; neither requires holding a lock while a person thinks.

Tenant isolation is unaffected: the ETag is computed from the tenant-scoped DTO, and the query includes `tenantId`. If a Globex client somehow guesses an Acme ETag, the lookup for that id under Globex returns 404 before any comparison.

---

## 6. When to use it and when NOT to

**Use ETag/If-Match when:**

- Clients do read-modify-write on a shared resource.
- Lost updates are expensive (prices, stock, order status, customer bans).
- You also want conditional GETs and caching (chapter 15).

**When not to:**

- **Independent, commutative field updates** (set `active` true from any state). A blind PATCH is fine; `If-Match` only adds retries.
- **Append-only events.** No update to conflict with.
- **Server-computed transitions** where the server decides validity (order state machine); a domain-level 409 is clearer than a version check.

**Do not** expose `version` as a settable field, and do not accept `If-Match` and ignore it — that is worse than not advertising ETags at all.

---

## 7. Common mistakes

1. **Check-then-write outside a transaction.** The race remains; use a conditional update.
2. **Accepting `version` in the request body.** Clients can forge state; reject unknown keys.
3. **Returning 200 on stale writes.** Use 412 and include the current ETag.
4. **Not returning the new ETag after a write.** Forces an extra GET and invites stale reuse.
5. **Using weak ETags for If-Match.** RFC 9110 forbids weak validators for If-Match.
6. **Hashing only some fields.** The ETag must change when the representation changes; hash the DTO, not a hand-picked subset.
7. **Ignoring `If-Match` lists and `*`.** Parse comma-separated values and support `*`.
8. **412 without context.** Include the current ETag/version so the client can recover.
9. **Automatic retry on 412.** It will loop; the client must re-read and merge.
10. **One validator for nested collections.** The product ETag does not guard `order_items`; scope validators to the resource they represent.
11. **ETags across tenants.** If the hash ignores tenant and the lookup does not, two tenants could compare equal; keep the tenant filter first.
12. **Forgetting `Vary: Authorization`.** In shared caches, a product representation can differ by token; without `Vary`, one client's cached copy can be served to another (chapter 15).

---

## 8. Try it yourself

**Exercise.** The customer ban endpoint (chapter 25d) currently does not use `If-Match`.

1. Add ETag support to `GET /customers/{id}` and make `POST /customers/{id}/ban` require `If-Match` when the customer is already banned or unbanned by someone else. (Think about whether an action endpoint should use `If-Match` on the customer.)
2. What status and body should an admin see if the customer was unbanned two seconds ago and they click "Ban" from a stale screen?
3. Explain why a 412 is better than silently applying the ban again.
4. Write the curl sequence: read with ETag, ban with `If-Match`, then replay the same ban request.

**Hint.** Reuse `expectedVersionFrom` by adapting it to `CustomerRecord`/`customerDto`, or generalize it to any DTO + version. Stale ban → 412 `precondition_failed` with `currentVersion`. Silent re-apply hides the fact that someone else acted and may overwrite a different reason; 412 forces a refresh. The replay with the same ETag will 412 because the first ban already incremented the version — unless the endpoint is designed to treat "already banned" as a no-op 200, which is a valid alternative you should document.

---

## 9. Next

[14. Versioning and deprecation →](14-versioning-deprecation.md)
