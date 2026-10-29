# 25b. Pattern: create an order with an idempotency key

> **Run order:** Prisma server, port 4010, auth on.
>
> Every request below is copied from `transcripts/25b-pattern-order-idempotency.txt`, captured with `curl` on 2026-10-29. The database was re-seeded before the capture.

---

## 1. Simple explanation (like I'm 7)

You call a shop and say "one shirt and two mugs, please." The line goes quiet. You do not know if the order went through. So you call again and say exactly the same thing — and the shop must **not** put a second box on the van.

The trick: you give every order a **name tag** (a key). The shop writes the tag on the first order. If the same tag arrives again, the shop does not make a new order — it hands you the receipt for the one it already made. If the same tag arrives with a *different* order on it, the shop says "something is wrong, I cannot do that" instead of guessing.

That is an idempotency key. It makes retrying safe, which is the only way to be sure an order exists when the network is unreliable.

---

## 2. Real name

An **idempotency key** is a client-generated unique string sent with an unsafe request (`POST`) that lets the server recognize retries. The server stores the key together with a fingerprint of the request and the response it produced. On a repeat:

- same key, same request → **replay** the stored response, do not execute again;
- same key, different request → **`409`** conflict, do not execute;
- same key while the first is still running → **`409`** in progress;
- no key on a required endpoint → **`400`**.

For order creation this protects four things at once:

1. **Double orders.** A retry after a timeout creates at most one order.
2. **Double stock decrements.** The decrement happens inside the executed transaction, so a replay does not touch stock.
3. **Double charges.** Payments use the same mechanism (chapter 12), so a retried payment records one payment.
4. **Double webhooks.** `order.created` is delivered only on the first execution — the route checks `result.replayed` before calling `deliverEvent` (chapter 20).

Additionally, an order is a **snapshot**, not a view over current catalog data:

- each `OrderItem` stores `skuSnapshot`, `nameSnapshot`, and `unitPriceCents` at creation time;
- totals are stored in integer minor units;
- the product's stock is decremented **conditionally**, so concurrent orders cannot oversell.

The result is an order you can still explain a year later, even if the product was renamed, repriced, or deleted.

---

## 3. Example

### The header is mandatory and validated

```ts
// src/routes/orders.ts (excerpt)
function idempotencyKeyFrom(req: Parameters<typeof tenantIdOf>[0]): string {
  const header = req.get('idempotency-key');
  if (!header) {
    throw new HttpProblem(
      400,
      'idempotency_key_required',
      'Send an Idempotency-Key header so a retry cannot create a duplicate.',
    );
  }
  return parseInput(idempotencyKeySchema, header);
}
```

`idempotencyKeySchema` bounds the length (8–200) and the character set (`A-Z a-z 0-9 . _ : -`), so a key cannot smuggle control characters into logs or into the unique index. Missing key is `400` — a client error in the request shape — not `422`, which is reserved for a well-formed body that failed validation.

### The order body

```ts
// src/schemas/commerce.ts (excerpt)
export const createOrderSchema = z
  .object({
    customerId: z.string().min(1),
    items: z
      .array(
        z
          .object({
            productId: z.string().min(1),
            quantity: z.number().int().min(1).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
```

Two bounds carry business meaning: at most 99 of a single product and at most 20 lines. They exist to keep one request from being a denial-of-service vector and to fail obviously invalid input before any database work (the transcript below shows the `999` case).

### The transaction

```ts
// src/services/orders.ts (excerpt)
return runIdempotent(prisma, {
  tenantId: input.tenantId,
  key: input.idempotencyKey,
  method: 'POST',
  path: input.path,
  body: input.body,
  execute: async (idempotencyRowId) => {
    const order = await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: input.body.customerId, tenantId: input.tenantId },
      });
      if (!customer) throw new HttpProblem(422, 'invalid_customer', 'Customer does not exist for this tenant.');
      if (customer.bannedAt) {
        throw new HttpProblem(409, 'customer_banned', 'Banned customers cannot place new orders.');
      }

      const productIds = [...quantities.keys()];
      const products = await tx.product.findMany({
        where: { tenantId: input.tenantId, id: { in: productIds }, deletedAt: null },
      });
      if (products.length !== productIds.length) {
        throw new HttpProblem(422, 'invalid_product', 'One or more products do not exist for this tenant.');
      }
      // ...active and currency checks, line totals...
```

