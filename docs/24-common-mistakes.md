# 24. Common mistakes

> **Run order:** the mistakes server, port **4013** (`npx tsx scripts/mistakes-server.ts`), **no auth**, deliberately bad. Nothing else needs to be running.
>
> Every request against port 4013 is copied from `transcripts/24-common-mistakes.txt`, captured with `curl` on 2026-10-29. The server log lines at the end of that transcript are pasted with the last request. The one exception is the correctly implemented 404, quoted from `transcripts/22-consistency-and-review.txt` and labeled as such where it appears.

> **DANGER DEMO — DO NOT SHIP.** The code in this chapter ignores tenants, leaks internal fields, and returns errors with `200 OK`. It exists to be reproduced and then fixed. Every one of these bugs was avoided in the real API built in chapters 1–22; the point of this chapter is to recognize them in a diff.

---

## 1. Simple explanation (like I'm 7)

You learn to ride a bike by falling. But you do not want to fall in traffic.

This chapter is a **closed car park** where the same falls happen on purpose: a shop that answers "I don't have it" with a happy face, a shop that gives you other people's parcels, a shop that tells you the secret cost of everything, and a shop that runs to the back room once per item instead of once for the whole list.

Each one takes ten seconds to see here. In production, each one takes weeks to notice and costs money. Your job is not to memorize the fixes — you already built them — but to **see the bug fast** when it appears in a code review.

---

## 2. Real name

The mistakes reproduced here are the recurring failure modes of HTTP APIs. Each has a name and a precise reason it is wrong:

| # | Mistake | Why it is wrong | Where the course fixed it |
| --- | --- | --- | --- |
| 1 | **Verb in the URL** (`/getProducts`) | The method already carries the verb; paths should name resources. Also a parallel universe of endpoints that no client can guess. | ch. 1, 4 |
| 2 | **`200 OK` with an error body** | Status codes are the machine-readable outcome. A `200` tells caches, retries, and monitoring that everything succeeded. | ch. 3, 8a |
| 3 | **Tenant parameter ignored** | The endpoint *looks* tenant-scoped but returns every tenant's rows. Worse than no parameter: it is security theatre. | ch. 11, 17 |
| 4 | **Leaking internal fields** (`internalCost`, `tenantId`) | Serializing the storage row exposes data the client must never see and freezes your schema to your database. | ch. 10 |
| 5 | **Float money** (`19.99`) | Binary floating point cannot represent most decimal amounts; sums drift. Use integer minor units. | ch. 7 |
| 6 | **Auto-increment IDs** (`1`, `2`, `3`) | Enumerable: a client can walk your entire catalog or guess other tenants' rows. | ch. 7 |
| 7 | **N+1 queries** | One query for the list plus one per row. Cost grows with page size and hides until the table is big. | this chapter, ch. 18 |
| 8 | **Framework fingerprint** (`X-Powered-By`) | Advertising the stack helps attackers pick exploits. Cheap to remove. | ch. 10 |
| 9 | **No statement of the contract** | No documented error shape, no pagination, no ETag semantics; every client invents its own. | ch. 21, 22 |

The chapter's method is the same as a doctor's: **symptom → diagnosis → the specific line that causes it → the fix already present in the real code**.

---

## 3. Example

### The whole server

It is one file, and almost every route contains a bug on purpose:

```ts
// scripts/mistakes-server.ts — DANGER DEMO ONLY
const products = [
  { id: 1, tenantId: 'ten_acme', name: 'Classic T-Shirt', price: 19.99, internalCost: 7.1 },
  { id: 2, tenantId: 'ten_acme', name: 'Camp Mug', price: 12.99, internalCost: 4.2 },
  { id: 3, tenantId: 'ten_globex', name: 'EU Camp Mug', price: 11.99, internalCost: 3.9 },
];

app.get('/getProducts', (_req, res) => {
  res.status(200).json({ success: false, error: 'Use /products instead', data: null });
});

app.get('/products', (_req, res) => {
  // BUG: ignores tenant entirely and returns every tenant's rows.
  res.json(products);
});
```

Two bugs in nine lines. The first returns an error with `200`; the second accepts no tenant at all and serializes the raw rows.

### Mistake 1 + 2: a verb URL and an error with `200`

```console
$ curl -sS -i --request GET http://localhost:4013/getProducts
```

```http
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 61
ETag: W/"3d-xtcM8R+WMJKDR6iA3GBOirY1ZxQ"
Date: Thu, 29 Oct 2026 12:29:56 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"success":false,"error":"Use /products instead","data":null}
```

