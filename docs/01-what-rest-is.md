# 01. What REST is and is not

> **Run order:** the in-memory server, port 4011.
>
> ```console
> AUTH_ENABLED=off CACHE_ENABLED=off LEGACY_DEPRECATION_HEADERS=off PORT=4011 npm run start:memory
> ```
>
> Every request below is copied from `transcripts/01-what-rest-is.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

Imagine a huge public library.

- You don't walk up to a librarian and say "get me book number 4." You ask for a **thing** by its address: "the blue book on shelf 3."
- The librarian hands you a **copy** of the card describing that book. You never hold the original ledger.
- Every shelf has a name, not a command. Shelf `Products`, not `getAllProducts`.
- If you ask the same question twice, you get the same answer and nothing changes.
- The librarian does not remember your last visit between questions. Each question must carry everything needed to answer it.

REST is a style for building an API the same way: **name the things, use addresses, exchange copies, and don't rely on memory between requests.**

The thing you name is a **resource**. The copy you receive is a **representation** (usually JSON). The address is a **URL**.

REST is *not* "JSON over HTTP". You can send JSON over HTTP and still be nowhere near REST — for example `POST /getProducts` that returns `{success: true, data: [...]}` and keeps a session cookie. Many APIs called "REST" are really RPC with JSON, and that is fine, but it is useful to know which one you built.

---

## 2. Real name

**REST** = **RE**presentational **S**tate **T**ransfer. Roy Fielding defined it in his 2000 dissertation. It is an *architectural style* with constraints, not a protocol and not a standard you can certify against.

The constraints that matter for day-to-day API design:

| Constraint | What it means in practice |
|---|---|
| Client–server | The client renders; the server owns data and rules. They evolve separately. |
| Statelessness | Each request carries all context (token, tenant, parameters). The server keeps no per-client conversation state. This is why authentication tokens are sent on every request. |
| Cacheability | Responses say whether they may be reused (`Cache-Control`, `ETag`). |
| Uniform interface | Resources are identified by URLs; representations are manipulated through a small set of methods; messages are self-descriptive (`Content-Type`, status codes). |
| Layered system | A proxy, gateway, or CDN may sit between client and server without the client knowing. |
| Optional: code on demand | Servers may send executable code (JavaScript). Rare in APIs. |

Two words people mix up:

- **Resource** — the conceptual thing: "the product with ID `prd_tee` in tenant `ten_acme`".
- **Representation** — the bytes you get for it: a JSON document with fields, at one moment in time.

A resource can have several representations (JSON, CSV). The URL identifies the resource; `Accept` and `Content-Type` negotiate the representation.

The HTTP semantics themselves come from [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html). REST is the design style; HTTP is the protocol that implements it well.

---

## 3. Example

The running API is an Express 5 app. `src/app.ts` mounts one router for every tenant-scoped path:

```ts
// src/app.ts (excerpt, comments added)
const v1 = Router();
v1.use(
  '/tenants/:tenantId',           // every resource lives under a tenant
  authenticate,                    // chapter 17
  tenantScope((id) => store.tenantExists(id)),
  rateLimit,                       // chapter 16
  tenantRouter(store, prisma),
);
app.use('/v1', v1);
app.use('/api', legacyDeprecation, v1);  // chapter 14
```

The product routes are resource-oriented. There is no `/getProducts`, no `/createProduct`, no verb in the path:

```ts
// src/routes/products.ts (excerpt, comments added)
router.get('/', async (req, res) => {           // GET /products        -> list
  const tenantId = tenantIdOf(req);             // tenant comes from the URL and is verified
  const query = parseInput(productListQuerySchema, req.query);
  const result = await store.listProducts(tenantId, { ...query });
  res.status(200).json({ data: result.items.map(productDto), pagination: pageMeta(result, query) });
});

