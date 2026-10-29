# 02. HTTP methods: safe, idempotent, and when to use each

> **Run order:** in-memory server, port 4011, auth off.
>
> Every request below is copied from `transcripts/02-http-methods.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

Think of a shared notebook on the classroom table.

- **Looking at a page** does not change the notebook. You could look 10 times and the notebook is the same. That is **safe**.
- **Writing your name in the notebook** 10 times leaves your name written once (if the rule is "put your name in the name box"). Doing it again does not add a second name. That is called **idempotent**.
- **Adding a new sticker** to the sticker page is different: do it 10 times and you get 10 stickers. That is **not idempotent**.
- **Erasing a page** 10 times leaves the page erased. Doing it twice is harmless — also idempotent.

HTTP has exactly this kind of vocabulary. The method is a promise about what repeating the request does.

---

## 2. Real name

From [RFC 9110 §9](https://www.rfc-editor.org/rfc/rfc9110.html#name-methods):

| Method | Safe | Idempotent | Typical use |
|---|---|---|---|
| `GET` | yes | yes | Read a resource or collection. No body semantics. |
| `HEAD` | yes | yes | Same as `GET` but without a body. |
| `OPTIONS` | yes | yes | Discover allowed methods / CORS preflight. |
| `POST` | no | **no** | Create in a collection, or run a non-idempotent action. |
| `PUT` | no | **yes** | Replace the resource at a known URL. |
| `PATCH` | no | **not guaranteed** | Partial update (chapter 13a). |
| `DELETE` | no | **yes** | Remove a resource. |

Definitions:

- **Safe** — the client did not request a state change. Safe methods may still log, count metrics, or cost money in infrastructure, but they must not change the target resource in a way the client asked for.
- **Idempotent** — repeating the request has the same *effect on server state* as sending it once. The *response* may differ (the first `DELETE` returns `204`, the second may return `404`); idempotency is about state, not bytes.
- **Cacheable** — `GET`/`HEAD` responses may be stored by caches; the response headers decide (chapter 15).

`POST` is the odd one out. That is why the whole of chapter 12 exists: when a client must send a `POST` that creates an order, the client and server cooperate so a retry does not create a duplicate. The method alone cannot give you that guarantee.

---

## 3. Example

### Route table for the product resource

```ts
// src/routes/products.ts (excerpt)
router.get('/', ...)                                  // GET    /products
router.post('/', requireRole('ADMIN', ...), ...)      // POST   /products
router.get('/:productId', ...)                        // GET    /products/:id
router.put('/:productId', ...)                        // PUT    /products/:id
router.patch('/:productId', ...)                      // PATCH  /products/:id
router.delete('/:productId', ...)                     // DELETE /products/:id
```

The comments on the create handler in this chapter matter:

```ts
router.post('/', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
  const tenantId = tenantIdOf(req);
  const input = parseInput(createProductSchema, req.body); // validated body, chapter 09
  const record = await store.createProduct(tenantId, input); // server generates the ID
  const dto = productDto(record);                            // whitelisted output, chapter 10
  noStore(res);
  res.status(201).location(`${req.baseUrl}/${record.id}`).json(dto); // 201 + Location, chapter 03
});
```

### 1. `GET` a collection

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=2
HTTP/1.1 200 OK
X-Request-Id: 53703534-f549-478f-a992-da30df345174
Content-Type: application/json; charset=utf-8
Content-Length: 668
Date: Thu, 29 Oct 2026 12:25:32 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","sku":"CAP-001","slug":"running-cap","name":"Running Cap","description":"Lightweight cap.","priceCents":2499,"currency":"USD","stock":0,"active":false,"version":1,"createdAt":"2026-01-01T12:00:00.000Z","updatedAt":"2026-01-01T12:00:00.000Z"},{"id":"prd_hoodie","sku":"HOO-001","slug":"trail-hoodie","name":"Trail Hoodie","description":"Fleece-lined hoodie.","priceCents":4999,"currency":"USD","stock":8,"active":true,"version":1,"createdAt":"2026-01-01T11:00:00.000Z","updatedAt":"2026-01-01T11:00:00.000Z"}],"pagination":{"limit":2,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDExOjAwOjAwLjAwMFoiLCJpZCI6InByZF9ob29kaWUifQ"}}
```

### 2. `POST` to create

The client does not choose the ID. The server owns identity.