Read the status line and the body together: `200 OK` says "success", the body says `success:false` and an error message. A client that checks `res.ok`, a retry library, a cache, or a dashboard counting 5xx will all conclude the request worked.

The fix is not "return the error in a better error envelope". It is:

- name the path after the resource (`/products`; this is a collection),
- use the status code that describes the outcome,
- and if the body is an error, use `application/problem+json` from chapter 8.

The same problem, fixed, exists in this project. This capture is from chapter 22, not from the mistakes server:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/products/prd_missing -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 404 Not Found
X-Request-Id: 6aad89d8-1b3e-4b1c-ad16-30be9106332e
Content-Type: application/problem+json; charset=utf-8
Content-Length: 192
Date: Thu, 29 Oct 2026 12:29:29 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"Product not found.","instance":"/v1/tenants/ten_acme/products/prd_missing","code":"not_found"}
```

(Transcript 22.)

### Mistake 3: the tenant parameter is a lie

The request even *sends* a tenant. It is ignored.

```console
$ curl -sS -i --request GET http://localhost:4013/products?tenantId=ten_acme
```

```http
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 259
ETag: W/"103-0uWgNfvGPIjFzwK2Z29NxwWS9hY"
Date: Thu, 29 Oct 2026 12:29:56 GMT
Connection: keep-alive
Keep-Alive: timeout=5

[{"id":1,"tenantId":"ten_acme","name":"Classic T-Shirt","price":19.99,"internalCost":7.1},{"id":2,"tenantId":"ten_acme","name":"Camp Mug","price":12.99,"internalCost":4.2},{"id":3,"tenantId":"ten_globex","name":"EU Camp Mug","price":11.99,"internalCost":3.9}]
```

The response contains `ten_globex`'s row. The `tenantId` query parameter appears in the URL, so the endpoint *looks* scoped, but `_req` is unused — the handler never reads it. This is the most dangerous mistake in the file: a reviewer scanning for "is tenant mentioned?" sees the parameter and moves on.

Why this happens in real code: the tenant is validated in middleware or read from a request field, but the store call was never updated. The correct pattern from chapter 22 is one source:

```ts
// src/routes/customers.ts (the real API)
const tenantId = tenantIdOf(req);          // from the token-verified context
const result = await store.listCustomers(tenantId, { ... });  // passed into every query
```

Chapter 17 adds the second half: if the path tenant and the token tenant differ, `403` before any read. A query parameter would never be trusted for this at all — a client can change it.

### Mistake 4 + 5 + 6: raw rows, floats, and enumerable IDs

```console
$ curl -sS -i --request GET http://localhost:4013/products/3
```

```http
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 86
ETag: W/"56-c6PZg50018pUQs1kDm198F8Xad8"
Date: Thu, 29 Oct 2026 12:29:56 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":3,"tenantId":"ten_globex","name":"EU Camp Mug","price":11.99,"internalCost":3.9}
```

Four bugs in one 86-byte body:

- `internalCost` is the wholesale cost. A competitor now knows the margin.
- `tenantId` is an internal key. It also leaks the tenant naming scheme.
- `price: 11.99` is a float. `0.1 + 0.2` problems start the moment anyone sums two of these.
- `id: 3` is sequential and the route has no tenant and no auth: incrementing the number walks every tenant's catalog.

The real API's counterpart, from chapter 25a:

```json
{"id":"prd_3ea85111-2f71-4299-a0d2-62cc5baf48e6","sku":"GLOV-001","slug":"globex-gloves","name":"Globex Gloves","description":null,"priceCents":2799,"currency":"EUR","stock":5,"active":true,"version":1,"createdAt":"2026-10-29T12:30:02.870Z","updatedAt":"2026-10-29T12:30:02.870Z"}
```

Opaque prefixed ID, integer minor units, explicit currency, and the DTO whitelist from chapter 10 (`productDto`) is the only serializer — adding a secret column to the table cannot leak it.

### Mistake 2 again: `200` for a missing order

```console
$ curl -sS -i --request GET http://localhost:4013/orders/999
```

```http
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 40
ETag: W/"28-dvpaUTn8yKT+vtZUUpRLFWoHMiE"
Date: Thu, 29 Oct 2026 12:29:56 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"ok":false,"message":"Order not found"}
```

The status is `200`, so:

- a retry middleware treats the call as complete and never retries,
- a monitoring dashboard sees no errors,
- a client that checks status before parsing sees success and then crashes on `.id`,
- a CDN may cache "not found" as if it were a valid order, because `200` responses are cacheable by default.

The real API returns `404` with a problem body. Chapter 3's rule: the status line is the contract; the body is detail.

### Mistake 7: N+1 in the open

```console
$ curl -sS -i --request GET http://localhost:4013/products-n-plus-one
```

```http
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 329
ETag: W/"149-UiXbyS+AhYHAv0m6DEgdiFdIeNw"
Date: Thu, 29 Oct 2026 12:29:56 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"rows":[{"id":1,"tenantId":"ten_acme","name":"Classic T-Shirt","price":19.99,"internalCost":7.1,"stock":11},{"id":2,"tenantId":"ten_acme","name":"Camp Mug","price":12.99,"internalCost":4.2,"stock":12},{"id":3,"tenantId":"ten_globex","name":"EU Camp Mug","price":11.99,"internalCost":3.9,"stock":13}],"simulatedQueries":3,"ms":0}
```

The server log while that request ran:

```console
mistakes server (DANGER DEMO) listening on http://localhost:4013
SELECT * FROM inventory WHERE product_id = 1
SELECT * FROM inventory WHERE product_id = 2
SELECT * FROM inventory WHERE product_id = 3
```

Three rows, three queries. With `limit=100` it is 101 queries; with the default page size of the real API it is 21. Each round trip is sub-millisecond locally, so `ms: 0` — which is exactly why this bug survives development and shows up when the database is remote and the page is full.

The real API does it in one query, plus one `COUNT` only when the client asks for a total — neither depends on page size:

```ts
// src/store/prisma.ts (shape, simplified)
const rows = await prisma.product.findMany({ where: { tenantId, deletedAt: null }, take: limit + 1 });
// one query for the page; no per-row follow-up → no N+1
```

`take: limit + 1` is the cursor trick from chapter 6b: fetch one extra row to compute `hasMore` without a `COUNT`.

### Mistake 8: the fingerprint

Every response above carries `X-Powered-By: Express`, and Express added a weak `ETag` even to the error body. The real API disables both:

```ts
// src/app.ts (excerpt)
app.disable('x-powered-by');
app.set('etag', false);
```

Neither is a vulnerability by itself — the point is that response headers are part of your surface, and defaults are not decisions.

---

## 4. Bad vs good

The whole chapter in one comparison:

```ts
// BAD — scripts/mistakes-server.ts
app.get('/getProducts', (_req, res) => {
  res.status(200).json({ success: false, error: 'Use /products instead', data: null });
});