router.get('/:productId', async (req, res) => { // GET /products/:id    -> one resource
  const tenantId = tenantIdOf(req);
  const record = await store.findProduct(tenantId, pathParam(req, 'productId'));
  if (!record) throw notFound('Product not found.');
  res.status(200).json(productDto(record));
});
```

The only state the server keeps is the data itself. The client sends the tenant in the path on every request; the server does not remember "the tenant you selected earlier".

### Health check

```console
$ curl -sS -i --request GET http://localhost:4011/health
HTTP/1.1 200 OK
X-Request-Id: c4253158-dec2-4dc9-bb9a-08e0138d1a00
Content-Type: application/json; charset=utf-8
Content-Length: 15
Date: Thu, 29 Oct 2026 12:26:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"status":"ok"}
```

`/health` is not a resource in the catalog. It is an operational endpoint. That is acceptable: REST purity is a tool, not a religion. But notice it still follows the rules — `GET`, safe, no state change.

### List a collection

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=3
HTTP/1.1 200 OK
X-Request-Id: 6095d38a-8658-4537-af8e-33acdf36efc3
Content-Type: application/json; charset=utf-8
Content-Length: 920
Date: Thu, 29 Oct 2026 12:26:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","sku":"CAP-001","slug":"running-cap","name":"Running Cap","description":"Lightweight cap.","priceCents":2499,"currency":"USD","stock":0,"active":false,"version":1,"createdAt":"2026-01-01T12:00:00.000Z","updatedAt":"2026-01-01T12:00:00.000Z"},{"id":"prd_hoodie","sku":"HOO-001","slug":"trail-hoodie","name":"Trail Hoodie","description":"Fleece-lined hoodie.","priceCents":4999,"currency":"USD","stock":8,"active":true,"version":1,"createdAt":"2026-01-01T11:00:00.000Z","updatedAt":"2026-01-01T11:00:00.000Z"},{"id":"prd_mug","sku":"MUG-001","slug":"camp-mug","name":"Camp Mug","description":"Enamel mug, 350 ml.","priceCents":1299,"currency":"USD","stock":120,"active":true,"version":1,"createdAt":"2026-01-01T10:00:00.000Z","updatedAt":"2026-01-01T10:00:00.000Z"}],"pagination":{"limit":3,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDEwOjAwOjAwLjAwMFoiLCJpZCI6InByZF9tdWcifQ"}}
```

The collection itself is the resource. `limit`, `sort`, and the cursor are **query parameters**: they select a view of the collection, they do not name a new command. Chapters 05 and 06 go deep on this.

### Fetch one resource

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_tee
HTTP/1.1 200 OK
X-Request-Id: f3c051e1-bad3-4ed7-84ab-f5a4edbf1864
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:26:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}
```

`/products/prd_tee` is the address of one resource. The response is a representation of it. Two different clients asking at the same moment get equivalent representations without affecting each other.

Matching `.http` file: [`requests/01-what-rest-is.http`](../requests/01-what-rest-is.http). Full capture: [`transcripts/01-what-rest-is.txt`](../transcripts/01-what-rest-is.txt).

---

## 4. Bad vs good

**Bad — RPC with JSON, pretending to be REST**

```http
POST /getProducts?tenantId=ten_acme
Content-Type: application/json

