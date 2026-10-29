# 05a. Query parameters: filtering and sorting

> **Run order:** in-memory server, port 4011, auth off.
>
> Every request below is copied from `transcripts/05a-query-filtering-sorting.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

Imagine a shelf with all the shop's products on it.

You do not want the whole shelf. You want "only the ones that are switched on", or "only the ones between 15 and 50 dollars", or "sorted by name".

So you hand the shopkeeper a small sticky note with your wishes:

```
only active = yes
price between 1500 and 5000
sort by name
```

The sticky note changes **which products you see and in what order**. It does not change the products themselves. The shelf address stays the same.

Query parameters are those sticky notes. They live after the `?` in the URL.

---

## 2. Real name

A **query string** is the part of a URI after `?`. It is a list of `key=value` pairs separated by `&`. In HTTP APIs it is the standard place for **collection controls**:

- **Filtering** — return only rows matching predicates (`active=true`, `minPriceCents=1500`).
- **Sorting** — choose an ordered field and direction (`sort=-priceCents`).
- **Search** — a free-text term (chapter 05b).
- **Field selection** — sparse fieldsets (chapter 05b).
- **Pagination** — `limit`, `offset`, `cursor` (chapter 06).

Rules that make filters safe and predictable:

1. **Allowlist everything.** Unknown parameter names are rejected, not ignored.
2. **Type everything.** `active=true` is a boolean; `minPriceCents=abc` is an error.
3. **Validate combinations.** `minPriceCents > maxPriceCents` is an error even if each value is valid.
4. **Keep names stable.** `priceCents` matches the JSON field, so clients learn one vocabulary.
5. **Never let query values reach the query layer raw.** In PostgreSQL this becomes "no string concatenation"; the Prisma layer uses typed `where` objects (chapter 11).

There is no RFC that dictates filter parameter names. Stripe uses nested bracket syntax (`created[gte]=...`), Microsoft uses OData (`$filter`), Google uses `filter=field=value`. This course uses flat, typed, camelCase parameters, which stay readable in URLs and map directly to a schema. The trade-off is more parameters and less expressive power than OData.

---

## 3. Example

The query schema lives next to the write schemas, in `src/schemas/product.ts`:

```ts
// src/schemas/product.ts (excerpt, comments added)
export const productListQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    active: z.enum(['true', 'false']).optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    minPriceCents: z.coerce.number().int().min(0).optional(),
    maxPriceCents: z.coerce.number().int().min(0).optional(),
    sort: z
      .enum(['createdAt', '-createdAt', 'name', '-name', 'priceCents', '-priceCents'])
      .default('-createdAt'),
    // ...pagination fields, chapter 06
  })
  .strict()                       // unknown keys are rejected, not ignored
  .refine(
    (q) => q.minPriceCents === undefined || q.maxPriceCents === undefined
      || q.minPriceCents <= q.maxPriceCents,
    { message: 'minPriceCents must be less than or equal to maxPriceCents.', path: ['minPriceCents'] },
  );
