# 25a. Pattern: multi-tenant products CRUD

> **Run order:** Prisma server, port 4010, auth on.
>
> Every request below is copied from `transcripts/25a-pattern-products-crud.txt`, captured with `curl` on 2026-10-29. The database was re-seeded before the capture, so `prd_tee` still exists and the generated IDs are the ones shown.

---

## 1. Simple explanation (like I'm 7)

You run a shelf in a shop. You can **put** a new box on the shelf, **look** at one, **change** a label, and **take** a box off. And there are two shops in the building — Acme and Globex — with identical shelves. Your box cannot appear on the other shop's shelf, and looking at the other shop's shelf number must not show you anything.

That is CRUD for products: create, read, update, delete — with a wall between the two shops that never comes down.

---

## 2. Real name

**CRUD** is the four basic operations on a resource: Create (`POST`), Read (`GET`), Update (`PUT`/`PATCH`), Delete (`DELETE`). For products, this slice exercises almost every design decision in the course:

| Operation | Endpoint | Status |
| --- | --- | --- |
| Create | `POST /v1/tenants/{tenantId}/products` | `201` + `Location` |
| Read one | `GET /v1/tenants/{tenantId}/products/{productId}` | `200`, `404` |
| Read many | `GET /v1/tenants/{tenantId}/products` | `200` with `data` + `pagination` |
| Replace | `PUT /v1/tenants/{tenantId}/products/{productId}` | `200`, `412`, `422` |
| Partial update | `PATCH /v1/tenants/{tenantId}/products/{productId}` | `200`, `412`, `422` |
| Delete | `DELETE /v1/tenants/{tenantId}/products/{productId}` | `204`, `404` |

Two product-specific rules matter more than the verbs:

1. **Uniqueness is per tenant, not global.** `sku` and `slug` are unique within a tenant. Acme's `GLOV-001` and Globex's `GLOV-001` are different products and must both be creatable.
2. **Delete is a soft delete.** The row gets `deletedAt`, stays in the database, and disappears from reads, lists, and uniqueness-free space. This preserves order history (order items reference products) and makes the delete reversible — at the cost of the SKU remaining taken.

`sku` is also a stable external key: partners and warehouse systems match on it, so it is immutable in practice even though the schema technically allows a `PUT` to change it.

---

## 3. Example

### The input contract

```ts
// src/schemas/product.ts (excerpt)
export const createProductSchema = z
  .object({
    sku: z.string().trim().min(3).max(40).regex(/^[A-Z0-9-]+$/),
    slug: z.string().trim().min(3).max(80).regex(/^[a-z0-9-]+$/),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable().default(null),
    priceCents: z.number().int().min(0).max(100_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    stock: z.number().int().min(0).max(1_000_000),
    active: z.boolean().default(true),
  })
  .strict();
```

`.strict()` rejects unknown fields (typos in a partner integration fail loudly instead of being silently ignored), the SKU pattern keeps the external key machine-friendly, and money is an integer. This is also the schema the OpenAPI document is generated from (chapter 21).

### Create: the route gets the tenant, the store owns uniqueness

```ts
// src/routes/products.ts (excerpt)
router.post('/', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
  const tenantId = tenantIdOf(req);
  const input = parseInput(createProductSchema, req.body);
  const record = await store.createProduct(tenantId, input);
  const dto = productDto(record);
  noStore(res);
  res.status(201).location(`${req.baseUrl}/${record.id}`).json(dto);
});
```

`tenantIdOf(req)` returns the tenant verified against the token in chapter 17 — never `req.params.tenantId` directly, even though they are equal by the time we get here. `Location` is built from `req.baseUrl`, so it includes the tenant path and is correct behind a proxy that mounts the app at a prefix.

Uniqueness is enforced by the database, not by a read-then-write check:

```ts
// src/store/prisma.ts (excerpt)
async createProduct(tenantId: string, input: ProductWrite): Promise<ProductRecord> {
  try {
    const record = await this.prisma.product.create({
      data: { ...input, id: newId('prd'), tenantId },
    });
    return toProduct(record);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const target = error.meta?.target?.[1];
      throw new HttpProblem(
        409,
        target === 'slug' ? 'slug_taken' : 'sku_taken',
        'That SKU or slug already exists for this tenant.',
      );
    }
    throw error;
  }
}
```

The database constraint is:

```prisma
// prisma/schema.prisma (excerpt)
@@unique([tenantId, sku])
@@unique([tenantId, slug])
```

Prisma's `P2002` violation is translated to a `409` with the specific `code`. No `findFirst` check before `create` — that pattern is racy: two concurrent requests both find nothing and both insert. The constraint is the only correct arbiter.

### Read: tenant in the query, not after it

```ts
// src/store/prisma.ts (excerpt)
async findProduct(tenantId: string, productId: string): Promise<ProductRecord | null> {
  const record = await this.prisma.product.findFirst({
    where: { id: productId, tenantId, deletedAt: null },
  });
  return record ? toProduct(record) : null;
}
```

`tenantId` is part of the `WHERE`, so a foreign ID returns `null` and the route turns that into `404`. Fetching by ID and *then* comparing tenants would leak existence through timing and is easy to forget on a new route.

### Update and delete

`PATCH` only writes fields that were sent (`!== undefined`), `PUT` requires the full schema, and both share the version/`If-Match` machinery from chapter 13c. Delete is one `updateMany` with the tenant and the deleted guard:

```ts
// src/store/prisma.ts (excerpt)
async deleteProduct(tenantId: string, productId: string): Promise<boolean> {
  const result = await this.prisma.product.updateMany({
    where: { id: productId, tenantId, deletedAt: null },
    data: { deletedAt: new Date(), version: { increment: 1 } },
  });
  return result.count > 0;
}
```

`count === 0` covers both "does not exist" and "already deleted", and both answer `404` — a repeated `DELETE` is not an error state worth distinguishing.

### The full lifecycle (actual)

Create:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/products -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{
  "sku": "GLOV-001",
  "slug": "trail-gloves",
  "name": "Trail Gloves",
  "description": "Windproof gloves.",
  "priceCents": 2999,
  "currency": "USD",
  "stock": 20
}'
```

```http
HTTP/1.1 201 Created
X-Request-Id: dc437e0e-6db0-42e5-baa5-308f016581a7
Location: /v1/tenants/ten_acme/products/prd_f4de0e44-5b6f-407a-96f5-f16d28b28640
Content-Type: application/json; charset=utf-8
Content-Length: 294
Date: Thu, 29 Oct 2026 12:30:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_f4de0e44-5b6f-407a-96f5-f16d28b28640","sku":"GLOV-001","slug":"trail-gloves","name":"Trail Gloves","description":"Windproof gloves.","priceCents":2999,"currency":"USD","stock":20,"active":true,"version":1,"createdAt":"2026-10-29T12:30:02.785Z","updatedAt":"2026-10-29T12:30:02.785Z"}
```

`active` was defaulted to `true` (chapter 21 showed why it is not in the OpenAPI `required` list). `version` starts at 1.

Read it back:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/products/prd_f4de0e44-5b6f-407a-96f5-f16d28b28640 -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 695f07d0-0ffd-4118-a629-1118ce22447a
Content-Type: application/json; charset=utf-8
Content-Length: 294
Date: Thu, 29 Oct 2026 12:30:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_f4de0e44-5b6f-407a-96f5-f16d28b28640","sku":"GLOV-001","slug":"trail-gloves","name":"Trail Gloves","description":"Windproof gloves.","priceCents":2999,"currency":"USD","stock":20,"active":true,"version":1,"createdAt":"2026-10-29T12:30:02.785Z","updatedAt":"2026-10-29T12:30:02.785Z"}
```

The body is byte-identical to the create response — same DTO, no `Location` this time.