Three decisions are visible in this fragment:

- **The customer is checked inside the transaction**, in the same tenant. A banned customer is `409` (the request is well-formed but the current state forbids it), an unknown customer is `422` (a reference in the body is wrong).
- **All products must exist** before any line is priced; a partial order is never priced.
- **The `idempotencyRowId` is passed in** so the order row can point at the key that created it (`order.idempotencyKeyId`), which is what makes the audit trail complete.

Stock is reserved with a conditional update, not a read-then-write:

```ts
// src/services/orders.ts (excerpt)
// Conditional decrement prevents overselling under concurrency.
for (const line of lines) {
  const reserved = await tx.product.updateMany({
    where: {
      id: line.product.id,
      tenantId: input.tenantId,
      deletedAt: null,
      active: true,
      stock: { gte: line.quantity },
    },
    data: { stock: { decrement: line.quantity }, version: { increment: 1 } },
  });
  if (reserved.count === 0) {
    throw new HttpProblem(409, 'insufficient_stock', `Not enough stock for ${line.product.id}.`);
  }
}
```

The `stock: { gte: quantity }` predicate is the whole concurrency guarantee. Two simultaneous orders for the last unit both run this statement; the database serializes them, one gets `count: 1`, the other gets `count: 0` and the transaction rolls back — including any earlier decrements in that order. There is no window between "check stock" and "decrement stock" for a third request to slip into.

Snapshots are written in the same transaction:

```ts
// src/services/orders.ts (excerpt)
await tx.orderItem.createMany({
  data: lines.map((line) => ({
    id: newId('oit'),
    tenantId: input.tenantId,
    orderId,
    productId: line.product.id,
    skuSnapshot: line.product.sku,
    nameSnapshot: line.product.name,
    unitPriceCents: line.product.priceCents,
    quantity: line.quantity,
    lineTotalCents: line.lineTotalCents,
  })),
});
```

The order is now self-contained. Reading it never joins to `products` for price or name.

### The route replays and suppresses duplicate events

```ts
// src/routes/orders.ts (excerpt)
const result = await createOrder(prisma, { tenantId, idempotencyKey: key, path: ..., body });

if (result.replayed) res.set('Idempotent-Replayed', 'true');
res.set('Cache-Control', 'no-store');
const order = result.body as { id: string };
res.status(result.status).location(`${req.baseUrl}/${order.id}`).json(result.body);

if (!result.replayed) {
  void deliverEvent(prisma, tenantId, 'order.created', { orderId: order.id, ... });
}
```

`Idempotent-Replayed: true` is not required by any RFC; it is a deliberate signal for operators and tests ("this response came from storage, not from new work"). `no-store` because an order response must never be cached by a shared cache and replayed to another client.

### The requests (actual)

Create:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' -H 'Idempotency-Key: pattern-order-001' --data-binary '{
  "customerId": "cus_acme_01",
  "items": [
    { "productId": "prd_tee", "quantity": 1 },
    { "productId": "prd_mug", "quantity": 2 }
  ]
}'
```

```http
HTTP/1.1 201 Created
X-Request-Id: 92f70081-1d62-4700-bdee-ccd914bb1d9c
Cache-Control: no-store
Location: /v1/tenants/ten_acme/orders/ord_53746936-286d-41de-affc-1edaaed6e303
Content-Type: application/json; charset=utf-8
Content-Length: 524
Date: Thu, 29 Oct 2026 12:30:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"ord_53746936-286d-41de-affc-1edaaed6e303","status":"PENDING","customerId":"cus_acme_01","items":[{"productId":"prd_tee","sku":"TEE-001","name":"Classic T-Shirt","unitPriceCents":1999,"quantity":1,"lineTotalCents":1999},{"productId":"prd_mug","sku":"MUG-001","name":"Camp Mug","unitPriceCents":1299,"quantity":2,"lineTotalCents":2598}],"subtotalCents":4597,"discountCents":0,"totalCents":4597,"currency":"USD","couponCode":null,"version":1,"createdAt":"2026-10-29T12:30:35.762Z","updatedAt":"2026-10-29T12:30:35.762Z"}
```

`1999 + 2 × 1299 = 4597`, in integer cents. The SKU and name are snapshots — `prd_tee` is about to be repriced, and this order will not move.

Retry with the identical request:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' -H 'Idempotency-Key: pattern-order-001' --data-binary '{
  "customerId": "cus_acme_01",
  "items": [
    { "productId": "prd_tee", "quantity": 1 },
    { "productId": "prd_mug", "quantity": 2 }
  ]
}'
```