```

The route parses `req.query` with it before touching the store:

```ts
// src/routes/products.ts (excerpt)
router.get('/', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const query = parseInput(productListQuerySchema, req.query); // 422 on bad filters
  const result = await store.listProducts(tenantId, { ...query });
  noStore(res);
  res.status(200).json({ data: result.items.map(productDto), pagination: pageMeta(result, query) });
});
```

The in-memory store applies the same predicates a database would:

```ts
// src/store/memory.ts (excerpt, comments added)
let rows = [...this.products.values()].filter((product) => {
  if (product.tenantId !== tenantId || product.deletedAt) return false; // tenant + soft delete
  if (options.active !== undefined && product.active !== options.active) return false;
  if (options.minPriceCents !== undefined && product.priceCents < options.minPriceCents) return false;
  if (options.maxPriceCents !== undefined && product.priceCents > options.maxPriceCents) return false;
  if (q) {
    const haystack = `${product.name} ${product.sku} ${product.slug}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
});
rows = rows.sort((a, b) => compare(a, b, options.sort)); // sort after filtering
```

### Filter by a boolean

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?active=true
HTTP/1.1 200 OK
X-Request-Id: 483b9626-dc47-4242-9301-4fd87864a7ba
Content-Type: application/json; charset=utf-8
Content-Length: 861
Date: Thu, 29 Oct 2026 12:26:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_hoodie","sku":"HOO-001","slug":"trail-hoodie","name":"Trail Hoodie","description":"Fleece-lined hoodie.","priceCents":4999,"currency":"USD","stock":8,"active":true,"version":1,"createdAt":"2026-01-01T11:00:00.000Z","updatedAt":"2026-01-01T11:00:00.000Z"},{"id":"prd_mug","sku":"MUG-001","slug":"camp-mug","name":"Camp Mug","description":"Enamel mug, 350 ml.","priceCents":1299,"currency":"USD","stock":120,"active":true,"version":1,"createdAt":"2026-01-01T10:00:00.000Z","updatedAt":"2026-01-01T10:00:00.000Z"},{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}],"pagination":{"limit":20,"hasMore":false,"nextCursor":null}}
```

`prd_cap` is absent because it is inactive. The response does not say "filtered"; the client asked, so it knows.

### Filter by a numeric range

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?minPriceCents=1500\&maxPriceCents=5000
HTTP/1.1 200 OK
X-Request-Id: f39006ab-936c-4c8f-b2b7-bd392f537148
Content-Type: application/json; charset=utf-8
Content-Length: 863
Date: Thu, 29 Oct 2026 12:26:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","sku":"CAP-001","slug":"running-cap","name":"Running Cap","description":"Lightweight cap.","priceCents":2499,"currency":"USD","stock":0,"active":false,"version":1,"createdAt":"2026-01-01T12:00:00.000Z","updatedAt":"2026-01-01T12:00:00.000Z"},{"id":"prd_hoodie","sku":"HOO-001","slug":"trail-hoodie","name":"Trail Hoodie","description":"Fleece-lined hoodie.","priceCents":4999,"currency":"USD","stock":8,"active":true,"version":1,"createdAt":"2026-01-01T11:00:00.000Z","updatedAt":"2026-01-01T11:00:00.000Z"},{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}],"pagination":{"limit":20,"hasMore":false,"nextCursor":null}}
```

Both prices are inclusive bounds. State that in the docs; otherwise clients guess whether `5000` excludes a product priced exactly `5000`.

### Sort ascending by name

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?sort=name
HTTP/1.1 200 OK
X-Request-Id: 807afc61-66ff-4529-92d3-1fcbcabd6368
Content-Type: application/json; charset=utf-8
Content-Length: 1119
Date: Thu, 29 Oct 2026 12:26:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_mug","sku":"MUG-001","slug":"camp-mug","name":"Camp Mug","description":"Enamel mug, 350 ml.","priceCents":1299,"currency":"USD","stock":120,"active":true,"version":1,"createdAt":"2026-01-01T10:00:00.000Z","updatedAt":"2026-01-01T10:00:00.000Z"},{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"},{"id":"prd_cap","sku":"CAP-001","slug":"running-cap","name":"Running Cap","description":"Lightweight cap.","priceCents":2499,"currency":"USD","stock":0,"active":false,"version":1,"createdAt":"2026-01-01T12:00:00.000Z","updatedAt":"2026-01-01T12:00:00.000Z"},{"id":"prd_hoodie","sku":"HOO-001","slug":"trail-hoodie","name":"Trail Hoodie","description":"Fleece-lined hoodie.","priceCents":4999,"currency":"USD","stock":8,"active":true,"version":1,"createdAt":"2026-01-01T11:00:00.000Z","updatedAt":"2026-01-01T11:00:00.000Z"}],"pagination":{"limit":20,"hasMore":false,"nextCursor":null}}
```

Ascending is the bare field; the store breaks ties by `id` so the order is total and stable (needed for pagination in chapter 06).

### Sort descending by price

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?sort=-priceCents
HTTP/1.1 200 OK
X-Request-Id: 1ddfc23a-e33d-42f8-9a45-b45386e90097
Content-Type: application/json; charset=utf-8
Content-Length: 1119
Date: Thu, 29 Oct 2026 12:26:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_hoodie","sku":"HOO-001","slug":"trail-hoodie","name":"Trail Hoodie","description":"Fleece-lined hoodie.","priceCents":4999,"currency":"USD","stock":8,"active":true,"version":1,"createdAt":"2026-01-01T11:00:00.000Z","updatedAt":"2026-01-01T11:00:00.000Z"},{"id":"prd_cap","sku":"CAP-001","slug":"running-cap","name":"Running Cap","description":"Lightweight cap.","priceCents":2499,"currency":"USD","stock":0,"active":false,"version":1,"createdAt":"2026-01-01T12:00:00.000Z","updatedAt":"2026-01-01T12:00:00.000Z"},{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"},{"id":"prd_mug","sku":"MUG-001","slug":"camp-mug","name":"Camp Mug","description":"Enamel mug, 350 ml.","priceCents":1299,"currency":"USD","stock":120,"active":true,"version":1,"createdAt":"2026-01-01T10:00:00.000Z","updatedAt":"2026-01-01T10:00:00.000Z"}],"pagination":{"limit":20,"hasMore":false,"nextCursor":null}}
```