Patch one field:

```console
$ curl -sS -i --request PATCH http://localhost:4010/v1/tenants/ten_acme/products/prd_f4de0e44-5b6f-407a-96f5-f16d28b28640 -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "name": "Trail Gloves (2026)" }'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 0523d550-8eb2-4c31-aa31-e4521492abe3
Content-Type: application/json; charset=utf-8
Content-Length: 301
Date: Thu, 29 Oct 2026 12:30:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_f4de0e44-5b6f-407a-96f5-f16d28b28640","sku":"GLOV-001","slug":"trail-gloves","name":"Trail Gloves (2026)","description":"Windproof gloves.","priceCents":2999,"currency":"USD","stock":20,"active":true,"version":2,"createdAt":"2026-10-29T12:30:02.785Z","updatedAt":"2026-10-29T12:30:02.809Z"}
```

Only `name`, `version`, and `updatedAt` moved. `version` is 2 — the value a client needs for `If-Match` on the next write (chapter 13c).

Duplicate SKU in the same tenant:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/products -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{
  "sku": "GLOV-001",
  "slug": "gloves-two",
  "name": "Gloves Two",
  "priceCents": 2999,
  "currency": "USD",
  "stock": 5
}'
```

```http
HTTP/1.1 409 Conflict
X-Request-Id: e8cdac1f-27f5-4ba4-82ea-e86647372ef0
Content-Type: application/problem+json; charset=utf-8
Content-Length: 209
Date: Thu, 29 Oct 2026 12:30:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/sku_taken","title":"Conflict","status":409,"detail":"That SKU or slug already exists for this tenant.","instance":"/v1/tenants/ten_acme/products","code":"sku_taken"}
```

Same SKU in the other tenant — allowed:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_globex/products -H 'Authorization: Bearer tok_globex_admin' -H 'Content-Type: application/json' --data-binary '{
  "sku": "GLOV-001",
  "slug": "globex-gloves",
  "name": "Globex Gloves",
  "priceCents": 2799,
  "currency": "EUR",
  "stock": 5
}'
```

```http
HTTP/1.1 201 Created
X-Request-Id: 4570e92f-d780-4602-b24d-a646d5001216
Location: /v1/tenants/ten_globex/products/prd_3ea85111-2f71-4299-a0d2-62cc5baf48e6
Content-Type: application/json; charset=utf-8
Content-Length: 280
Date: Thu, 29 Oct 2026 12:30:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_3ea85111-2f71-4299-a0d2-62cc5baf48e6","sku":"GLOV-001","slug":"globex-gloves","name":"Globex Gloves","description":null,"priceCents":2799,"currency":"EUR","stock":5,"active":true,"version":1,"createdAt":"2026-10-29T12:30:02.870Z","updatedAt":"2026-10-29T12:30:02.870Z"}
```

This is the whole per-tenant uniqueness rule in one response.

Cross-tenant read with the Acme product's ID:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_globex/products/prd_f4de0e44-5b6f-407a-96f5-f16d28b28640 -H 'Authorization: Bearer tok_globex_admin'
```

```http
HTTP/1.1 404 Not Found
X-Request-Id: 2e26a5d6-7c7b-4e16-b129-1c0e75a5ce7b
Content-Type: application/problem+json; charset=utf-8
Content-Length: 223
Date: Thu, 29 Oct 2026 12:30:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"Product not found.","instance":"/v1/tenants/ten_globex/products/prd_f4de0e44-5b6f-407a-96f5-f16d28b28640","code":"not_found"}
```

`404`, not `403`: the token legitimately belongs to Globex and the path matches it, so the only true statement is "this product does not exist in Globex". A `403` would confirm that the ID exists elsewhere.

Delete, then read:

```console
$ curl -sS -i --request DELETE http://localhost:4010/v1/tenants/ten_acme/products/prd_f4de0e44-5b6f-407a-96f5-f16d28b28640 -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 204 No Content
X-Request-Id: 0d9dde14-e3d3-4c2c-a79f-c960cceb9a92
Date: Thu, 29 Oct 2026 12:30:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5
```

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/products/prd_f4de0e44-5b6f-407a-96f5-f16d28b28640 -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 404 Not Found
X-Request-Id: 816f292f-6823-45ee-bf6f-581014db836d
Content-Type: application/problem+json; charset=utf-8
Content-Length: 221
Date: Thu, 29 Oct 2026 12:30:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"Product not found.","instance":"/v1/tenants/ten_acme/products/prd_f4de0e44-5b6f-407a-96f5-f16d28b28640","code":"not_found"}
```

