# 06a. Pagination: offset

> **Run order:** in-memory server, port 4011, auth off.
>
> Every request below is copied from `transcripts/06a-pagination-offset.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

You have a long list of products, 4 pages long. You do not want all of them at once.

You say: "Give me 2 items, starting at position 0." Then: "Give me 2 items, starting at position 2."

`limit` is how many. `offset` is where to start counting. Like reading a book: "show items 1–2", then "items 3–4".

Sometimes you also ask "how many items are there in total?" That is `includeTotal`.

The tricky part: if someone adds a new item at the front while you are reading, the page boundaries shift and you may see the same item twice, or miss one. Chapter 06b gives a better way.

---

## 2. Real name

**Offset pagination** (also called page/limit pagination) returns a window of a result set:

```
GET /products?limit=20&offset=40
```

- `limit` — maximum number of items. Bounded (`1..100` here).
- `offset` — zero-based index of the first item. Non-negative.
- `total` — optional count of all matching rows. Expensive on big tables; only when `includeTotal=true`.

The response carries `pagination` metadata:

```json
{ "limit": 2, "hasMore": true, "nextCursor": "...", "offset": 0, "total": 4 }
```

Why `nextCursor` appears even in offset mode: the same envelope is used for both modes (chapter 06b). In offset mode, `offset` and `total` are present; in cursor mode they are absent and `nextCursor` is how you continue.

Requirements for correctness:

1. **A deterministic total order.** If two rows share the sort key, add a tie-breaker (`id`). Without one, PostgreSQL may return them in different orders on different queries, and pages overlap.
2. **Bounds.** `limit` must have a maximum, or a client can ask for the whole table.
3. **Offset is O(offset).** The database still has to scan/discard the first N rows. Deep offsets on large tables are slow.
4. **Totals are expensive.** `COUNT(*)` over the same predicate can be slower than the page itself. Make it opt-in.

`offset` is the right tool for admin tables with "jump to page 7", exports, and small per-tenant datasets. It is the wrong tool for infinite scroll over a changing collection.

---

## 3. Example

The schema bounds both parameters:

```ts
// src/schemas/product.ts (excerpt)
limit: z.coerce.number().int().min(1).max(100).default(20),
offset: z.coerce.number().int().min(0).optional(),
includeTotal: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
```

The route combines them with cursor detection (chapter 06b) and builds the envelope:

```ts
// src/routes/products.ts (excerpt)
const query = parseInput(productListQuerySchema, req.query);
assertPaginationMode(query);              // rejects cursor+offset, chapter 06b
const result = await store.listProducts(tenantId, { ...query });
res.status(200).json({
  data: result.items.map(productDto),
  pagination: pageMeta(result, query),    // limit, hasMore, nextCursor, offset?, total?
});
```

```ts
// src/http/pagination.ts (excerpt)
export function pageMeta(result, query): PageMeta {
  return {
    limit: query.limit,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor ?? null,
    ...(query.offset !== undefined ? { offset: query.offset } : {}),
    ...(result.total !== undefined ? { total: result.total } : {}),
  };
}
```

### First page, with total

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=2\&offset=0\&includeTotal=true
HTTP/1.1 200 OK
X-Request-Id: 59a1b0b1-71b4-4a80-b553-a42d5e67ed1f
Content-Type: application/json; charset=utf-8
Content-Length: 689
Date: Thu, 29 Oct 2026 12:26:49 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","sku":"CAP-001","slug":"running-cap","name":"Running Cap","description":"Lightweight cap.","priceCents":2499,"currency":"USD","stock":0,"active":false,"version":1,"createdAt":"2026-01-01T12:00:00.000Z","updatedAt":"2026-01-01T12:00:00.000Z"},{"id":"prd_hoodie","sku":"HOO-001","slug":"trail-hoodie","name":"Trail Hoodie","description":"Fleece-lined hoodie.","priceCents":4999,"currency":"USD","stock":8,"active":true,"version":1,"createdAt":"2026-01-01T11:00:00.000Z","updatedAt":"2026-01-01T11:00:00.000Z"}],"pagination":{"limit":2,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDExOjAwOjAwLjAwMFoiLCJpZCI6InByZF9ob29kaWUifQ","offset":0,"total":4}}
```