```http
HTTP/1.1 201 Created
X-Request-Id: 05dae289-dcf8-46b3-a309-55985f0aa5a5
Idempotent-Replayed: true
Cache-Control: no-store
Location: /v1/tenants/ten_acme/orders/ord_53746936-286d-41de-affc-1edaaed6e303
Content-Type: application/json; charset=utf-8
Content-Length: 524
Date: Thu, 29 Oct 2026 12:30:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"ord_53746936-286d-41de-affc-1edaaed6e303","items":[{"sku":"TEE-001","name":"Classic T-Shirt","quantity":1,"productId":"prd_tee","lineTotalCents":1999,"unitPriceCents":1999},{"sku":"MUG-001","name":"Camp Mug","quantity":2,"productId":"prd_mug","lineTotalCents":2598,"unitPriceCents":1299}],"status":"PENDING","version":1,"currency":"USD","createdAt":"2026-10-29T12:30:35.762Z","updatedAt":"2026-10-29T12:30:35.762Z","couponCode":null,"customerId":"cus_acme_01","totalCents":4597,"discountCents":0,"subtotalCents":4597}
```

Same order ID, same timestamps, `Idempotent-Replayed: true`, and — note this — **a different key order in the JSON**. The stored body comes back from a `jsonb` column, and PostgreSQL's `jsonb` does not preserve object key order. The status line, the `Location`, and every value are identical; the bytes are not.

That matters in two places. First, it is legal: JSON object member order carries no meaning, and clients must not compare raw strings. Second, it is why this server returns the stored body only from the idempotency table and never tries to reconstruct it from current state — a reconstruction would produce different values, not just different ordering.

Same key, different body:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' -H 'Idempotency-Key: pattern-order-001' --data-binary '{
  "customerId": "cus_acme_01",
  "items": [ { "productId": "prd_tee", "quantity": 9 } ]
}'
```

```http
HTTP/1.1 409 Conflict
X-Request-Id: 91f3c8dc-688e-4a81-a483-03ab476036ae
Content-Type: application/problem+json; charset=utf-8
Content-Length: 248
Date: Thu, 29 Oct 2026 12:30:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/idempotency_key_reused","title":"Conflict","status":409,"detail":"This Idempotency-Key was already used with a different request.","instance":"/v1/tenants/ten_acme/orders","code":"idempotency_key_reused"}
```

The server compares the SHA-256 of the canonicalized body (and the method and path) with the stored hash. A mismatch is never "just try again" — it is a client bug, and the client must generate a fresh key for a genuinely new order.

The price changes after the order:

```console
$ curl -sS -i --request PATCH http://localhost:4010/v1/tenants/ten_acme/products/prd_tee -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "priceCents": 2599 }'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 5bc8d689-f565-40e0-a099-dbb81ac0d63f
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:30:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":2599,"currency":"USD","stock":49,"active":true,"version":3,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:30:35.805Z"}
```

Two things moved besides the price: `stock` is `49` (the order decremented one) and `version` is `3` (order reservation incremented it once, this patch again). A client holding `version: 1` from before the order must not blind-write with `If-Match` — its precondition is stale, and chapter 13c explains the `412` it would get.

The stored order is unaffected:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/orders/ord_53746936-286d-41de-affc-1edaaed6e303 -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 80ab6b7f-fbdd-4699-9fef-bd3ebb7f2cb8
Content-Type: application/json; charset=utf-8
Content-Length: 524
Date: Thu, 29 Oct 2026 12:30:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"ord_53746936-286d-41de-affc-1edaaed6e303","status":"PENDING","customerId":"cus_acme_01","items":[{"productId":"prd_tee","sku":"TEE-001","name":"Classic T-Shirt","unitPriceCents":1999,"quantity":1,"lineTotalCents":1999},{"productId":"prd_mug","sku":"MUG-001","name":"Camp Mug","unitPriceCents":1299,"quantity":2,"lineTotalCents":2598}],"subtotalCents":4597,"discountCents":0,"totalCents":4597,"currency":"USD","couponCode":null,"version":1,"createdAt":"2026-10-29T12:30:35.762Z","updatedAt":"2026-10-29T12:30:35.762Z"}
```

