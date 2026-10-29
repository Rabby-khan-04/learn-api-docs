# 05b. Query parameters: searching and field selection

> **Run order:** in-memory server, port 4011, auth off.
>
> Every request below is copied from `transcripts/05b-query-search-field-selection.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

Sometimes you do not remember the exact name of a product, only a word inside it: "tee", "mug". You ask the shopkeeper: "Show me anything with *mug* in the name or code." That is **search**.

Sometimes you only care about two things on each product: its name and its price. You do not want the description, the stock, the dates. You tell the shopkeeper: "Only write down these two columns." That is **field selection** (also called a sparse fieldset).

Both are just more sticky notes on the same shelf request. Neither changes the products.

---

## 2. Real name

- **Search** (`q`) is a filter over multiple text fields with substring or relevance semantics. The simplest version is a case-insensitive `contains` across name, SKU, and slug. A production version uses a search engine, ranking, stemming, and typo tolerance.
- **Sparse fieldsets** (`fields=a,b,c`) let a client ask for a subset of the representation. `fields` is a *projection*, not a filter: it changes the shape of each item, not which items are returned.
- A partner of sparse fieldsets is **embedding/expansion** (`expand=customer`), which includes related resources. This course does not implement it; the same projection rules apply.

Rules that keep them safe:

1. **Bound the search term.** `q` has `min(1).max(100)`. A 10 MB term is a DoS.
2. **Escape wildcards.** If the term eventually reaches SQL `LIKE`, `%` and `_` must be escaped (chapter 11's Prisma layer uses `contains`, which parameterises, but the rule stands for raw SQL).
3. **Allowlist fields.** Unknown fields are rejected. If `passwordHash` is unknown, it can never be selected, even if a future schema accidentally exposes it.
4. **Always include `id`.** A sparse item without an ID cannot be addressed or matched to a cache entry.
5. **Do not let `fields` change authorization.** Projection happens after the tenant-scoped query, on an already-authorized row.

Search semantics are not standardised. This course defines `q` as **case-insensitive substring across name, SKU, and slug**, and documents that. That is honest; calling it "full-text search" would overpromise.

---

## 3. Example

Search is part of the list query schema and applied before sorting:

```ts
// src/schemas/product.ts (excerpt)
q: z.string().trim().min(1).max(100).optional(),

// src/store/memory.ts (excerpt, comments added)
if (q) {
  // Search across the fields a shopper might type. Lowercase both sides.
  const haystack = `${product.name} ${product.sku} ${product.slug}`.toLowerCase();
  if (!haystack.includes(q)) return false;
}
```

Field selection is parsed and applied in the route:

```ts
// src/routes/products.ts (excerpt)
const fields = parseFields(query.fields);
// ...
data: result.items.map((item) => selectFields(productDto(item), fields)),
```

```ts
// src/routes/helpers.ts (excerpt, comments added)
export function parseFields(raw: string | undefined): Set<ProductField> | null {
  if (!raw) return null;                          // no projection: full DTO
  const requested = raw.split(',').map((field) => field.trim()).filter(Boolean);
  const allowed = new Set<string>(productFields); // explicit allowlist
  const unknown = requested.filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new HttpProblem(422, 'invalid_fields', `Unknown fields: ${unknown.join(', ')}`, { ... });
  }
  // id is always present so every item remains identifiable.
  return new Set(['id', ...requested] as ProductField[]);
}

export function selectFields(dto: ProductDto, fields: Set<ProductField> | null) {
  if (!fields) return dto;
  const full = dto as unknown as Record<string, unknown>;
  return Object.fromEntries([...fields].map((field) => [field, full[field]]));
}
```

### Search by a word inside the name

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?q=tee
HTTP/1.1 200 OK
X-Request-Id: dabff9c2-57b4-4a44-b954-addc604c8191
Content-Type: application/json; charset=utf-8
Content-Length: 339
Date: Thu, 29 Oct 2026 12:26:47 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}],"pagination":{"limit":20,"hasMore":false,"nextCursor":null}}
```

`tee` matches the SKU (`TEE-001`), the slug (`classic-tee`), and the description? No — description is not in the haystack. It matches because of SKU and slug. If you expect descriptions to be searchable, say so explicitly and implement it; silent expectations become bug reports.