### Second page, same total

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=2\&offset=2\&includeTotal=true
HTTP/1.1 200 OK
X-Request-Id: a996bc85-79d0-43d2-b6cf-075533165c96
Content-Type: application/json; charset=utf-8
Content-Length: 615
Date: Thu, 29 Oct 2026 12:26:49 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_mug","sku":"MUG-001","slug":"camp-mug","name":"Camp Mug","description":"Enamel mug, 350 ml.","priceCents":1299,"currency":"USD","stock":120,"active":true,"version":1,"createdAt":"2026-01-01T10:00:00.000Z","updatedAt":"2026-01-01T10:00:00.000Z"},{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}],"pagination":{"limit":2,"hasMore":false,"nextCursor":null,"offset":2,"total":4}}
```

`hasMore: false`, `nextCursor: null`, and the `total` stays 4 because nothing changed between calls.

### Offset past the end

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=2\&offset=100\&includeTotal=true
HTTP/1.1 200 OK
X-Request-Id: a59031c2-d324-4f37-9e96-6f404e1e8a29
Content-Type: application/json; charset=utf-8
Content-Length: 93
Date: Thu, 29 Oct 2026 12:26:49 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[],"pagination":{"limit":2,"hasMore":false,"nextCursor":null,"offset":100,"total":4}}
```

Not a `404`. The collection exists; the requested window is empty.

### `limit=0` is rejected

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=0
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: fc7ee9ab-4e3f-4975-80ec-d8a5ff99d014
Content-Type: application/problem+json; charset=utf-8
Content-Length: 326
Date: Thu, 29 Oct 2026 12:26:49 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products?limit=0","code":"validation_failed","errors":[{"pointer":"/limit","code":"too_small","message":"Too small: expected number to be >=1"}]}
```

Some APIs treat `limit=0` as "metadata only". This one does not; a client that wants only a count should use a dedicated count/aggregate endpoint rather than a zero-page hack.

### `limit=101` is rejected

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=101
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 77b9e121-1f4a-442d-80e4-6782054d23b4
Content-Type: application/problem+json; charset=utf-8
Content-Length: 326
Date: Thu, 29 Oct 2026 12:26:49 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products?limit=101","code":"validation_failed","errors":[{"pointer":"/limit","code":"too_big","message":"Too big: expected number to be <=100"}]}
```

The upper bound is a contract, not a suggestion. Clients that need more should page, export (chapter 18), or use a bulk endpoint.

