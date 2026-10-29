# 10. Response shaping and DTOs

> **Run order:** in-memory server, port 4011, auth off.
>
> Every request below is copied from `transcripts/10-response-shaping-dtos.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

Your school has a **private file** about you: your address, your parent's phone, your medical notes, your grades.

When a friend asks "tell me about yourself", you do not hand over the private file. You make a **short card**: your name, your class, your favorite game.

The private file is the database row. The card is the **DTO** (Data Transfer Object). The card is built on purpose: you choose what to show.

If someone adds a new private note to your file, the card does not change automatically. That is good: the card is a promise about what you share.

---

## 2. Real name

A **DTO** is an object shaped for transport, not for storage. It is the public contract of an endpoint.

Rules:

1. **Never serialize ORM/database rows directly.** A column added later must not appear in the API by accident.
2. **Whitelist fields explicitly.** `productDto(record)` names every public field.
3. **Convert types at the boundary.** `Date` becomes ISO string; money stays integer; booleans stay booleans.
4. **Derive computed fields deliberately.** `status: BANNED/ACTIVE` is derived from `bannedAt`; it is a public concept, not a column.
5. **Share one DTO per resource.** A product looks the same in a list and in a detail read (chapter 22).
6. **Exclude tenant and security internals.** No `tenantId`, no `deletedAt`, no `internalCost`, no password hashes.
7. **Projection (`fields`) happens on top of the DTO**, after authorization (chapter 05b).

A DTO is not a database entity with a different name. It is a deliberate, versioned promise. When you add a field, you are changing the contract; chapter 14 covers additive compatibility.

---

## 3. Example

The DTO functions are the only place where records become JSON:

```ts
// src/store/types.ts (excerpt, comments added)
export function productDto(record: ProductRecord) {
  return {
    id: record.id,
    sku: record.sku,
    slug: record.slug,
    name: record.name,
    description: record.description,
    priceCents: record.priceCents,
    currency: record.currency,
    stock: record.stock,
    active: record.active,
    version: record.version,
    createdAt: iso(record.createdAt),   // Date -> ISO 8601 UTC string
    updatedAt: iso(record.updatedAt),
    // tenantId, deletedAt, internalCost are deliberately absent
  };
}

export function customerDto(record: CustomerRecord) {
  return {
    id: record.id,
    email: record.email,
    name: record.name,
    status: record.bannedAt ? ('BANNED' as const) : ('ACTIVE' as const), // derived
    bannedAt: record.bannedAt ? iso(record.bannedAt) : null,
    banReason: record.banReason,
    version: record.version,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}
```

Every route uses them:

```ts
// src/routes/products.ts (excerpt)
res.status(201).json(productDto(record));
res.status(200).json({ data: result.items.map(productDto), pagination: ... });
```

### The same shape in a list

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=1
HTTP/1.1 200 OK
X-Request-Id: 4162afed-ea73-4aa2-bd64-d4bee40938f6
Content-Type: application/json; charset=utf-8
Content-Length: 398
Date: Thu, 29 Oct 2026 12:27:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","sku":"CAP-001","slug":"running-cap","name":"Running Cap","description":"Lightweight cap.","priceCents":2499,"currency":"USD","stock":0,"active":false,"version":1,"createdAt":"2026-01-01T12:00:00.000Z","updatedAt":"2026-01-01T12:00:00.000Z"}],"pagination":{"limit":1,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDEyOjAwOjAwLjAwMFoiLCJpZCI6InByZF9jYXAifQ"}}
```

### And in a detail read

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_tee
HTTP/1.1 200 OK
X-Request-Id: a51d4834-40d9-42f8-a789-3ac957d78b86
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:27:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}
```

The only difference between list item and detail is the envelope. A client writes one product parser.

### Create returns the same representation

```console
$ curl -sS -i --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Content-Type: application/json' --data-binary '{
  "sku": "LMP-001",
  "slug": "camp-lamp",
  "name": "Camp Lamp",
  "priceCents": 3499,
  "currency": "USD",
  "stock": 12
}'
HTTP/1.1 201 Created
X-Request-Id: 5c4fc677-84d7-4466-b6e5-29cc31d31dde
Location: /api/tenants/ten_acme/products/prd_505be7a1-01de-497f-aae3-ec0ee433c440
Content-Type: application/json; charset=utf-8
Content-Length: 272
Date: Thu, 29 Oct 2026 12:27:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_505be7a1-01de-497f-aae3-ec0ee433c440","sku":"LMP-001","slug":"camp-lamp","name":"Camp Lamp","description":null,"priceCents":3499,"currency":"USD","stock":12,"active":true,"version":1,"createdAt":"2026-10-29T12:27:02.468Z","updatedAt":"2026-10-29T12:27:02.468Z"}
```

The write schema (`createProductSchema`) and the DTO are different objects on purpose. The schema accepts `description` and `active` defaults; the DTO always emits every public field. Request and response shapes are allowed to differ (for example, the client never sends `id`, `version`, or timestamps).

### A customer DTO with a derived field

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/customers/cus_acme_01
HTTP/1.1 200 OK
X-Request-Id: d3dc0840-86ee-49f7-8832-b194b10ac4b0
Content-Type: application/json; charset=utf-8
Content-Length: 222
Date: Thu, 29 Oct 2026 12:27:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"cus_acme_01","email":"alice.johnson.1@example.com","name":"Alice Johnson","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}
```