app.get('/products', (_req, res) => {
  res.json(products);                       // every tenant, raw rows
});

app.get('/products/:id', (req, res) => {
  const product = products.find((row) => String(row.id) === req.params.id);
  if (!product) {
    res.status(200).json({ success: false, error: 'not found' });
    return;
  }
  res.json(product);                        // leaks tenantId + internalCost, float price
});

app.get('/orders/:id', (_req, res) => {
  res.status(200).json({ ok: false, message: 'Order not found' });
});
```

```ts
// GOOD — src/routes/products.ts (excerpt, real API)
router.get('/', async (req, res) => {
  const tenantId = tenantIdOf(req);                       // verified tenant, from auth
  const query = parseInput(productListQuerySchema, req.query);
  assertPaginationMode(query);
  const result = await store.listProducts(tenantId, { ...query });
  noStore(res);
  res.status(200).json({
    data: result.items.map((product) => productDto(product)),   // whitelisted DTO
    pagination: pageMeta(result, { ...query }),
  });
});

router.get('/:productId', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const product = await store.findProduct(tenantId, pathParam(req, 'productId'));
  if (!product) throw notFound('Product not found.');     // 404 + problem+json
  sendCacheable(req, res, productDto(product));           // ETag + Cache-Control
});
```

Every line in the good version corresponds to a chapter: tenant scope (11/17), validation (9), pagination (6a/6b), DTO (10), errors (8a), caching (15).

**Bad** is not the same as *unfinished*. The mistake server is internally consistent — it works, tests pass, the JSON parses. It is bad because it violates the contract the rest of the system depends on: HTTP semantics, tenant isolation, and schema control.

---

## 5. In a real multi-tenant e-commerce platform

Imagine the mistake server is deployed behind a shared gateway for two shops, Acme and Globex.

- A Globex developer calls `/products` to fill a dropdown and gets Acme's catalog, including wholesale costs. That is a commercial data breach caused by one unused `_req`.
- A nightly reconciliation job calls `/orders/999` for every order ID it thinks exists. Every response is `200`, so the job reports "0% failures" while 40% of its lookups silently returned `{"ok":false}`.
- A price comparison partner calls `/products/3` for each of the 5,000 IDs from the seed. Sequential integers make that trivial. Opaque IDs make it a random guess.
- Marketing exports a 1,000-row list and the endpoint issues 1,001 queries. The database is at 60% CPU for an export that reads 50 KB.

None of these is exotic. Each is the default outcome when a route is written quickly: serialize what you have, return `200` because it did not throw, accept whatever parameter is in the URL, and loop in the handler. The course API's countermeasures are all small, local decisions — which is the real lesson: **good API design is mostly a set of small, boring defaults applied every single time.**

---

## 6. When to use it and when NOT

**Use this chapter:**

- As a review checklist supplement: when a diff adds a route, ask which of these nine mistakes it could contain.
- As a teaching tool: running the mistakes server and calling it yourself makes the failure visible in seconds.
- As a regression test: a contract test suite from chapter 21 can assert these never appear in the real API (no `200` on error paths, no `internalCost` in any schema, no unprefixed IDs).

**Do not:**

- Copy anything from `scripts/mistakes-server.ts`. It is fenced as a danger demo for a reason.
- Treat "it returns 200" as proof the endpoint works; treat "it returns the right status, body, and headers" as proof.
- Use a mistake catalog as a substitute for the checklist in chapter 26. The catalog explains *why*; the checklist makes you check *before*.

---

## 7. Common mistakes

These are the same nine, with the specific symptom a reviewer should look for:

1. **Verb URLs.** Any path starting with `get`, `create`, `update`, `delete`, `fetch`, or `list` — or an RPC name as the last segment where a resource should be. Symptom: `/getProducts`.
2. **`200` with an error body.** Symptom: `success: false`, `ok: false`, `error:` inside a `200`; or a `message` field on a success schema that clients must branch on.
3. **Ignored tenant.** Symptom: a `tenantId` in the URL or query that never reaches the store call; a response containing a foreign tenant's row; `where: {}` in a query.
4. **Internal leakage.** Symptom: response DTOs produced by spreading the ORM row (`{ ...product }`), `internalCost`, `tenantId`, password hashes, or raw enum values not in the public schema.
5. **Float money.** Symptom: `price: 19.99`, division by 100 anywhere in a serializer, `toFixed` on the way out.
6. **Enumerable IDs.** Symptom: `id: 1` or `/products/3`; no prefix; IDs exposed in `Location` without a type.
7. **N+1.** Symptom: a query inside a `.map()` over list rows; `simulatedQueries` growing with page size; logs with one `SELECT` per item.
8. **Framework fingerprint and unintended headers.** Symptom: `X-Powered-By`, default `ETag`s on error responses, stack traces in `detail`.
9. **No contract.** Symptom: no OpenAPI document, no shared error shape, no pagination convention — every client writes its own parser.

**The pattern behind all of them:** each is a *local* shortcut with a *global* consequence. That is why review must look at the surface, not only the handler.

---

## 8. Try it yourself

Start the mistakes server and fix three of the bugs without breaking the others.

1. Run `npx tsx scripts/mistakes-server.ts` and reproduce the five requests above.
2. Fix `/orders/:id` so it returns `404` with an `application/problem+json` body shaped like the real API's (`type`, `title`, `status`, `detail`, `instance`, `code`).
3. Fix `/products` so it filters by a tenant — take it from the path (`/tenants/:tenantId/products`) rather than a query parameter, and return `404`-or-empty rather than leaking another tenant's rows. Note in your answer why a query parameter is still wrong even when it is honored.
4. Fix `/products/:id` so it returns a whitelisted DTO (no `internalCost`, no `tenantId`), an integer `priceCents` with `currency`, and a prefixed opaque ID. You may keep the in-memory array; only the output shape matters.

**Hint:** the real `scripts/mistakes-server.ts` is nine lines per route. For step 2, copy the exact member names from transcript 22's 404 body — `status`, `instance`, `code` are easy to forget. For step 3, `products.filter((p) => p.tenantId === req.params.tenantId)` is the one-line fix; the interesting part of the answer is that a *client-supplied* tenant without an auth check is an authorization hole, which is why chapter 17 derives the tenant from the token and compares it to the path. For step 4, map to `{ id: \`prd_${p.id}\`, name, priceCents: Math.round(p.price * 100), currency: 'USD' }` and delete `internalCost` — then notice that `Math.round` is the only safe place to touch a float, and only at the boundary.

---

## 9. Next

The last part of the course are the five production patterns that combine the chapters: products CRUD, order creation with an idempotency key, customer search with cursors, fraud ban/unban, and coupon application.

Next: [25a. Pattern: multi-tenant products CRUD](25a-pattern-products-crud.md)