### Case-insensitive search

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?q=MUG
HTTP/1.1 200 OK
X-Request-Id: 6167dbc2-3915-4992-a26a-6e1a975ea55b
Content-Type: application/json; charset=utf-8
Content-Length: 326
Date: Thu, 29 Oct 2026 12:26:47 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_mug","sku":"MUG-001","slug":"camp-mug","name":"Camp Mug","description":"Enamel mug, 350 ml.","priceCents":1299,"currency":"USD","stock":120,"active":true,"version":1,"createdAt":"2026-01-01T10:00:00.000Z","updatedAt":"2026-01-01T10:00:00.000Z"}],"pagination":{"limit":20,"hasMore":false,"nextCursor":null}}
```

Uppercase input finds lowercase data. Clients should not have to guess; document case-insensitivity.

### Ask for two fields

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?fields=name,priceCents\&limit=3
HTTP/1.1 200 OK
X-Request-Id: 9be91f14-1032-4ba0-bd05-e1caca65be1b
Content-Type: application/json; charset=utf-8
Content-Length: 309
Date: Thu, 29 Oct 2026 12:26:47 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","name":"Running Cap","priceCents":2499},{"id":"prd_hoodie","name":"Trail Hoodie","priceCents":4999},{"id":"prd_mug","name":"Camp Mug","priceCents":1299}],"pagination":{"limit":3,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDEwOjAwOjAwLjAwMFoiLCJpZCI6InByZF9tdWcifQ"}}
```

`id` appears even though it was not requested. That is deliberate: identity is not optional.

### Only one field requested

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?fields=name\&limit=1
HTTP/1.1 200 OK
X-Request-Id: 399ee574-ab70-46a8-a4ff-81d21175d063
Content-Type: application/json; charset=utf-8
Content-Length: 178
Date: Thu, 29 Oct 2026 12:26:47 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","name":"Running Cap"}],"pagination":{"limit":1,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDEyOjAwOjAwLjAwMFoiLCJpZCI6InByZF9jYXAifQ"}}
```

The pagination envelope is not affected by `fields`; it is part of the collection response, not of each item.

### Ask for a field that must never exist

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?fields=name,passwordHash
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 63b90883-59c6-45bc-9aca-0c0f73c8f921
Content-Type: application/problem+json; charset=utf-8
Content-Length: 334
Date: Thu, 29 Oct 2026 12:26:47 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_fields","title":"Validation Failed","status":422,"detail":"Unknown fields: passwordHash","instance":"/api/tenants/ten_acme/products?fields=name,passwordHash","code":"invalid_fields","errors":[{"pointer":"/fields","code":"unknown_field","message":"Unknown field \"passwordHash\"."}]}
```

The allowlist makes this a validation error, not a silent omission. It also means a leaked field cannot be requested before someone notices it in the DTO.

### No matches

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?q=zzzz
HTTP/1.1 200 OK
X-Request-Id: 71c11ac9-a553-438e-b31c-6c347e1ef619
Content-Type: application/json; charset=utf-8
Content-Length: 71
Date: Thu, 29 Oct 2026 12:26:47 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[],"pagination":{"limit":20,"hasMore":false,"nextCursor":null}}
```

Again: an empty result is a successful query, not a `404`.

Matching `.http` file: [`requests/05b-query-search-field-selection.http`](../requests/05b-query-search-field-selection.http). Full capture: [`transcripts/05b-query-search-field-selection.txt`](../transcripts/05b-query-search-field-selection.txt).

---

## 4. Bad vs good

**Bad — `LIKE` concatenation and a field name passed through**

```ts
// DANGER DEMO — DO NOT SHIP
const q = String(req.query.q);
const fields = String(req.query.fields ?? '*');
const sql = `SELECT ${fields} FROM products WHERE name LIKE '%${q}%'`;
```

Problems:

- The search term can break out of the string (`' OR 1=1 --`).
- `fields` can select `internal_cost`, `password_hash`, or a whole expression.
- `SELECT *` when no fields are requested leaks every column.
- No length cap; a huge `q` can exhaust memory.

**Good — bound, allowlist, project after authorization**