`unitPriceCents` is still `1999`. This is the snapshot rule; without it, repricing a product would silently rewrite the totals of every past order.

Quantity above the schema limit:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' -H 'Idempotency-Key: pattern-order-oos' --data-binary '{
  "customerId": "cus_acme_01",
  "items": [ { "productId": "prd_hoodie", "quantity": 999 } ]
}'
```

```http
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 0077c083-0c38-44ff-b30b-edfc133116e2
Content-Type: application/problem+json; charset=utf-8
Content-Length: 323
Date: Thu, 29 Oct 2026 12:30:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/v1/tenants/ten_acme/orders","code":"validation_failed","errors":[{"pointer":"/items/0/quantity","code":"too_big","message":"Too big: expected number to be <=99"}]}
```

Validation runs before any business logic, so this failure is a schema error (`too_big` on `/items/0/quantity`), not an `insufficient_stock` conflict. The hoodie has 8 in stock; the request never got far enough to ask.

No stock was consumed:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/products/prd_hoodie -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 6857a3db-36b7-4df0-87d3-1e2c507b5882
Content-Type: application/json; charset=utf-8
Content-Length: 265
Date: Thu, 29 Oct 2026 12:30:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_hoodie","sku":"HOO-001","slug":"trail-hoodie","name":"Trail Hoodie","description":"Fleece-lined hoodie.","priceCents":4999,"currency":"USD","stock":8,"active":true,"version":1,"createdAt":"2026-01-01T11:00:00.000Z","updatedAt":"2026-10-29T12:30:35.583Z"}
```

Still `8`. Nothing was reserved, and no idempotency claim was created either: `parseInput` rejects the body before `createOrder` is called, so the key `pattern-order-oos` is still unused and can be retried with a corrected body. (For failures *inside* execution, chapter 12 shows the claim being deleted instead.)

Inactive product:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' -H 'Idempotency-Key: pattern-order-inactive' --data-binary '{
  "customerId": "cus_acme_01",
  "items": [ { "productId": "prd_cap", "quantity": 1 } ]
}'
```

```http
HTTP/1.1 409 Conflict
X-Request-Id: 58f4eebc-f979-4455-b6dc-a7087b515c0d
Content-Type: application/problem+json; charset=utf-8
Content-Length: 206
Date: Thu, 29 Oct 2026 12:30:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/product_inactive","title":"Conflict","status":409,"detail":"Product prd_cap is not available.","instance":"/v1/tenants/ten_acme/orders","code":"product_inactive"}
```

Unknown product:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' -H 'Idempotency-Key: pattern-order-missing' --data-binary '{
  "customerId": "cus_acme_01",
  "items": [ { "productId": "prd_missing", "quantity": 1 } ]
}'
```

```http
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 4b715087-504c-4b88-b83f-f0365301ee27
Content-Type: application/problem+json; charset=utf-8
Content-Length: 234
Date: Thu, 29 Oct 2026 12:30:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_product","title":"Unprocessable Content","status":422,"detail":"One or more products do not exist for this tenant.","instance":"/v1/tenants/ten_acme/orders","code":"invalid_product"}
```

An inactive product is a **state** (`409`); an unknown product is a **bad reference** (`422`). Both carry a distinct `code` so clients can show different messages without parsing prose.

Duplicate product lines are merged before pricing (`quantities` map), so sending `prd_tee` twice at 1 each reserves 2 — that is why the schema's per-line maximum is not the only bound that matters.

Ban a customer, then order for them:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/customers/cus_acme_09/ban -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "reason": "Repeated chargebacks" }'
```

```http
HTTP/1.1 200 OK
X-Request-Id: adab84c6-f645-49dc-b481-78c8f00606fe
Content-Type: application/json; charset=utf-8
Content-Length: 286
Date: Thu, 29 Oct 2026 12:30:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"customer":{"id":"cus_acme_09","email":"ivan.petrov.9@example.com","name":"Ivan Petrov","status":"BANNED","bannedAt":"2026-10-29T12:30:35.877Z","banReason":"Repeated chargebacks","version":2,"createdAt":"2026-01-09T09:00:00.000Z","updatedAt":"2026-10-29T12:30:35.877Z"},"changed":true}
```

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' -H 'Idempotency-Key: pattern-order-banned' --data-binary '{
  "customerId": "cus_acme_09",
  "items": [ { "productId": "prd_mug", "quantity": 1 } ]
}'
```