### Unknown sort option → `422`

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?sort=cheapest
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: ed84960f-5117-426e-a121-9515cc32594a
Content-Type: application/problem+json; charset=utf-8
Content-Length: 409
Date: Thu, 29 Oct 2026 12:26:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products?sort=cheapest","code":"validation_failed","errors":[{"pointer":"/sort","code":"invalid_value","message":"Invalid option: expected one of \"createdAt\"|\"-createdAt\"|\"name\"|\"-name\"|\"priceCents\"|\"-priceCents\""}]}
```

The error lists the allowed values. That is better than silently falling back to the default: a typo would otherwise return plausible data in the wrong order.

### Unknown parameter → `422`

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?tenant=ten_globex
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 281b35b0-06d5-4621-ba8b-27594449e17a
Content-Type: application/problem+json; charset=utf-8
Content-Length: 330
Date: Thu, 29 Oct 2026 12:26:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products?tenant=ten_globex","code":"validation_failed","errors":[{"pointer":"","code":"unrecognized_keys","message":"Unrecognized key: \"tenant\""}]}
```

This is a security feature. A `tenant` query parameter cannot override the path tenant, because `.strict()` rejects it before the handler runs. If unknown keys were ignored, a client could believe it was querying Globex while receiving Acme data.

### Contradictory range → `422`

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?minPriceCents=5000\&maxPriceCents=1000
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 002d8a6c-adfb-4e39-ba3a-1b99bf2449a7
Content-Type: application/problem+json; charset=utf-8
Content-Length: 383
Date: Thu, 29 Oct 2026 12:26:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products?minPriceCents=5000&maxPriceCents=1000","code":"validation_failed","errors":[{"pointer":"/minPriceCents","code":"custom","message":"minPriceCents must be less than or equal to maxPriceCents."}]}
```

### Empty result is not an error

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?maxPriceCents=100
HTTP/1.1 200 OK
X-Request-Id: 82e5b489-3e05-486b-b02c-239aeecaa16f
Content-Type: application/json; charset=utf-8
Content-Length: 71
Date: Thu, 29 Oct 2026 12:26:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[],"pagination":{"limit":20,"hasMore":false,"nextCursor":null}}
```

A filter that matches nothing is a successful query with zero rows. Returning `404` here is a classic mistake: the collection exists; it is just empty under these filters.

Matching `.http` file: [`requests/05a-query-filtering-sorting.http`](../requests/05a-query-filtering-sorting.http). Full capture: [`transcripts/05a-query-filtering-sorting.txt`](../transcripts/05a-query-filtering-sorting.txt).

---

## 4. Bad vs good

**Bad — stringly typed filters, unbounded sort**

```ts
// DANGER DEMO — DO NOT SHIP
const sort = String(req.query.sort ?? 'createdAt');
const sql = `SELECT * FROM products WHERE tenant_id = '${tenantId}' ORDER BY ${sort}`;
```

Problems:

