# 11. From in-memory to PostgreSQL + Prisma

> **Run order:** Prisma server, port 4010, auth off, cache off. Requires the throwaway database from `docker-compose.yml` (PostgreSQL 17 on port 5434, database `api_learn`).
>
> Every request below is copied from `transcripts/11-postgres-prisma-migration.txt`, captured with `curl` on 2026-10-29, including the direct `psql` inspection appended at the end.

---

## 1. Simple explanation (like I'm 7)

Until now your data lived in a **whiteboard** in the classroom. Fast to write on, but if the teacher closes the window, everything is gone, and two children writing at the same time cannot see each other's changes.

Now you get a **real filing cabinet** with rules printed inside: "two folders cannot have the same label", "a page about an order may only point to a customer in the same cabinet", "if a cabinet is removed, its folders go too".

The API does not change its shape. The storefront still asks the same questions. Only the place where answers are kept becomes durable, shared, and rule-enforcing.

---

## 2. Real name

A **database** stores the data durably and enforces **constraints** (uniqueness, foreign keys, transactions). An **ORM** (Prisma) maps tables to typed objects and generates SQL. A **migration** is a versioned, reviewed SQL change applied in order.

Why move here now? Chapters 1–10 were about the HTTP contract. Starting with chapter 12 (idempotency, concurrency, orders, coupons, webhooks) you need things an in-memory array cannot give honestly:

| Need | In-memory array | PostgreSQL |
| --- | --- | --- |
| Survive a restart | no | yes |
| Two requests writing at once | last write wins silently | transactions, row locks, conditional updates |
| Uniqueness | a hand-written check with a race | `UNIQUE` constraint |
| Cross-entity integrity | nothing | composite foreign keys |
| "Did this exact retry already run?" | lost on restart | durable key table |

The three rules of this migration:

1. **The API contract does not change.** Same URLs, same DTOs, same status codes. A storage swap is not a version bump.
2. **Tenant isolation becomes a database constraint**, not only a `WHERE` clause. Composite keys `(tenantId, id)` let foreign keys refuse cross-tenant links even if application code has a bug.
3. **The database is throwaway.** It listens on port 5434 (not 5432), only on localhost, with a safety gate in `prisma.config.ts`.

---

## 3. Example

### Schema: tenant column everywhere, composite keys for integrity

```prisma
// prisma/schema.prisma (excerpt, comments added)
model Product {
  id         String    @id
  tenantId   String    @map("tenant_id") @db.VarChar(30)
  sku        String    @db.VarChar(40)
  // ...
  version    Int       @default(1)
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt  DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)
  deletedAt  DateTime? @map("deleted_at") @db.Timestamptz(3) // soft delete

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, sku])          // SKU is unique per tenant, not globally
  @@unique([tenantId, slug])
  @@unique([tenantId, id])           // lets other tables reference (tenant, id)
  @@index([tenantId, createdAt, id]) // matches the list + cursor query
  @@index([tenantId, active, priceCents])
  @@map("products")
}

model OrderItem {
  id             String @id
  tenantId       String @map("tenant_id")
  orderId        String @map("order_id")
  productId      String @map("product_id")
  skuSnapshot    String @map("sku_snapshot")   // price/name frozen at purchase
  nameSnapshot   String @map("name_snapshot")
  unitPriceCents Int    @map("unit_price_cents")
  quantity       Int
  lineTotalCents Int    @map("line_total_cents")

  order   Order   @relation(fields: [tenantId, orderId], references: [tenantId, id], onDelete: Cascade)
  product Product @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: Restrict)
  @@index([tenantId, orderId])
  @@map("order_items")
}
```

`@@unique([tenantId, sku])` means two tenants may both own `TEE-001`. `@@unique([tenantId, id])` is redundant as a key but required as a **reference target**: a foreign key can only point at a unique combination. The resulting database refuses to attach an order item from tenant A to an order from tenant B, even if a service forgets a filter.

### A safety gate before any destructive Prisma command

```ts
// prisma.config.ts (excerpt)
const url = new URL(connectionString);
if (
  url.protocol !== 'postgres:' ||
  !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
  url.port !== '5434' ||
  url.pathname !== '/api_learn' ||
  url.username !== 'postgres'
) {
  throw new Error('REFUSING TO RUN: this project only talks to the throwaway database on localhost:5434/api_learn');
}
```

Every `db:*` script first runs `scripts/preflight.mjs`, and `prisma.config.ts` re-checks the URL. A copied `.env` pointing at a real database fails loudly instead of migrating it.

### The store interface stays the same

```ts
// src/store/types.ts (excerpt)
export type Store = {
  listProducts(tenantId: string, options: ProductListOptions): Promise<ListResult<ProductRecord>>;
  findProduct(tenantId: string, productId: string): Promise<ProductRecord | null>;
  createProduct(tenantId: string, input: ProductWrite): Promise<ProductRecord>;
  // ...
};
```