```console
$ curl -sS -i --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Content-Type: application/json' --data-binary '{
  "sku": "BAG-001",
  "slug": "day-pack",
  "name": "Day Pack",
  "description": "20 litre pack.",
  "priceCents": 5999,
  "currency": "USD",
  "stock": 15,
  "active": true
}'
HTTP/1.1 201 Created
X-Request-Id: 70b104e1-2fd7-4ef4-a1e1-15f430d1dbf4
Cache-Control: no-store
Location: /api/tenants/ten_acme/products/prd_c37b611b-6528-4477-b725-ae99f82a4a0f
Content-Type: application/json; charset=utf-8
Content-Length: 282
Date: Thu, 29 Oct 2026 12:25:32 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_c37b611b-6528-4477-b725-ae99f82a4a0f","sku":"BAG-001","slug":"day-pack","name":"Day Pack","description":"20 litre pack.","priceCents":5999,"currency":"USD","stock":15,"active":true,"version":1,"createdAt":"2026-10-29T12:25:32.397Z","updatedAt":"2026-10-29T12:25:32.397Z"}
```

`Location` tells the client where the new resource lives. The body is the created representation. `201` is discussed properly in chapter 03.

### 3. `GET` the new resource

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_c37b611b-6528-4477-b725-ae99f82a4a0f
HTTP/1.1 200 OK
X-Request-Id: 14e79ec8-7469-4361-9c44-d9386c4ea38d
Content-Type: application/json; charset=utf-8
Content-Length: 282
Date: Thu, 29 Oct 2026 12:25:32 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_c37b611b-6528-4477-b725-ae99f82a4a0f","sku":"BAG-001","slug":"day-pack","name":"Day Pack","description":"20 litre pack.","priceCents":5999,"currency":"USD","stock":15,"active":true,"version":1,"createdAt":"2026-10-29T12:25:32.397Z","updatedAt":"2026-10-29T12:25:32.397Z"}
```

### 4. `DELETE`

```console
$ curl -sS -i --request DELETE http://localhost:4011/api/tenants/ten_acme/products/prd_c37b611b-6528-4477-b725-ae99f82a4a0f
HTTP/1.1 204 No Content
X-Request-Id: 5cf91566-9c56-424f-9a28-fc3171e82356
Date: Thu, 29 Oct 2026 12:25:32 GMT
Connection: keep-alive
Keep-Alive: timeout=5
```

No body. `204` says "done, and there is nothing to tell you" — the right code when there is no representation to return.

### 5. Repeat the `GET`: `404`, and that is correct

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_c37b611b-6528-4477-b725-ae99f82a4a0f
HTTP/1.1 404 Not Found
X-Request-Id: 338f999c-f165-404a-944e-e16bd8dcfdd6
Content-Type: application/problem+json; charset=utf-8
Content-Length: 222
Date: Thu, 29 Oct 2026 12:25:32 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"Product not found.","instance":"/api/tenants/ten_acme/products/prd_c37b611b-6528-4477-b725-ae99f82a4a0f","code":"not_found"}
```

If the same `DELETE` were replayed, it would also return `404`. The *effect* (product absent) is unchanged, so `DELETE` is idempotent even though the response differs. Clients must not treat "second delete returned 404" as a new failure.

Matching `.http` file: [`requests/02-http-methods.http`](../requests/02-http-methods.http). Full capture: [`transcripts/02-http-methods.txt`](../transcripts/02-http-methods.txt).

---

## 4. Bad vs good

**Bad — `POST` used for every write, `GET` used for mutations**

```http
POST /api/tenants/ten_acme/deleteProduct
{ "id": "prd_tee" }

GET /api/tenants/ten_acme/products/prd_tee/deactivate
```

Problems:

- A crawler, link preview, or browser prefetch can fire the `GET` and deactivate a product. Safe methods must be safe in reality, not just by intent.
- A `POST` delete cannot be retried automatically by a gateway; a lost response leaves the client unsure whether the delete happened.
- Every mutation needs a bespoke path, so tooling (OpenAPI, gateways) cannot infer behaviour from the method.
- Intermediaries treat `POST` as uncacheable and non-retryable, which is exactly wrong for an idempotent action.

**Good — methods carry the semantics**

```http
DELETE /api/tenants/ten_acme/products/prd_tee
PATCH  /api/tenants/ten_acme/products/prd_tee
{ "active": false }
```

Problems solved: the path stays a noun; the method tells clients, proxies, and retry libraries what may be repeated. The status code can be justified from the method (`204` for delete, `200` for patch).