```http
HTTP/1.1 409 Conflict
X-Request-Id: 9530a0c0-2f81-4c8e-aee7-a2e769e8a4d9
Content-Type: application/problem+json; charset=utf-8
Content-Length: 212
Date: Thu, 29 Oct 2026 12:30:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/customer_banned","title":"Conflict","status":409,"detail":"Banned customers cannot place new orders.","instance":"/v1/tenants/ten_acme/orders","code":"customer_banned"}
```

The ban is checked inside the transaction, so a customer banned a millisecond before the order commits cannot slip through a check that happened earlier outside it.

---

## 4. Bad vs good

**Bad:** no key, so the client retries blindly.

```ts
// Bad: two requests, two orders
await fetch('/orders', { method: 'POST', body: JSON.stringify(order) });  // times out
await fetch('/orders', { method: 'POST', body: JSON.stringify(order) });  // client retry
```

The server did commit the first one. The customer now has two orders and two stock reservations, and support has to guess which to refund.

**Good:** the client generates a key per *logical* operation and reuses it on retries.

```ts
// Good
const key = crypto.randomUUID();
for (let attempt = 0; attempt < 3; attempt += 1) {
  const res = await fetch('/orders', { method: 'POST', headers: { 'Idempotency-Key': key }, body });
  if (res.ok || res.status < 500) return res;   // a 4xx is not fixed by retrying
}
```

A new key for a new order; the same key for every retry of that order.

**Bad:** check stock, then decrement in two statements.

```ts
// Bad: the gap is a race
const product = await tx.product.findUnique({ where: { id } });
if (product.stock < quantity) throw new HttpProblem(409, 'insufficient_stock', '...');
await tx.product.update({ where: { id }, data: { stock: product.stock - quantity } });
```

Two requests read `stock: 1`, both pass, both decrement — stock is now `-1` and two customers were promised the same hoodie. `update` with a computed absolute value also overwrites any decrement that happened in between.

**Good:** one conditional statement whose result is the decision.

```ts
// Good
const reserved = await tx.product.updateMany({
  where: { id, tenantId, deletedAt: null, active: true, stock: { gte: quantity } },
  data: { stock: { decrement: quantity }, version: { increment: 1 } },
});
if (reserved.count === 0) throw new HttpProblem(409, 'insufficient_stock', '...');
```

**Bad:** joining to the live product when reading an order.

```ts
// Bad: yesterday's $19.99 order now shows $25.99
const items = await prisma.orderItem.findMany({
  where: { orderId },
  include: { product: { select: { name: true, priceCents: true } } },
});
```

**Good:** snapshot at write time, read only snapshots.

```ts
// Good
unitPriceCents: line.product.priceCents,   // written once
nameSnapshot: line.product.name,           // written once
```

**Bad:** delivering `order.created` on a replay. The order did not change, but the customer gets a second "your order is confirmed" email and the warehouse gets a duplicate pick instruction.

**Good:** `if (!result.replayed) void deliverEvent(...)`. The webhook reflects *transitions*, not *requests*.

---

## 5. In a real multi-tenant e-commerce platform

The checkout flow runs from a mobile app on flaky networks. The client generates a key when the user taps "Pay", stores it, and reuses it on every retry — including after an app restart, if the pending order was persisted. The part that matters:

- A duplicate order costs the merchant a refund, a support ticket, and often a chargeback fee.
- A duplicate stock decrement can mark an item sold out for everyone else until an admin notices.
- A duplicate `order.created` webhook can ship two boxes.

All three are prevented by the same three lines: the key, the transaction, and the replay check. Per tenant, `idempotency_keys` is unique on `[tenantId, key]`, so two tenants may coincidentally use the same key string without colliding — the key is scoped like every other row (chapter 11).