Routes depend on `Store`, not on Prisma. `MemoryStore` implements it for chapters 1–10; `PrismaStore` implements it now. The only thing that changes in `app.ts` is which implementation is passed in.

### Tenant filter inside the query, not after it

```ts
// src/store/prisma.ts (excerpt)
async findProduct(tenantId: string, productId: string): Promise<ProductRecord | null> {
  const record = await this.prisma.product.findFirst({
    where: { id: productId, tenantId, deletedAt: null },
  });
  return record ? toProduct(record) : null;
}
```

A missing `tenantId` here is a data leak, so it is part of the same `where` object and covered by a database index.

### Requests against the database-backed server

The contract is exactly the one from earlier chapters:

```console
$ curl -sS -i --request GET http://localhost:4010/health
HTTP/1.1 200 OK
X-Request-Id: 0f35eb5e-fd78-4ff8-8de2-4b5de2e04f8e
Content-Type: application/json; charset=utf-8
Content-Length: 15
Date: Thu, 29 Oct 2026 12:27:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"status":"ok"}
```

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_acme/products\?limit=2\&sort=createdAt
HTTP/1.1 200 OK
X-Request-Id: 56cfef2d-6fd7-4b25-a816-dfab60a0580f
Content-Type: application/json; charset=utf-8
Content-Length: 665
Date: Thu, 29 Oct 2026 12:27:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:11.502Z"},{"id":"prd_mug","sku":"MUG-001","slug":"camp-mug","name":"Camp Mug","description":"Enamel mug, 350 ml.","priceCents":1299,"currency":"USD","stock":120,"active":true,"version":1,"createdAt":"2026-01-01T10:00:00.000Z","updatedAt":"2026-10-29T12:27:11.502Z"}],"pagination":{"limit":2,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDEwOjAwOjAwLjAwMFoiLCJpZCI6InByZF9tdWcifQ"}}
```

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_acme/customers\?limit=2\&sort=createdAt
HTTP/1.1 200 OK
X-Request-Id: 45ef4421-8d01-45a6-85eb-c8df192577e8
Content-Type: application/json; charset=utf-8
Content-Length: 583
Date: Thu, 29 Oct 2026 12:27:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"cus_acme_01","email":"alice.johnson.1@example.com","name":"Alice Johnson","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:11.511Z"},{"id":"cus_acme_02","email":"bob.smith.2@example.com","name":"Bob Smith","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-02T09:00:00.000Z","updatedAt":"2026-10-29T12:27:11.511Z"}],"pagination":{"limit":2,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAyVDA5OjAwOjAwLjAwMFoiLCJpZCI6ImN1c19hY21lXzAyIn0"}}
```

An order with its line items, read through a join:

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_acme/orders/ord_demo_pending
HTTP/1.1 200 OK
X-Request-Id: add38e47-a028-498d-a340-5c58848b411e
Content-Type: application/json; charset=utf-8
Content-Length: 385
Date: Thu, 29 Oct 2026 12:27:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"ord_demo_pending","status":"PENDING","customerId":"cus_acme_03","items":[{"productId":"prd_hoodie","sku":"HOO-001","name":"Trail Hoodie","unitPriceCents":4999,"quantity":1,"lineTotalCents":4999}],"subtotalCents":4999,"discountCents":0,"totalCents":4999,"currency":"USD","couponCode":null,"version":1,"createdAt":"2026-01-20T09:00:00.000Z","updatedAt":"2026-10-29T12:27:11.523Z"}
```

The database row has `tenant_id`, `idempotency_key_id`, and other internals. The DTO (chapter 10) does not.

The same order id under another tenant in the path is not found — not forbidden, not leaked:

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_globex/orders/ord_demo_pending
HTTP/1.1 404 Not Found
X-Request-Id: 1a024935-a613-49d5-8cbe-d8cd416535b7
Content-Type: application/problem+json; charset=utf-8
Content-Length: 196
Date: Thu, 29 Oct 2026 12:27:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"Order not found.","instance":"/api/tenants/ten_globex/orders/ord_demo_pending","code":"not_found"}
```

### What is actually in the database

```console
$ docker exec api-learn-db psql -U postgres -d api_learn -c '\dt'
               List of relations
 Schema |        Name        | Type  |  Owner   
--------+--------------------+-------+----------
 public | _prisma_migrations | table | postgres
 public | coupon_redemptions | table | postgres
 public | coupons            | table | postgres
 public | customers          | table | postgres
 public | fraud_events       | table | postgres
 public | idempotency_keys   | table | postgres
 public | operations         | table | postgres
 public | order_items        | table | postgres
 public | orders             | table | postgres
 public | payments           | table | postgres
 public | products           | table | postgres
 public | tenants            | table | postgres
 public | uploads            | table | postgres
 public | webhook_deliveries | table | postgres
 public | webhook_endpoints  | table | postgres
(15 rows)
```