Recreate with the same SKU after the delete:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/products -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{
  "sku": "GLOV-001",
  "slug": "gloves-again",
  "name": "Gloves Again",
  "priceCents": 2999,
  "currency": "USD",
  "stock": 5
}'
```

```http
HTTP/1.1 409 Conflict
X-Request-Id: 9c54b0c2-9055-4703-880c-ab1d6d864f9d
Content-Type: application/problem+json; charset=utf-8
Content-Length: 209
Date: Thu, 29 Oct 2026 12:30:02 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/sku_taken","title":"Conflict","status":409,"detail":"That SKU or slug already exists for this tenant.","instance":"/v1/tenants/ten_acme/products","code":"sku_taken"}
```

The 409 proves the soft-deleted row still owns the SKU. That is a design decision, not a bug: the delete removed the product from the catalog, not from history, and the composite unique index does not know about `deletedAt`.

---

## 4. Bad vs good

**Bad:** check-then-insert.

```ts
// Bad: racy, and the check is per-process
const existing = await prisma.product.findFirst({ where: { tenantId, sku: input.sku } });
if (existing) throw new HttpProblem(409, 'sku_taken', '...');
await prisma.product.create({ data: { ...input, tenantId } });
```

Two concurrent creaters both see nothing, both insert, and the tenant gets duplicate SKUs. The window is milliseconds locally and hours under load.

**Good:** let the database decide, translate the violation.

```ts
// Good: src/store/prisma.ts
@@unique([tenantId, sku])
// ...
catch (error) {
  if (isUniqueViolation(error)) throw new HttpProblem(409, target === 'slug' ? 'slug_taken' : 'sku_taken', '...');
  throw error;
}
```

**Bad:** fetch, then filter by tenant in application code.

```ts
// Bad: existence oracle + easy to forget
const product = await prisma.product.findUnique({ where: { id: productId } });
if (!product || product.tenantId !== tenantId) throw notFound('Product not found.');
```

It works, but it reads data the caller may not see, and every new route must remember the second check. One forgotten check is a breach.

**Good:** tenant in the query.

```ts
// Good
await prisma.product.findFirst({ where: { id: productId, tenantId, deletedAt: null } });
```

**Bad:** hard delete.

```ts
// Bad: order_items still reference this product's id
await prisma.product.delete({ where: { id: productId } });
```

The foreign key from `OrderItem` fails (or, worse, cascades and rewrites history). The product vanishes from a past order's item row in any join-based read.

**Good:** soft delete, with the trade-off made explicit.

```ts
// Good
data: { deletedAt: new Date(), version: { increment: 1 } }
```

The row stays, history stays consistent, reads filter `deletedAt: null`. The cost is a decision you must make consciously: **the SKU stays taken**. That is what the last request above shows. If your business needs SKUs to be reusable, the unique index must become partial (`WHERE deleted_at IS NULL`) or the SKU must be renamed on delete — both are schema decisions, not route decisions.

---

## 5. In a real multi-tenant e-commerce platform

Acme's warehouse imports 400 products every morning and uses `sku` as the join key. Globex buys the same supplier catalog and uses the same SKUs. With `@@unique([tenantId, sku])`, both imports succeed and neither warehouse sees the other's rows.

A partner reads a product by ID from an old CSV. If Acme deleted it, the partner gets `404`; if the partner's ID belonged to Globex, it also gets `404`. The API never confirms that an ID exists outside the caller's tenant.

A support agent "deletes" a product that was in 300 past orders. Orders keep rendering, because `OrderItem` stored `sku`, `name`, and `unitPriceCents` snapshots (chapter 11) and still references the product row. If the product is restored by clearing `deletedAt`, it reappears everywhere with its version incremented.

The `Location` header matters here too: a partner's importer follows it to fetch the created product, so the header must be a full, tenant-correct path, not `/products/{id}`.

---

## 6. When to use it and when NOT

**Use this slice as-is when:**

- The resource is tenant-owned and CRUD-shaped (most catalog data).
- External systems need stable keys (`sku`, `slug`) that are unique per tenant.
- Deleting data would break references from historical records.

**Do not copy it blindly when:**

- **Hard delete is genuinely required** (GDPR "right to erasure" for a customer's uploaded file, for example). Then you need a purge job and a plan for references — soft delete is not erasure.
- **The resource has a lifecycle, not just CRUD.** Orders (25b) and bans (25d) are state machines; a generic `PATCH /orders` that lets a client set `status` would bypass every rule in the service layer.
- **Uniqueness is global by design.** A platform-wide tenant slug is unique across tenants, not per tenant; do not copy the composite key pattern without deciding.
- **You need bulk creation.** A loop of `POST`s is 400 requests; chapter 13b's bulk endpoint exists for that reason.

---

## 7. Common mistakes

1. **Checking uniqueness in application code.** Racy; the database constraint is the only correct check.
2. **Global unique index on `sku`.** Acme cannot have `MUG-001` because Globex does. Uniqueness must include `tenantId`.
3. **Fetch-then-compare tenant.** Leaks existence and is forgettable on new routes; filter in the query.
4. **`403` for a foreign ID.** Confirms the resource exists. Use `404`.
5. **Hard delete with references.** Breaks order history or cascades it away.
6. **Forgetting `deletedAt: null` in list, read, *and* update paths.** The product "disappears" from reads but a `PATCH` still finds it — or vice versa.
7. **Returning the ORM row.** Leaks columns and freezes your schema to the table (chapter 10). Use `productDto`.
8. **Returning `200` on create.** Loses the idempotent `Location` + body convention; clients must guess the new ID.
9. **Mutating `sku` on `PUT`.** Partners key on it; treat it as immutable in the public contract even if the schema allows a change.
10. **`204` with a body.** Some proxies strip it; the spec says no content. If the client needs the deleted state, return `200` with a representation instead.

---

## 8. Try it yourself

Add **restore** for a soft-deleted product: `POST /v1/tenants/{tenantId}/products/{productId}/restore`.

Requirements:

1. Restores only a product in this tenant whose `deletedAt` is not null; anything else is `404` with `not_found`.
2. Returns `200` with the product DTO, `version` incremented, and `deletedAt` gone from the response.
3. Is idempotent: restoring an already-active product returns `200` with the unchanged DTO rather than an error.
4. Updates the OpenAPI document and the `.http` request file.

**Hint:** mirror `deleteProduct` with `updateMany({ where: { id, tenantId, deletedAt: { not: null } }, data: { deletedAt: null, version: { increment: 1 } } })`. `count === 0` is ambiguous — it means either "not found" or "already active" — so read the product first with a tenant-scoped query that ignores `deletedAt`, then decide: missing → `404`, `deletedAt === null` → return unchanged, otherwise update. The last request in the transcript is the one to think about: the SKU is still taken, so restore is the only way back for that SKU, which is exactly why the endpoint is worth having.

---

## 9. Next

Orders add the hard parts: price snapshots, stock decrements, transactions, and idempotent creation.

Next: [25b. Pattern: create an order with an idempotency key](25b-pattern-order-idempotency.md)
