# 15. Caching and conditional requests

> **Run order:** Prisma server, port 4010, auth off, **cache on**, deprecation headers off.
>
> Every request below is copied from `transcripts/15-caching-conditional-requests.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

You ask the librarian for page 12 of a book. She photocopies it for you and writes a small number on the corner: "copy 7".

Next day you ask again. She checks the number: "copy 7 is still the current copy." She does not photocopy anything; she just says: "It has not changed, keep the one you have." That is a **304**.

But some pages are secret, per-student notes. The librarian never leaves those on the shared front desk where another student could pick them up. That is **`private`**, and why the note cabinet says who may read it.

---

## 2. Real name

**Caching** stores a response so a later request can be answered without recomputing it. HTTP caching is negotiated with headers; it is not something the server does in isolation.

Key headers (RFC 9111):

| Header | Meaning |
| --- | --- |
| `Cache-Control: private, max-age=60` | Only the client's private cache may store it, for 60 seconds |
| `Cache-Control: no-store` | Do not store at all |
| `Cache-Control: public, s-maxage=300` | Shared caches (CDN) may store it for 300 seconds |
| `ETag` | Validator for conditional requests |
| `If-None-Match` | "Send the body only if it is not this validator" |
| `304 Not Modified` | No body; reuse your copy |
| `Vary: Authorization` | The cached response is keyed by the `Authorization` header |

The two mechanisms are complementary:

- **Freshness** (`max-age`) answers without contacting the server.
- **Validation** (`ETag`/`If-None-Match`) contacts the server but transfers no body when unchanged.

Rules this chapter establishes:

1. **Single resources are cacheable** with a strong ETag and `private, max-age=60`.
2. **Collections are `no-store`** here: query parameters, tenant scope, and personalized fields make shared caching dangerous and low-value (chapter 05a/06).
3. **`Vary: Authorization` is mandatory** when responses depend on the token. Two tokens can see different data; a shared cache that ignores the header could serve one tenant's product to another.
4. **304 carries headers, not a body.** It is not an error; it is a successful reuse.
5. **Writes invalidate via the validator.** The next GET computes a new ETag from the new representation, so old validators stop matching. There is no separate purge step in this in-process design.
6. **Do not cache errors.** The problem documents have no cache headers and `no-store` semantics by default (Express does not add caching to them).

---

## 3. Example

### The single-resource cache helper

```ts
// src/http/cache.ts (excerpt)
export function sendCacheable(req: Request, res: Response, payload: unknown): void {
  if (!config.cacheEnabled) {
    res.status(200).json(payload);
    return;
  }

  const etag = etagFor(payload);
  res.set({
    ETag: etag,
    'Cache-Control': 'private, max-age=60',
    Vary: 'Authorization',
  });

  const candidates = (req.get('if-none-match') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (candidates.includes(etag) || candidates.includes('*')) {
    res.status(304).end();    // no body
    return;
  }

  res.status(200).json(payload);
}
```

### Collections opt out

```ts
// src/http/cache.ts (excerpt)
export function noStore(res: Response): void {
  if (config.cacheEnabled) res.set('Cache-Control', 'private, no-store');
}
```

```ts
// src/routes/products.ts (excerpt)
router.get('/', async (req, res) => {
  // ... parse query, fetch page ...
  noStore(res);
  res.status(200).json({ data: ..., pagination: ... });
});
```

A cursor in a cached collection would pin a client to an old view; `fields=` and `q=` create a huge key space; and listing is exactly where stale data hurts (a price or stock change must show up). Correctness beats a saved round trip.

### First GET: full body, validator, cache policy

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_acme/products/prd_tee
HTTP/1.1 200 OK
X-Request-Id: d23e89ab-5f22-4117-ae91-705c2e05368d
ETag: "AJ7oBtDRb-thQ4rRBA_b"
Cache-Control: private, max-age=60
Vary: Authorization
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:27:52 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":2199,"currency":"USD","stock":45,"active":true,"version":3,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:25.073Z"}
```

### Conditional GET: 304, no body

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_acme/products/prd_tee -H 'If-None-Match: "AJ7oBtDRb-thQ4rRBA_b"'
HTTP/1.1 304 Not Modified
X-Request-Id: e90bbb85-bf7b-4d9a-a609-f2f91db3cf94
ETag: "AJ7oBtDRb-thQ4rRBA_b"
Cache-Control: private, max-age=60
Vary: Authorization
Date: Thu, 29 Oct 2026 12:27:52 GMT
Connection: keep-alive
Keep-Alive: timeout=5
```

No `Content-Type`, no `Content-Length`, no body. The `ETag` is repeated so the client can refresh its freshness lifetime; `Content-Length` is absent by design.

### Collections: no-store

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_acme/products\?limit=2
HTTP/1.1 200 OK
X-Request-Id: 692e0a9c-7c60-4e32-a58e-5ac17a84897e
Cache-Control: private, no-store
Content-Type: application/json; charset=utf-8
Content-Length: 668
Date: Thu, 29 Oct 2026 12:27:52 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","sku":"CAP-001","slug":"running-cap","name":"Running Cap","description":"Lightweight cap.","priceCents":2499,"currency":"USD","stock":0,"active":false,"version":1,"createdAt":"2026-01-01T12:00:00.000Z","updatedAt":"2026-10-29T12:27:24.625Z"},{"id":"prd_hoodie","sku":"HOO-001","slug":"trail-hoodie","name":"Trail Hoodie","description":"Fleece-lined hoodie.","priceCents":4999,"currency":"USD","stock":8,"active":true,"version":1,"createdAt":"2026-01-01T11:00:00.000Z","updatedAt":"2026-10-29T12:27:24.625Z"}],"pagination":{"limit":2,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDExOjAwOjAwLjAwMFoiLCJpZCI6InByZF9ob29kaWUifQ"}}
```

### Tenant-scoped resources cache independently

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_globex/products/prd_eu_mug
HTTP/1.1 200 OK
X-Request-Id: d36bd3d3-959d-4efd-a531-b027f6ae2df6
ETag: "ajeVTymtRYiiXtiDqYdp"
Cache-Control: private, max-age=60
Vary: Authorization
Content-Type: application/json; charset=utf-8
Content-Length: 251
Date: Thu, 29 Oct 2026 12:27:52 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_eu_mug","sku":"MUG-EU","slug":"eu-mug","name":"EU Camp Mug","description":"Euro edition.","priceCents":1199,"currency":"EUR","stock":40,"active":true,"version":1,"createdAt":"2026-01-01T13:00:00.000Z","updatedAt":"2026-10-29T12:27:24.625Z"}
```

### Authorization changes, cache key changes

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_acme/products/prd_tee -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 200 OK
X-Request-Id: 96ec2946-f173-452c-8bbc-b29e44b15ace
ETag: "AJ7oBtDRb-thQ4rRBA_b"
Cache-Control: private, max-age=60
Vary: Authorization
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:27:52 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":2199,"currency":"USD","stock":45,"active":true,"version":3,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:25.073Z"}
```

With auth enabled (chapter 17), the same URL returns data only for the token's tenant. `Vary: Authorization` tells caches that the token is part of the cache key; without it, a CDN could serve Acme's cached response to Globex. `private` additionally forbids shared caches from storing it at all. Both are present because "private + Vary" is the safe default for authenticated APIs.

Matching `.http` file: [`requests/15-caching-conditional-requests.http`](../requests/15-caching-conditional-requests.http). Full capture: [`transcripts/15-caching-conditional-requests.txt`](../transcripts/15-caching-conditional-requests.txt).

---

## 4. Bad vs good

**Bad — `Cache-Control: public, max-age=3600` on authenticated resources**

```ts
// DANGER DEMO — DO NOT SHIP
res.set('Cache-Control', 'public, max-age=3600');
res.json(productDto(product));
```

A shared proxy or CDN can store Acme's product and serve it for any URL match. Tenant data leaks for an hour; `Vary` is missing, so the token is not part of the key.

**Bad — caching a collection without varying on the query**

`GET /products?active=true` and `GET /products?active=false` share a URL path. Without `Vary` on the query (which HTTP caches do not use — the query is part of the cache key, but the response still depends on `Authorization` and on user-specific projection), a stale or wrong page is served. This is why collections here are `no-store`.

**Bad — no validator, `no-cache` only**

`Cache-Control: no-cache` means "revalidate before use" but without an `ETag` there is nothing to revalidate against; every request transfers the full body. Use `no-cache` only with validators.

**Bad — caching errors or 5xx**

A transient 500 cached for 60 seconds turns a blip into an outage. Do not cache 5xx; `no-store` on problem responses if your stack adds caching by default.

**Good — private, short-lived, validated**

```ts
res.set({ ETag, 'Cache-Control': 'private, max-age=60', Vary: 'Authorization' });
```

**Good — 304 on match**

```ts
if (matchesIfNoneMatch(req, etag)) return res.status(304).end();
```

**Trade-offs:**

- **`max-age` vs `no-cache` + ETag.** `max-age` saves the request entirely but can serve stale data for the window; `no-cache` always validates, saving bandwidth but not round trips. Prices and stock usually want a short `max-age` (or `no-cache`); catalogs can be longer.
- **`private` vs `public`.** `public` enables CDN offload but requires the representation to be identical for all users and not sensitive. For a multi-tenant API, most authenticated responses are `private`; truly public catalog endpoints can be `public, s-maxage=...` with no `Authorization` dependency.
- **ETag vs `Last-Modified`.** `Last-Modified` is coarse (seconds) and ambiguous when clocks or batch jobs are involved. ETags are exact; use `Last-Modified` only for static assets where it is free.
- **Strong vs weak ETags.** Strong tags are exact bytes/representation and safe for `If-Match`; weak tags allow semantically equivalent content and are read-only. This API's ETags are strong.
- **Invalidation by validator vs purge.** Recomputing the ETag from the representation makes invalidation automatic for clients that revalidate; CDNs still need a purge or a short TTL. A write does not proactively delete cached copies — the next validation sees the new tag.
- **`stale-while-revalidate`.** Lets a cache serve stale content while refreshing in the background: great for catalogs, wrong for stock. Use deliberately with `s-maxage`.
- **Caching collections.** Some APIs allow `Cache-Control: private, max-age=10` for stable filters. It works if the query is fully represented in the URL and `Vary` covers auth; the risk is staleness on the first page of a fast-changing catalog. This course chooses safety.

---

## 5. In a real multi-tenant e-commerce platform

The storefront's product page is read thousands of times per minute. Each response is `private, max-age=60`, so a shopper's browser reuses it without a request for a minute; when it expires, it sends `If-None-Match`, and if nothing changed the server returns 304 with no body. The product detail endpoint does one row read either way; the saving is bandwidth and JSON parsing on the client.

The CDN does **not** cache these responses, because `private` forbids it. If the platform wants CDN offload for the public catalog, it adds a separate unauthenticated surface with `public, s-maxage=30, stale-while-revalidate=60` and tenant-in-path URLs. Mixing the two on the same URL is how tenant leaks happen.

A price update changes `updatedAt` and the DTO, which changes the ETag. Any client still holding the old tag gets 200 with the new price on its next revalidation; no purge call is required. A support console that cached the old price for 60 seconds sees the change within a minute — the documented freshness bound.

Collections stay `no-store`: an admin filtering by `active=false` must not see a cached list from another filter or another tenant, and cursor pages must not be pinned to a stale snapshot.

---

## 6. When to use it and when NOT to

**Use HTTP caching when:**

- The resource is read often and changes less often.
- The response is safe to reuse for a known short window.
- Bandwidth or latency matters (mobile, large payloads).
- You control cache headers and can test them.

**When not to:**

- **Money or inventory mutations**: a stale stock number can cause a bad purchase. Use very short freshness or `no-store`.
- **Per-user dashboards with mixed permissions**: complexity outweighs the gain; `no-store` is safer.
- **Responses containing secrets** or one-time data (tokens, signed URLs).
- **Collections with high-cardinality query parameters** until you can prove the cache key is complete.

**Do not** use application-level memoization as a substitute for HTTP caching when the client is external; the client cannot see your in-process cache, and it will not invalidate.

---

## 7. Common mistakes

1. **`public` on authenticated data.** One missing `private` can leak a tenant.
2. **Missing `Vary: Authorization`.** Shared caches key only on URL and can mix users.
3. **Caching a 304 with a body.** 304 must have no body; some frameworks add one if you call `json()`.
4. **Forgetting `ETag` on 304.** Clients need the validator to refresh their stored copy.
5. **Caching errors.** 5xx and 429 must not be stored; a cached 429 makes a blip last.
6. **ETag that ignores fields.** If the tag is computed from `id` only, price changes are invisible and clients keep stale data forever.
7. **`no-cache` without a validator.** Forces full transfers with no benefit.
8. **`max-age` too long on volatile data.** A 1-hour stock cache is a bug report generator.
9. **Caching `POST`, `PATCH`, `DELETE` responses with GET rules.** Writes are not cacheable by default; do not opt in.
10. **Ignoring `Vary` on `Accept`/`Accept-Encoding`.** JSON vs CSV or gzip vs identity need separate entries. Express's compression middleware handles the encoding part; content negotiation needs `Vary: Accept` if you support several media types.
11. **Different ETag formats across endpoints.** One helper, one format; clients compare exact strings.
12. **Not documenting freshness.** Clients need to know a 60-second window exists; otherwise support tickets say "the API is wrong" when it is merely cached.
13. **Relying on `Date`/`Last-Modified` for invalidation.** Use validators; clocks drift.

---

## 8. Try it yourself

**Exercise.** The public catalog endpoint `GET /v1/public/products/{id}` (no auth, not in this codebase) is added for the storefront.

1. Which cache headers would you send, and why not `private`?
2. What must be true about the representation for `public` to be safe?
3. A merchant changes a price. How quickly must the CDN show it? Which directive expresses that?
4. The same product is also served under `/v1/tenants/{tenantId}/products/{id}` with auth. Should the two URLs share a cache entry? Why or why not?
5. Write the `curl -i` that proves a conditional request returns 304 for the public endpoint.

**Hint.** `public, s-maxage=30, stale-while-revalidate=60` with a strong ETag. `public` is safe only if the response is identical for every caller and contains no tenant-private data. Price latency ≤ 30 seconds via `s-maxage`. The authenticated URL has a different cache key and `private`; sharing entries would leak. `curl -i -H 'If-None-Match: "<etag>"'` should return 304 with an empty body and the same ETag.

---

## 9. Next

[16. Rate limiting →](16-rate-limiting.md)