- SQL injection through `sort`.
- Unknown parameters silently ignored, so clients think filters applied.
- `priceCents=abc` reaches the database and becomes a 500.
- No cap on `limit`, so `limit=1000000` becomes a denial-of-service.
- Filter names drift (`minPrice`, `min_price`, `priceFrom`) across endpoints.

**Good — schema-first filters**

```ts
const query = productListQuerySchema.parse(req.query); // typed, strict, bounded
const rows = await store.listProducts(tenantId, query); // tenant bound by the store API
```

The schema is the documentation, the validation, and (chapter 21) the OpenAPI definition. A new filter is added in one place and every client sees it.

**Trade-off:** `.strict()` breaks clients that add a cache-busting query parameter (`?_=12345`). For public APIs you may choose to ignore a documented allowlist of harmless parameters or accept unknown ones with a warning. This course rejects them because the teaching API is small and the security benefit is concrete; chapter 22 discusses the review rule.

---

## 5. In a real multi-tenant e-commerce platform

The storefront filters `active=true&minPriceCents=...&maxPriceCents=...` and sorts by `priceCents`. The support console filters `active=false` to find delisted items. The partner importer pages through everything with `limit=100`.

Each filter maps to an indexed column in PostgreSQL (chapter 11), scoped by `(tenant_id, ...)`. The tenant predicate is not a filter a client can turn off. `active` and `priceCents` are ordinary filters.

Sorting by `priceCents` on a tenant with a million products needs an index `(tenant_id, price_cents, id)`; otherwise the database sorts the whole tenant on every request. That is an operational concern the API contract should allow: document which sorts are supported and which are cheap.

---

## 6. When to use it and when NOT to

**Use query filters when:**

- The filter set is small, known, and maps to indexed columns.
- Clients need to combine a handful of predicates.
- Results are collections and the control is about selection, not identity.

**When not to:**

- **Full-text search with relevance ranking.** A `q` parameter is fine for "contains"; real search needs an engine and its own endpoint semantics (chapter 05b).
- **Very complex boolean expressions** (`(price < 10 OR stock > 0) AND NOT discontinued`). Flat parameters cannot express it. Use a dedicated search endpoint with a structured body, or OData/GraphQL.
- **Huge `IN` lists.** `?ids=a,b,c,...` with 10,000 IDs exceeds URL limits. Use `POST /product-searches` or a bulk read endpoint.
- **Filters that expose internals.** `?internalCostBelow=...` should not exist. Filter only on public fields.

---

## 7. Common mistakes

1. **Ignoring unknown parameters.** Client typos become silent wrong results.
2. **Unvalidated sort fields.** Injection or 500s; always enum or allowlist.
3. **Not documenting inclusive/exclusive bounds.** Off-by-one support tickets forever.
4. **Unbounded `limit`.** A DoS vector and a memory hazard; cap it (chapter 06).
5. **Sorting without a tie-breaker.** Non-deterministic order breaks cursor pagination and makes tests flaky.
6. **Different names for the same concept.** `q` here, `search` there, `query` elsewhere.
7. **Filtering in application code after fetching everything.** Works in memory, dies in production. Push predicates into the store/database.
8. **Letting a filter override tenant scope.** `?tenant=` must be rejected or ignored by design, never honored over the path and token.
9. **Returning `404` for an empty filtered collection.** It is a `200` with `data: []`.

---

## 8. Try it yourself

**Exercise.** Add a `currency` filter to the product list that accepts only `USD` or `EUR`, and a `stockBelow` filter that accepts a non-negative integer. Then make these requests and predict the status code before running them:

```
?currency=usd
?currency=GBP
?stockBelow=-1
?stockBelow=10&currency=EUR
```

**Hint.** Add both fields to `productListQuerySchema` with `z.enum` and `z.coerce.number().int().min(0)`, then filter in `MemoryStore.listProducts` (and later in `PrismaStore`). Lowercase `usd` fails an enum of uppercase codes. Negative stock fails `min(0)`. The last one might return an empty list, which is a `200`, not an error. Re-run `npm run typecheck` and update the transcript only after you see the real responses.

---

## 9. Next

[05b. Query parameters: searching and field selection →](05b-query-search-field-selection.md)