**The nuance:** method-level idempotency is not enough for `POST` creation. Two `POST /orders` calls create two orders. That is correct HTTP, and exactly why chapter 12 adds an `Idempotency-Key` contract on top. HTTP gives you the vocabulary; your API adds guarantees where the vocabulary is insufficient.

---

## 5. In a real multi-tenant e-commerce platform

A mobile checkout retries on flaky networks.

- `GET /orders/{id}` — safe to retry. Nothing changes.
- `DELETE /carts/{id}/items/{itemId}` — idempotent. If the phone retries after a timeout, the item is gone either way.
- `PATCH /orders/{id}` with `{ "shippingAddress": ... }` — if it only sets the address to a given value, repeating is harmless even if HTTP does not promise idempotency for `PATCH`.
- `POST /orders` — **not** safe to retry blindly. The client must send an `Idempotency-Key`; the server stores the first result and replays it. Chapter 12 demonstrates the retry returning the same `ord_...` ID with `Idempotent-Replayed: true`.

The warehouse integration uses `PUT /inventory/{sku}` with absolute quantities ("set stock to 42"), not `POST /inventory/add` with a delta ("add 5"). Replaying a `PUT` sets 42 again; replaying "add 5" drifts.

---

## 6. When to use it and when NOT to

| Situation | Method |
|---|---|
| Read a resource or collection | `GET` |
| Check existence / metadata without body | `HEAD` |
| Create a subordinate resource with a server-chosen ID | `POST` to the collection |
| Create/replace a resource at a client-chosen URL | `PUT /things/{clientId}` (the client must tolerate the same `PUT` twice) |
| Replace every field | `PUT` |
| Change some fields | `PATCH` (chapter 13a) |
| Remove a resource | `DELETE` |
| Complex command that is not a resource operation | `POST` to an action/task sub-resource (`POST /orders/{id}/coupon`, chapter 25e), documented as non-idempotent or protected by an idempotency key |

**When NOT to bend over backwards:**

- If an action is genuinely a command and modelling it as a resource would require an artificial noun, `POST /orders/{id}/refund` is honest and common. Stripe does this extensively. Do not create `/refundRequests` just to satisfy a purity rule.
- Do not use `PUT` for partial updates. A `PUT` that only sends one field, combined with a server that "fills in the rest from current state", is a merge patch with the wrong method name and a lost-update bug in waiting (chapter 13a).
- Do not use `GET` with a body to send complex filters. Body semantics on `GET` are not reliably supported by intermediaries. Use query parameters, or `POST /searches` if the query is truly too large.

---

## 7. Common mistakes

1. **Mutating state from `GET`.** Counters that increment, "mark as read" links fetched by an email scanner, analytics beacons that create rows. Safe means safe.
2. **`POST` for updates.** `POST /products/prd_tee/update` works, but you lose conditional requests, method-based retry policies, and cache semantics.
3. **`PUT` for partial updates.** The next client that sends a full object based on an old read silently reverts fields it never saw.
4. **Expecting `DELETE` to be replayable only if the resource still exists.** Replay should be harmless; returning `404` on the second call is fine, but the state must not change further.
5. **Assuming `PATCH` is idempotent.** `PATCH` with `{"$inc": {"stock": -1}}` is not. This course uses merge patch with absolute values, which is idempotent in practice (chapter 13a).
6. **Using `POST` for reads and then wondering why the CDN never caches anything.** Chapter 15 will show the headers; the method already decided it.
7. **No `Idempotency-Key` on create/payment endpoints.** HTTP cannot save you here; the API contract must.

---

## 8. Try it yourself

**Exercise.** For each operation, pick the method and say whether a client may automatically retry it after a network timeout:

1. Fetch a product's current stock.
2. Set a product's stock to exactly 42.
3. Decrease a product's stock by 1 after a sale.
4. Remove a product image.
5. Create a new order.

Then answer: which of these need an idempotency mechanism beyond the HTTP method, and why?

**Hint.** "Retry" here means the client never saw a response, so it does not know whether the server applied the change. Ask yourself: if the request reached the server twice, would the final state differ from it arriving once? For number 3, yes — two decrements instead of one. For number 2, no. For number 5, yes, unless the API adds a key. Chapter 12 turns that last answer into working code.

---

## 9. Next

[03. Status codes that matter →](03-status-codes.md)