The currency rule is also tenant-real: an order's items must share one currency, checked in the same transaction. A cart mixing a USD tee and a EUR mug is rejected with `409 currency_mismatch` rather than being silently converted at an unknown rate.

---

## 6. When to use it and when NOT

**Require an idempotency key when:**

- The operation creates money or physical work: orders, payments, refunds, payouts, shipping labels.
- The client cannot safely discover whether a request succeeded (timeouts, mobile networks, retries by a gateway).
- The endpoint is `POST` and not naturally idempotent.

**Do not:**

- **Use a key as a lock.** It prevents duplicate *effects* of the same logical request; it does not serialize unrelated requests (that is what conditional updates and transactions are for).
- **Accept an unlimited set of keys.** Keys need an expiry (24 h here) and a cleanup job; otherwise the table grows forever.
- **Replay errors forever.** This project deletes the idempotency claim when execution throws, so a corrected retry can succeed. Decide this deliberately: replaying a `409 insufficient_stock` after stock arrives would be confusing.
- **Make the key optional on order creation.** A client that forgets it gets `400`; silent absence means silent duplicates.
- **Use the idempotency key as the order ID.** They serve different purposes: the key scopes retries and expires; the order ID is permanent and public.

For `GET`, `PUT`, and `DELETE` on a known resource, the method semantics already make retries safe (chapter 2); adding a key is noise. For `PATCH` with a full replacement body, `If-Match` (chapter 13c) is the relevant guard.

---

## 7. Common mistakes

1. **Storing the key but not the response.** On retry you know "already happened" but cannot answer; the client gets an error for a successful order.
2. **Comparing only the key, not the request.** Same key with a different body silently returns the *old* order — the client thinks it placed a new one.
3. **Hashing `JSON.stringify(req.body)` without canonicalization.** Key order differs between clients (or between retries after a proxy), so identical requests look different. Canonical JSON is what makes the hash stable.
4. **Executing first, then recording the key.** A crash between the two leaves an order with no key: the next retry creates a second one.
5. **Decrementing stock outside the transaction.** The order commits, the decrement does not — or vice versa.
6. **`findUnique` + `update` for stock.** The race in section 4; use a conditional `updateMany` or `SELECT ... FOR UPDATE`.
7. **Reading current product data for an existing order.** Rewrites history; the snapshot columns exist for this.
8. **Delivering webhooks on replay.** Duplicate events; check `replayed`.
9. **A key per HTTP attempt instead of per logical operation.** The client defeats the mechanism by generating a new key on each retry.
10. **Forgetting the tenant in the unique index.** Acme's `order-1` blocks Globex's `order-1`, and cross-tenant key reuse becomes possible.

---

## 8. Try it yourself

Add **cancel order** with a safe retry: `POST /v1/tenants/{tenantId}/orders/{orderId}/cancel`, taking `{ "reason": string }`.

Requirements:

1. Requires `Idempotency-Key`; replays return the stored response with `Idempotent-Replayed: true`.
2. `PENDING` → `CANCELLED`, restoring every item's stock in the same transaction (`stock: { increment }`, `version: { increment }`). The order keeps its snapshot fields; add `status: 'CANCELLED'` to the order status check in the OpenAPI document too.
3. A cancelled order cancelled again returns `200` with `changed: false` (idempotent state transition), not an error.
4. `PAID` orders cannot be cancelled: `409 invalid_order_state`.
5. A cancelled order cannot be paid: the payment path already rejects non-`PENDING` orders — confirm it.

**Hint:** the transition guard is the same conditional-update trick as stock: `updateMany({ where: { id, tenantId, status: 'PENDING' }, data: { status: 'CANCELLED' } })`, and `count === 1` means you own the transition and should restore stock. `count === 0` means either the order is missing (`404`, check first) or it is no longer `PENDING` — re-read it to distinguish "already cancelled" (`200 changed:false`) from "PAID" (`409`). Do the stock restore inside the same `$transaction`; a crash between the status update and the restore is otherwise a lost unit. Wrap the whole thing in `runIdempotent` exactly as `createOrder` does, or a retried cancel will restore stock twice.

---

## 9. Next

Customer lists combine search, filters, and cursor pagination — and show what happens when a cursor is used with a sort it cannot support.

Next: [25c. Pattern: customers list with search, filters, and cursor pagination](25c-pattern-customers-search-cursor.md)