```ts
const query = productListQuerySchema.parse(req.query); // q: 1..100 chars
const fields = parseFields(query.fields);               // allowlist + id
const rows = await store.listProducts(tenantId, query); // tenant-scoped first
const data = rows.items.map((row) => selectFields(productDto(row), fields));
```

**Trade-off:** sparse fieldsets complicate caching and client code (a client must tolerate missing fields). They are worth it for mobile clients on slow networks and for wide resources. For a small `Product` DTO, the bandwidth win is modest; the security win of an allowlist is the bigger part.

Search is the opposite trade: `contains` is simple and predictable but does not scale. At a million products, `ILIKE '%term%'` cannot use a normal B-tree index. Chapter 11 mentions the index strategy; a real platform would use PostgreSQL full-text search or an external engine, and the API would gain `searchMode` semantics, ranking, and pagination by relevance.

---

## 5. In a real multi-tenant e-commerce platform

The storefront search box sends `q=<typed text>&limit=20`. Because search runs inside the tenant-scoped query, Acme's products never appear in Globex's results, even when the SKUs collide (both tenants can have `MUG-001`; chapter 25a demonstrates it).

The mobile app requests `fields=id,name,priceCents,currency` on the catalog grid to cut payload size, then fetches the full product on tap. The field allowlist means the mobile client cannot accidentally request `tenantId` or cost data that the DTO does not expose.

The support console searches by SKU. Since SKU is unique per tenant, `q=TEE-001` returns one row; the same term in Globex returns Globex's own `TEE-001` if it exists, not Acme's. Scoping happens before search, not after.

---

## 6. When to use it and when NOT to

**Use `q` when:**

- Users type a word and expect "anything containing this".
- The dataset per tenant is modest or the search column is indexed appropriately.
- You document the searched fields and the matching rule.

**Use `fields` when:**

- Payload size matters (mobile, list views, partner bulk jobs).
- The resource is wide and most clients need a subset.
- You can maintain a stable allowlist and document that omitted fields may appear later.

**When not to:**

- **Relevance-ranked search, typo tolerance, facets, synonyms.** Use a search engine and a dedicated search endpoint; `q` on a list endpoint will not grow into that gracefully.
- **Searching sensitive fields.** Do not include `email` in customer search unless the caller is authorized for it; the search predicate itself can leak existence.
- **Using `fields` as authorization.** If `internalCost` is in the DTO allowlist by mistake, `fields` will happily return it. Authorization belongs in the DTO and the query, not in projection.
- **`fields=*`.** Do not invent a wildcard; absent `fields` already means "full representation".

---

## 7. Common mistakes

1. **Case-sensitive search by accident.** Users type lowercase; data is mixed case. Normalize both sides.
2. **Searching unindexed `%term%` at scale.** Works in demos, times out in production.
3. **Not documenting which fields are searched.** "Why doesn't it find the description?" is a documentation bug.
4. **Allowing `fields` to name internal columns.** Always allowlist public DTO fields.
5. **Dropping `id` from sparse responses.** Clients cannot correlate items.
6. **Letting `fields` alter the envelope.** `pagination` and `data` stay; only item shape changes.
7. **Reflecting the search term unescaped** into logs, HTML, or SQL. Context-appropriate escaping is mandatory.
8. **Treating an empty search as `404`.** It is `200` with `[]`.
9. **Combining search with cursor pagination carelessly.** The cursor is built for a specific sort; chapter 06 shows why custom sorts and cursors conflict here.

---

## 8. Try it yourself

**Exercise.** Extend search to include `description`, but only when the client explicitly asks with `qFields=name,sku,slug,description`. Default to the current three fields. Then answer:

1. What happens when `qFields` contains `description` but `q` is absent?
2. Should `qFields` allow `internalCost`? Why not?
3. Does adding `description` to the haystack change the pagination cursor?

**Hint.** Parse `qFields` with the same allowlist approach as `fields`, but against a searchable-field list. If `q` is absent, either ignore `qFields` or reject it — pick one and document it. `internalCost` is not in the DTO, so it must not be searchable; otherwise a client can infer cost by probing terms. The cursor encodes the last row's `createdAt` and `id` (chapter 06), so search changes which rows appear, not the cursor format — but the next page must re-apply the same search predicate, or pages will not line up.

---

## 9. Next

[06a. Pagination: offset →](06a-pagination-offset.md)
