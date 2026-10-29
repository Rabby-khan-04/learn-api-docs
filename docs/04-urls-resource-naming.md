# 04. URLs: resources, nouns, and nesting

> **Run order:** in-memory server, port 4011, auth off.
>
> Every request below is copied from `transcripts/04-urls-resource-naming.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

Think of a school with labelled drawers.

- A drawer is labelled with **what is inside**: `Crayons`, not `OpenCrayonDrawer`.
- To get one crayon, you point at the drawer and then at the crayon: `Crayons/red`.
- You do not label a drawer `GetCrayonBecauseItIsTuesday`.
- If a drawer does not exist, you get "no such drawer", not a made-up drawer with an error note inside.

A URL is a drawer label. It should name **a thing**, and the thing should be a noun. The action (read, create, delete) belongs to the HTTP method, not the label.

---

## 2. Real name

A **URL** (Uniform Resource Locator) is the address of a **resource**. The path portion is a hierarchy of segments. In REST-style HTTP APIs the conventions are:

| Rule | Example |
|---|---|
| Plural nouns for collections | `/products`, `/customers`, `/orders` |
| An ID segment for one member | `/products/prd_tee` |
| Nest a sub-resource under its parent only when the parent is required to identify it | `/orders/{orderId}/payments` |
| Use query parameters for filters, sorting, pagination, field selection | `/products?active=true&sort=name` |
| Lowercase, hyphen-separated words | `/webhook-endpoints`, not `/webhookEndpoints` |
| No file extensions | `/products/prd_tee`, not `/products/prd_tee.json` (use `Accept`) |
| No verbs | `DELETE /products/prd_tee`, not `POST /products/prd_tee/delete` |
| Tenant scope visible | `/tenants/{tenantId}/products` |

Two separate concepts hide inside a URL:

1. **Resource identity** — which thing. Must be stable; changing it breaks clients.
2. **Representation/filtering** — which view of the thing. Belongs in query parameters or content negotiation.

Mixing them (`/products/active/true`) makes every filter combination a new URL.

RFC 3986 defines URL syntax; RFC 9110 defines how the target URI identifies the resource. Microsoft's and Google's API guidelines both recommend plural noun collections with IDs as segments.

---

## 3. Example

The route tree in `src/app.ts` and `src/routes/products.ts`:

```ts
// app.ts
v1.use('/tenants/:tenantId', authenticate, tenantScope(...), rateLimit, tenantRouter(...));

// routes/products.ts
router.get('/', ...)                    // /api/tenants/ten_acme/products
router.post('/', ...)                   // same URL, different method
router.get('/:productId', ...)          // /api/tenants/ten_acme/products/prd_tee
router.delete('/:productId', ...)       // same URL, different method
```

The segment `:tenantId` is part of the identity of every resource. There is no way to address a product without saying which shop owns it.

### Canonical item URL

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_tee
HTTP/1.1 200 OK
X-Request-Id: 926dfc21-7d98-4abd-b43a-2d97d50d5adf
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:26:42 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}
```

### A verb path does not exist — and should not

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/getProducts
HTTP/1.1 404 Not Found
X-Request-Id: 74e4b5bc-d699-429a-b680-eb46ba1da354
Content-Type: application/problem+json; charset=utf-8
Content-Length: 221
Date: Thu, 29 Oct 2026 12:26:42 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"No route matches GET /api/tenants/ten_acme/getProducts.","instance":"/api/tenants/ten_acme/getProducts","code":"not_found"}
```

The `detail` here comes from the generic `notFoundHandler`, which is why it mentions the method and path. A real `404` for a known route (next section) uses a domain-specific message instead.

### Same pattern, another collection

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/customers/cus_acme_01
HTTP/1.1 200 OK
X-Request-Id: 388e76c1-33f7-4758-a62c-d5258e630bb5
Content-Type: application/json; charset=utf-8
Content-Length: 222
Date: Thu, 29 Oct 2026 12:26:42 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"cus_acme_01","email":"alice.johnson.1@example.com","name":"Alice Johnson","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}
```

One URL shape, learned once, applies to every collection. That predictability is the point.

### Deep nesting that does not exist

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_tee/reviews/1/comments
HTTP/1.1 404 Not Found
X-Request-Id: cfa87a58-ffed-49a0-9a60-22aa5c4382f2
Content-Type: application/problem+json; charset=utf-8
Content-Length: 269
Date: Thu, 29 Oct 2026 12:26:42 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"No route matches GET /api/tenants/ten_acme/products/prd_tee/reviews/1/comments.","instance":"/api/tenants/ten_acme/products/prd_tee/reviews/1/comments","code":"not_found"}
```

Suppose reviews existed. Would `/products/{productId}/reviews/{reviewId}/comments` be right? Only if a review ID is unique *within a product*. If review IDs are globally unique (they are opaque IDs here), `/reviews/{reviewId}/comments` is shorter, cacheable independent of product, and survives a product re-parenting. Nest when the parent is needed to resolve the child, not to show off hierarchy.

### Cross-tenant lookup

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_globex/products/prd_tee
HTTP/1.1 404 Not Found
X-Request-Id: a6164ece-7334-4726-a922-08664226f800
Content-Type: application/problem+json; charset=utf-8
Content-Length: 191
Date: Thu, 29 Oct 2026 12:26:42 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"Product not found.","instance":"/api/tenants/ten_globex/products/prd_tee","code":"not_found"}
```

`prd_tee` exists, but only in `ten_acme`. The URL is well-formed; the resource simply does not exist for `ten_globex`. Returning `404` (instead of `403` or, worse, the Acme product) is how tenant isolation shows up in the URL layer.