{ "action": "list", "limit": 3 }
```

```json
{ "success": true, "data": [ ... ], "error": null }
```

Why it hurts:

- `POST` for a read is not safe and not cacheable. Proxies, browsers, and retries treat it as a mutation.
- The path contains a verb; adding "get one product" produces `/getProduct`, then `/getProductWithStock`, then the URL scheme collapses.
- A single `success` boolean replaces HTTP status codes. Every client must parse the body to know whether the call worked.
- `tenantId` moved into the body while the URL says nothing about scope; it is easy to omit and easy to spoof.
- `error: null` on success is noise that must exist forever for compatibility.

**Good — resources and HTTP semantics**

```http
GET /api/tenants/ten_acme/products?limit=3
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "data": [ ... ], "pagination": { "limit": 3, "hasMore": true, "nextCursor": "..." } }
```

Why it is better:

- `GET` is safe, cacheable, and retryable.
- The URL names a collection; the same URL with `?limit=3` still names the same collection.
- The status line carries success or failure. The body carries domain data.
- Tenant scope is visible and mandatory in the path; chapter 17 verifies it against the token.

The trade-off: resource modelling takes thought. A command like "apply a coupon" does not map cleanly onto a noun, and the honest answer is sometimes a small action sub-resource (`POST /orders/{id}/coupon`), which this course uses in chapter 25e and explains there.

---

## 5. In a real multi-tenant e-commerce platform

Acme runs a storefront and a warehouse integration. Globex runs another storefront on the same deployment. Both call the same API.

REST-shaped URLs make the tenancy visible at the transport layer:

```
/api/tenants/ten_acme/products
/api/tenants/ten_globex/products
```

A gateway can route, log, rate limit, and bill by path prefix before any application code runs. A support engineer reading an access log sees which tenant a request touched. A cache key can include the tenant segment (chapter 15). An authorization layer can compare the token's tenant claim with the path segment (chapter 17).

If the tenant were hidden in a session or a body field, every one of those layers would need application-specific code, and one forgotten filter would leak data across shops.

Statelessness also matters operationally: any API instance can serve any request because nothing about the client lives in memory. That is what lets the platform scale horizontally and survive a pod restart mid-session.

---

## 6. When to use it and when NOT to

**Use REST when:**

- The domain has real nouns: products, customers, orders, payments.
- Multiple independent clients exist (web, mobile, partners, internal services).
- You want HTTP infrastructure to work for you: caching, status codes, retries, gateways, standard tooling, OpenAPI.
- The API is public or long-lived, so predictability matters more than saving a round trip.

**Do not force REST when:**

- The operation is genuinely a command with complex inputs and no meaningful resource: "recalculate all prices for this tenant". A task resource (`POST /price-recalculations`, chapter 18) is still better than a verb URL, but it is a task, not a noun.
- You need one round trip for a deeply nested screen with dozens of related objects. GraphQL may fit better (chapter 23).
- The API is internal, TypeScript-to-TypeScript, and you control both ends. tRPC removes a lot of ceremony (chapter 23).
- Real-time bidirectional traffic is the core requirement; WebSockets or SSE are the right transport, not request/response REST.

"RESTful" is a direction, not a badge. The useful question is: **which constraints buy me something here, and which are ceremony?**

---

## 7. Common mistakes

1. **Verbs in paths.** `/getProduct`, `/createOrder`, `/products/delete`. Each new operation becomes a new path, and HTTP methods become decoration.
2. **`POST` for reads.** Breaks caching, safe retries, and link prefetching.
3. **Returning `200` for everything.** A missing product is not a successful response. Chapter 03 fixes this in detail.
4. **Leaking the database shape.** Returning the ORM row directly couples your public contract to columns, including internal ones. Chapter 10 introduces DTOs.
5. **Stateful sessions in a stateless protocol.** Sticky sessions hide the problem until a deploy or autoscale event moves a user to another instance.
6. **Treating REST as "URLs I like".** Field naming, error format, pagination, and status codes are part of the interface too. Consistency is chapter 22.
7. **Ignoring the tenant in the URL.** In a multi-tenant system this is not a style issue, it is a data breach waiting for a missing `WHERE`.

---

## 8. Try it yourself

**Exercise.** The current API has `GET /api/tenants/{tenantId}/products` and `GET /api/tenants/{tenantId}/products/{productId}`. A teammate proposes three new endpoints:

```
POST /api/tenants/{tenantId}/searchProducts
GET  /api/tenants/{tenantId}/getProductById?id=prd_tee
POST /api/tenants/{tenantId}/products/prd_tee/setActive
```

Rewrite each as a resource-oriented endpoint using only methods you have seen so far (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) and query parameters. For the third one, say which method you would use and why.

**Hint.** Search is a filtered view of the collection, so the collection URL plus a query parameter is enough. Fetching by ID is the item URL. Changing one field of a resource is a partial update — the method for that is not `POST`. Do not worry yet about the exact status codes; chapter 03 covers them, and chapter 13a covers partial update semantics.

---

## 9. Next

[02. HTTP methods: safe, idempotent, and when to use each →](02-http-methods.md)