```console
$ docker exec api-learn-db psql -U postgres -d api_learn -c '\d order_items'
                         Table "public.order_items"
      Column      |          Type          | Collation | Nullable | Default 
------------------+------------------------+-----------+----------+---------
 id               | character varying(50)  |           | not null | 
 tenant_id        | character varying(30)  |           | not null | 
 order_id         | character varying(50)  |           | not null | 
 product_id       | character varying(50)  |           | not null | 
 sku_snapshot     | character varying(40)  |           | not null | 
 name_snapshot    | character varying(200) |           | not null | 
 unit_price_cents | integer                |           | not null | 
 quantity         | integer                |           | not null | 
 line_total_cents | integer                |           | not null | 
Indexes:
    "order_items_pkey" PRIMARY KEY, btree (id)
    "order_items_tenant_id_order_id_idx" btree (tenant_id, order_id)
Foreign-key constraints:
    "order_items_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE CASCADE
    "order_items_tenant_id_order_id_fkey" FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON UPDATE CASCADE ON DELETE CASCADE
    "order_items_tenant_id_product_id_fkey" FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
```

The two composite foreign keys are the point: `(tenant_id, order_id)` and `(tenant_id, product_id)`. One `tenant_id` column is shared by both references, so an order item cannot straddle tenants.

```console
$ docker exec api-learn-db psql -U postgres -d api_learn -c '\d idempotency_keys'
                            Table "public.idempotency_keys"
    Column     |            Type             | Collation | Nullable |      Default      
---------------+-----------------------------+-----------+----------+-------------------
 id            | character varying(50)       |           | not null | 
 tenant_id     | character varying(30)       |           | not null | 
 key           | character varying(200)      |           | not null | 
 request_hash  | character varying(64)       |           | not null | 
 method        | character varying(10)       |           | not null | 
 path          | character varying(300)      |           | not null | 
 status_code   | integer                     |           |          | 
 response_body | jsonb                       |           |          | 
 created_at    | timestamp(3) with time zone |           | not null | CURRENT_TIMESTAMP
 expires_at    | timestamp(3) with time zone |           | not null | 
Indexes:
    "idempotency_keys_pkey" PRIMARY KEY, btree (id)
    "idempotency_keys_tenant_id_expires_at_idx" btree (tenant_id, expires_at)
    "idempotency_keys_tenant_id_key_key" UNIQUE, btree (tenant_id, key)
Foreign-key constraints:
    "idempotency_keys_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE CASCADE
```

That `UNIQUE (tenant_id, key)` is what makes idempotency safe against two simultaneous retries (chapter 12). One index supports both "look up this key" and expiry cleanup.

```console
$ docker exec api-learn-db psql -U postgres -d api_learn -c 'select migration_name from _prisma_migrations order by started_at;'
   migration_name    
---------------------
 20261029121154_init
(1 row)
```

Matching `.http` file: [`requests/11-postgres-prisma-migration.http`](../requests/11-postgres-prisma-migration.http). Full capture: [`transcripts/11-postgres-prisma-migration.txt`](../transcripts/11-postgres-prisma-migration.txt).

---

## 4. Bad vs good

**Bad — tenant filter applied in application code after fetching**

```ts
// DANGER DEMO — DO NOT SHIP
const products = await prisma.product.findMany(); // every tenant's data
const mine = products.filter((p) => p.tenantId === tenantId);
res.json({ data: mine.map(productDto) });
```

Problems:

- Every request reads the whole table; cost and latency grow with the platform, not the tenant.
- One early `return` or refactor that skips the filter leaks all tenants.
- Cross-tenant references are still possible: nothing prevents a new row pointing at another tenant's product.
- No composite index is used; the list query cannot be paginated efficiently.

**Good — tenant in the query and in the schema**

```ts
const record = await prisma.product.findFirst({ where: { id, tenantId, deletedAt: null } });
```

plus `@@unique([tenantId, id])` so foreign keys can be composite. Defense in depth: a bug in one layer is caught by the other.

**Other trade-offs:**