Matching `.http` file: [`requests/04-urls-resource-naming.http`](../requests/04-urls-resource-naming.http). Full capture: [`transcripts/04-urls-resource-naming.txt`](../transcripts/04-urls-resource-naming.txt).

---

## 4. Bad vs good

**Bad — verbs, singulars, and query-string identity**

```http
POST /api/getProducts
GET  /api/product?id=prd_tee
POST /api/product/prd_tee/update
GET  /api/tenants/ten_acme/products?tenantId=ten_globex
```

Problems:

- `POST` to read breaks caching and safe retries.
- Singular `/product` for a collection invites `/product/all` and `/product/create`.
- `/update` duplicates `PATCH` with a private vocabulary.
- The tenant appears twice (path and query) with different values; which one wins? Ambiguity in a security boundary is a bug.
- IDs in query strings for a single-member read make `Location` values and cache keys awkward.

**Good — nouns, plural collections, tenant in the path**

```http
GET    /v1/tenants/ten_acme/products
POST   /v1/tenants/ten_acme/products
GET    /v1/tenants/ten_acme/products/prd_tee
PATCH  /v1/tenants/ten_acme/products/prd_tee
DELETE /v1/tenants/ten_acme/products/prd_tee
```

Same path, different methods; one tenant segment; IDs as path segments; query parameters only for filtering and pagination (chapters 05–06). Chapter 14 adds `/v1`.

**Trade-off:** long paths. `/v1/tenants/ten_acme/products/prd_tee` is more verbose than `/products/prd_tee`. The tenant segment buys explicit scope, simple gateway routing, and cache partitioning. In a multi-tenant platform that is a good trade; for a single-tenant internal service, dropping it is reasonable.

---

## 5. In a real multi-tenant e-commerce platform

Acme's storefront calls `/v1/tenants/ten_acme/products?...`. A platform admin portal calls the same URL shape for any tenant because the platform role is authorized for all shops (chapter 17).

Logs, metrics, and rate limits partition naturally by the fourth path segment. A WAF rule can block `/v1/tenants/ten_globex/*` for a partner whose contract only covers Acme. An S3-style cache key includes the tenant, so one shop's catalog never warms another's cache (chapter 15).

When Acme changes its storefront slug, `/products/{id}` is unaffected because IDs are opaque and stable; the human-readable slug lives in the body and can change without breaking bookmarks. The URL names identity; the representation carries presentational details (chapter 07).

---

## 6. When to use it and when NOT to

**Use this URL style when:**

- Resources have stable identity and a natural hierarchy.
- Multiple clients or partners consume the API.
- You need gateway routing, cache partitioning, and per-tenant policy.

**When not to force it:**

- **Actions with no resource.** `POST /orders/{id}/coupon` is an action sub-resource and is fine; the "resource" is the coupon assignment. `POST /orders/{id}/refund` is similar. The rule is not "never a verb-like segment", it is "the last segment should name the thing being created/changed, not the RPC call".
- **Singleton sub-resources.** `/tenants/{id}/settings` is a singular resource because each tenant has exactly one settings object. Singular is correct here.
- **Very deep nesting.** If you need four levels, the child probably deserves a top-level collection with a filter: `/reviews?productId=...` rather than `/products/{id}/reviews/{id}/comments`.
- **Search endpoints with huge query payloads.** Query strings have length limits; a `POST /product-searches` with a body is a pragmatic escape hatch (chapter 05b discusses cost limits).

**URLs are not authorization.** Putting `ten_acme` in the path does not grant access; chapter 17 verifies the token's tenant claim against it. A URL is a name, not a permission.

---

## 7. Common mistakes

1. **Verbs in paths.** `/getProducts`, `/createOrder`, `/deleteProduct`. Every operation becomes a path, and the method becomes noise.
2. **Singular collection names.** `/product` for the list, `/products` for one item — guaranteed confusion.
3. **Putting the tenant in two places.** Path and body/query with no rule for which wins. Pick the path in this course, verify it against the token.
4. **Deep nesting "because it reads like a sentence".** Long URLs are hard to cache and force clients to fetch parents they do not need.
5. **Exposing database keys.** `/products/42` leaks volume and invites enumeration; this course uses `prd_...` opaque IDs (chapter 07).
6. **File extensions.** `/products.json`; use `Accept: application/json` instead.
7. **Changing URLs for filtering.** `/products/active`, `/products/cheap`, `/products/cheap/active`; use query parameters.
8. **Case and separators drifting.** `/Products`, `/webhookEndpoints`, `/webhook_endpoints`. Pick lowercase kebab-case and enforce it in review (chapter 22).

---

## 8. Try it yourself

**Exercise.** A colleague designed these URLs for order payments and coupons:

```
GET  /api/tenants/{tenantId}/getOrderPayments/{orderId}
POST /api/tenants/{tenantId}/order/{orderId}/applyCoupon
GET  /api/tenants/{tenantId}/orders/{orderId}/payments/list
DELETE /api/tenants/{tenantId}/removeCoupon/{orderId}
```

Rewrite them using the rules above. Say which HTTP method each would use, and whether the coupon is a sub-resource or an action.

**Hint.** A payment belongs to an order and has its own identity, so it is a collection under the order. "Apply coupon" changes a property of the order; the coupon assignment is a singleton sub-resource of the order. "Remove coupon" is a delete of that singleton, not a verb on the order. Watch for the singular `/order` and the `.../list` suffix.

---

## 9. Next

[05a. Query parameters: filtering and sorting →](05a-query-filtering-sorting.md)