### Non-numeric offset

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?offset=abc
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: f6487579-14b4-4e24-9849-4bfb42cf63f8
Content-Type: application/problem+json; charset=utf-8
Content-Length: 341
Date: Thu, 29 Oct 2026 12:26:49 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products?offset=abc","code":"validation_failed","errors":[{"pointer":"/offset","code":"invalid_type","message":"Invalid input: expected number, received NaN"}]}
```

Matching `.http` file: [`requests/06a-pagination-offset.http`](../requests/06a-pagination-offset.http). Full capture: [`transcripts/06a-pagination-offset.txt`](../transcripts/06a-pagination-offset.txt).

---

## 4. Bad vs good

**Bad — unbounded, unstable, and chatty**

```ts
// DANGER DEMO — DO NOT SHIP
const limit = Number(req.query.limit ?? 20);      // no maximum
const offset = Number(req.query.offset ?? 0);     // no validation
const rows = await db.query(
  `SELECT * FROM products WHERE tenant_id = '${tenantId}'
   ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
);
res.json(rows.rows);                              // bare array, no metadata
```

Problems:

- `limit=1000000` pulls the tenant into memory.
- `ORDER BY created_at DESC` alone is not a total order; rows with equal timestamps can swap between pages.
- String interpolation invites SQL injection.
- A bare array cannot grow a `total` or `hasMore` field without breaking clients.

**Good — bounded, ordered, enveloped**

```ts
const query = productListQuerySchema.parse(req.query);   // limit 1..100, offset >= 0
const result = await store.listProducts(tenantId, query); // ORDER BY createdAt, id
res.json({ data: ..., pagination: pageMeta(result, query) });
```

**Trade-offs:**

- **Offset vs cursor.** Offset allows page N and totals, but is unstable under inserts and slow at deep offsets. Cursor is stable and fast, but no page numbers and no cheap total (chapter 06b). Many APIs offer both and reject mixing them.
- **Bare array vs envelope.** Envelopes allow metadata but add a level of nesting. Once a bare array ships, adding metadata is a breaking change. Start with an envelope.
- **Counts always vs opt-in.** Always counting costs a second query on every page. Opt-in (`includeTotal=true`) keeps the common path fast.

---

## 5. In a real multi-tenant e-commerce platform

The partner importer pulls 100 products per page with `offset=0,100,200,...` and `includeTotal=true` to show progress ("1,200 of 4,000 imported"). Offset is fine: the importer runs at night, the catalog is stable, and totals are acceptable on a tenant with a few thousand products.

The storefront infinite scroll uses cursor pagination instead, because shoppers browse while the merchandiser edits the catalog (chapter 06b).

The support console shows "page 3 of 12". That is offset pagination with a total. The cost is bounded because the console is internal and the tenant catalog is small.

At some point a tenant has 2 million products. Deep offsets (`offset=1500000`) become seconds of database work. The platform's response is not "raise the timeout"; it is to steer bulk consumers to the CSV export (chapter 18) and keep interactive lists on cursor pagination.

---

## 6. When to use it and when NOT to

**Use offset when:**

- Users need page numbers or "jump to page N".
- The dataset is small or static during the read.
- You need a total count and can afford it.
- Admin/export tooling wants random access.

**Do not use offset when:**

- The collection changes while clients page through it (feeds, order lists, infinite scroll). Rows shift; clients see duplicates or skips.
- Offsets can get deep (millions of rows); performance degrades linearly.
- The data is append-heavy and "newest first" is the main access pattern; keyset/cursor is a better fit.

**Hybrid note:** this API accepts either `offset` or `cursor`, but not both, and refuses `includeTotal` with a cursor (chapter 06b shows the exact errors). Mixing modes is where most pagination bugs come from.

---

## 7. Common mistakes

1. **No maximum `limit`.** Memory exhaustion, slow queries, angry database administrator.
2. **No tie-breaker in the sort.** Page 1 and page 2 can overlap. Always add `id` or another unique column.
3. **Negative or non-numeric offset.** Validate; do not pass `NaN` to the database.
4. **`404` for an offset past the end.** It is an empty `200`.
5. **Counting on every request.** `COUNT(*)` doubles the cost; make totals opt-in.
6. **Changing the sort between pages.** Page 2 must use the same predicate and order as page 1, or the window moves.
7. **Returning a bare array.** Cannot add metadata later without breaking clients.
8. **Trusting `total` as exact while rows change.** It is a snapshot; document that.
9. **Using offset for a moving feed and blaming the client for duplicates.** That is the mode's inherent behaviour.

---

## 8. Try it yourself

**Exercise.** The catalog has 4 products and default sort `-createdAt`. A merchandiser inserts a new product at the top between page 1 and page 2.

1. With `limit=2&offset=2`, which products appear on page 2 now?
2. Did any product appear on both pages?
3. Which product was skipped?
4. What would cursor pagination have done differently?

**Hint.** Insert a product with `createdAt` newer than all others using `POST /products` (in-memory server, auth off). Then request page 1 (`offset=0`), insert, then page 2 (`offset=2`). The new row shifts everything down by one, so the old second item reappears at the start of page 2 and the last item is pushed out of the four-item window. Cursor pagination anchors on the last row you saw, not on a numeric position; chapter 06b demonstrates it.

---

## 9. Next

[06b. Pagination: cursor →](06b-pagination-cursor.md)