- **ORM vs raw SQL.** Prisma gives typed queries, migrations, and a readable schema; raw SQL gives full control over locks, `FOR UPDATE`, and query plans. This course uses Prisma plus a few "conditional update" patterns (`updateMany` with a version/stock predicate) to express atomicity without dropping to SQL.
- **Soft delete vs hard delete.** `deletedAt` keeps order history intact and makes `DELETE` repeatable; it also means every query needs `deletedAt: null`. Hard delete is simpler but destroys auditability and breaks order references.
- **Snapshot columns vs joins.** `order_items` copies name, SKU, and price at purchase time. Joining the live product would make past invoices change when a product is renamed. Storage is cheap; historical correctness is not.
- **One database vs database per tenant.** One database with a `tenantId` column is simpler and cheaper at this scale; database-per-tenant gives stronger isolation but multiplies migrations and connections. Chapter 17 covers the trust boundary; here the column plus row-level checks is the model.
- **Prisma 7 `prisma-client` generator vs legacy `prisma-client-js`.** The newer generator emits plain TypeScript into `src/generated/prisma` and requires a driver adapter (`@prisma/adapter-pg`), which is what `src/db.ts` does. The legacy generator is still supported but is the older setup; this project uses the current one.

---

## 5. In a real multi-tenant e-commerce platform

The storefront, warehouse, and support console all hit the same API. At 09:00 a flash sale starts: thousands of order creations arrive. A single Node process cannot serialize them, but PostgreSQL can:

- Each order creation runs in a transaction. Stock is decremented with a **conditional update** (`WHERE stock >= qty`), so two buyers cannot both take the last hoodie.
- Idempotent retries hit `UNIQUE (tenant_id, key)` and return the stored response instead of creating a second order.
- The admin list query uses `(tenant_id, created_at, id)`, so tenant A's 2 million products do not slow tenant B's page.
- A support agent pasting a Globex order id into Acme's console gets 404, because the query includes `tenantId`.

The migration itself is operational: `npm run db:migrate` creates a versioned SQL file, reviewed like code; `npm run db:deploy` applies it in staging and production. The throwaway database here keeps the exercises safe; the same schema patterns are what you would review in a production pull request.

---

## 6. When to use it and when NOT to

**Use a real database when:**

- Data must survive restarts or be shared between processes.
- You need uniqueness, referential integrity, or transactions.
- More than one writer can touch the same row.
- You need audit/history (snapshots, idempotency records, events).

**When not to (yet):**

- **Learning the HTTP contract.** Chapters 1–10 are easier without migrations; the in-memory store isolates API design from storage.
- **Prototypes and throwaway fixtures** where losing data is fine.
- **Read-only reference data** that can live in code.

**Do not** use an ORM as a substitute for API design. The DTO, status codes, and tenant rules are still your responsibility; Prisma will happily return a cross-tenant row if you forget the filter.

---

## 7. Common mistakes

1. **Forgetting `tenantId` in one query.** One missing filter is a cross-tenant leak; use composite constraints as a backstop and review every `findFirst`/`findMany`.
2. **Global unique constraints.** `@unique` on `sku` blocks two tenants from selling the same SKU; use `@@unique([tenantId, sku])`.
3. **No composite reference target.** Adding `(tenantId, orderId)` foreign keys fails unless `orders` has `@@unique([tenantId, id])`.
4. **Migrations edited after being applied.** Write a new migration; never rewrite history that other environments already ran.
5. **Running `prisma migrate reset` against a real database.** This project's port/name gate exists for exactly that; keep such guards in every project.
6. **Joining live product data into old orders.** Store snapshots; prices and names change.
7. **Filtering after fetching.** Push the tenant filter into SQL and index it.
8. **Ignoring transaction boundaries.** Creating an order and its items in separate, unguarded writes leaves half-orders on failure.
9. **Leaking raw errors.** A unique-violation `P2002` must become a 409 problem (chapter 8), not a 500 with SQL text.
10. **No seed script.** Every developer needs the same baseline; `npm run db:seed` is part of the setup.
11. **Mixing environments.** A `.env` copied from production is a loaded gun; the safety gate is not optional.
12. **Indexing everything.** Indexes cost writes; add the ones that match real query shapes (`tenantId, createdAt, id` first).

---

## 8. Try it yourself

**Exercise.** A new table `Supplier` is added. A supplier belongs to one tenant, and a product may have an optional supplier.

1. Write the Prisma model. It needs `tenantId`, an id, and a per-tenant unique supplier code.
2. Add `supplierId String?` to `Product` so that a product can only reference a supplier **in the same tenant**. Which unique key must `Supplier` have, and what does the relation look like?
3. List the index you would add for a screen that shows "products by supplier, newest first".
4. Write the migration command you would run, and the command you would never run against this database.

**Hint.** Mirror `Order` → `OrderItem`: `@@unique([tenantId, id])` on `Supplier`, then `@relation(fields: [tenantId, supplierId], references: [tenantId, id])`. The index is `@@index([tenantId, supplierId, createdAt, id])`. Use `npm run db:migrate -- --name add_supplier`; never `db:reset` or a URL outside localhost:5434/api_learn (the preflight and `prisma.config.ts` will refuse). Verify the result with `docker exec api-learn-db psql -U postgres -d api_learn -c '\d suppliers'`.

---

## 9. Next

[12. Idempotency keys →](12-idempotency-keys.md)