`status` is not a column in the in-memory record; it is computed from `bannedAt`. When the customer is banned (chapter 25d), the same DTO emits `"status":"BANNED"` and a timestamp. Clients do not have to re-implement the derivation.

### Projection is applied after the DTO

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_505be7a1-01de-497f-aae3-ec0ee433c440\?fields=id,name,priceCents
HTTP/1.1 200 OK
X-Request-Id: 3a84f5cc-941a-4020-9555-689cf804cbc4
Content-Type: application/json; charset=utf-8
Content-Length: 272
Date: Thu, 29 Oct 2026 12:27:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_505be7a1-01de-497f-aae3-ec0ee433c440","sku":"LMP-001","slug":"camp-lamp","name":"Camp Lamp","description":null,"priceCents":3499,"currency":"USD","stock":12,"active":true,"version":1,"createdAt":"2026-10-29T12:27:02.468Z","updatedAt":"2026-10-29T12:27:02.468Z"}
```

This is an honest limitation: `fields` is implemented for the collection in chapter 05b, but the single-product route ignores it and returns the full DTO. The request succeeds because `fields` is not part of the item read contract here. If you want sparse fieldsets on item reads, apply `parseFields`/`selectFields` there too — and document it. The important DTO rule is unchanged: projection can only remove public fields, never add internal ones.

Matching `.http` file: [`requests/10-response-shaping-dtos.http`](../requests/10-response-shaping-dtos.http). Full capture: [`transcripts/10-response-shaping-dtos.txt`](../transcripts/10-response-shaping-dtos.txt).

---

## 4. Bad vs good

**Bad — returning the ORM row**

```ts
// DANGER DEMO — DO NOT SHIP
router.get('/:productId', async (req, res) => {
  const row = await prisma.product.findFirst({ where: { id: req.params.productId } });
  res.json(row); // leaks tenantId, deletedAt, internalCost, maybe cost columns
});
```

Problems:

- Adding a column (a secret, a cost, a soft-delete flag) changes the public API automatically.
- `Date` objects may serialize differently depending on the driver; number precision may drift.
- The response shape is coupled to the schema; a migration becomes a breaking API change.
- Internal fields (`internalCost`) become part of the contract; removing them later is breaking.
- The query has no tenant filter at all in this example — a data leak *and* a shape leak.

**Good — explicit mapper**

```ts
const row = await store.findProduct(tenantId, productId); // tenant-scoped first
if (!row) throw notFound('Product not found.');
res.json(productDto(row)); // whitelisted public shape
```

**Trade-offs:**

- **Hand-written DTOs vs generated mappers.** Hand-written is explicit and easy to audit; generated (from Prisma types or OpenAPI) saves typing but can expose new columns by default. This course hand-writes, because the cost of a leak is higher than the cost of a file.
- **Same DTO for list and detail vs separate summary/detail DTOs.** Same shape is simpler for clients; detail DTOs can include expensive relations (order items, customer history) without bloating lists. A common pattern: `ProductSummary` in lists, `Product` in detail, with the summary a subset. This course keeps one `ProductDto`; orders use a richer detail DTO (chapter 25b).
- **Embedding vs references.** Returning `customerId` only forces a second request; embedding a customer object makes payloads bigger and staleness possible. Start with references; add `expand` later if needed (chapter 05b mentions the trade).

---

## 5. In a real multi-tenant e-commerce platform

The warehouse integration calls `GET /products/{id}`. It needs `sku`, `stock`, `active`, `version`. It does not need `internalCost`, and it must never see another tenant's product. The DTO gives it exactly the public fields; the store query scopes by tenant; the path tenant is verified against the token (chapter 17).

The storefront list uses the same `ProductDto`. When the platform later adds a `costCents` column for margin reporting, no API response changes, because the DTO does not include it. When the platform adds `weightGrams`, it appears only after someone deliberately edits `productDto` and updates the docs — an additive change that older clients ignore (chapter 14).

The support console shows `status: BANNED` for a customer. That value is derived in the DTO, so every client agrees on the meaning. If the derivation lived in each client, one screen would say "inactive" and another "blocked".

---

## 6. When to use it and when NOT to

**Use a DTO when:**

- The response is consumed outside the process.
- The stored shape and the public shape can diverge (they always do).
- You need to exclude or derive fields.

**When not to:**

- **Internal function returns inside one service.** Return the domain object; DTOs are a boundary concern.
- **A pure passthrough proxy** where the upstream contract is the contract; even then, strip hop-by-hop headers and unexpected fields.
- **Debug/admin endpoints** guarded by platform roles may expose more, but they still need a named shape, not a raw row with a stack of relations.

**Do not** use a DTO as validation input. Input schemas and output DTOs are different contracts (chapter 09 vs this chapter).

---

## 7. Common mistakes

1. **`res.json(row)`.** The classic leak; every new column is a new public field.
2. **`...row, status`.** Spread plus a field looks whitelisted but is not; the spread carries everything.
3. **Forgetting to convert `Date`.** Serialization depends on the ORM/driver; emit ISO strings explicitly.
4. **Returning `tenantId`.** Clients do not need it (it is in the URL) and it invites confusion.
5. **Different shapes in list and detail.** Forces two parsers and two docs.
6. **Deriving `status` inconsistently.** DTO, search filter, and database must agree on the derivation.
7. **Projection before authorization.** Applying `fields` to a raw row can expose a field that the DTO would have hidden.
8. **DTOs that change with the database.** Any schema change becomes an API change; keep the mapper deliberate.
9. **Including internal IDs of other resources.** `internalCustomerKey` has no business in a public DTO.
10. **No DTO tests.** A snapshot test on `productDto` catches accidental leaks early.

---

## 8. Try it yourself

**Exercise.** The product table gains three columns: `costCents` (integer), `deletedAt` (timestamp, soft delete), and `supplierRef` (string). Without changing the database code:

1. Which of these must **not** appear in `productDto`?
2. Which could appear, and under what conditions?
3. Add `weightGrams` (nullable integer) as a deliberate public field: update the DTO, the schema (if clients can set it), the list field allowlist, and the OpenAPI output.
4. Write a test that fails if `productDto` ever returns a key outside the allowlist.

**Hint.** `costCents` is internal financial data; `supplierRef` is likely internal; `deletedAt` is implementation detail (deleted products should simply 404). `weightGrams` is a legitimate public attribute; add it to `ProductWrite`, `createProductSchema`, `productDto`, `productFields`, and re-run `npm run typecheck` and chapter 21's `/openapi.json`. For the test, compare `Object.keys(productDto(record)).sort()` with an explicit expected array, so any new key forces a deliberate decision.

---

## 9. Next

[11. From in-memory to PostgreSQL + Prisma →](11-postgres-prisma-migration.md)
