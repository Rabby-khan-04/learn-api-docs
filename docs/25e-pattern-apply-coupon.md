# 25e. Pattern: applying a coupon

> **Run order:** Prisma server, port 4010, auth on.
>
> Every request below is copied from `transcripts/25e-pattern-apply-coupon.txt`, captured with `curl` on 2026-10-29. The database was seeded with `ord_demo_pending` (a pending order), `ord_demo_payable` (another pending order), and the coupons used here.

---

## 1. Simple explanation (like I'm 7)

A shop prints a coupon: "10% off, one use only, expires at the end of the month". It hands the coupon to customers.

When a customer brings it to the till, the shop must check five things before saying yes:

1. Is this coupon real, **and from this shop**? (The shop next door's coupon is not valid here.)
2. Is it still inside its dates?
3. Does it match the money in the basket? (A euro coupon on a dollar basket is a no.)
4. Has this basket already used a coupon?
5. Is there still one use left? — and if two tills check at the same second, only one may get the last use.

Then the shop does the math **in whole cents**, not in decimals, and writes down that the coupon was used.

---

## 2. Real name

Applying a coupon is a transaction that **validates a discount rule, consumes a redemption, and rewrites order totals atomically**. It is the densest business rule in this course, because it combines:

| Concern | Rule in this API |
| --- | --- |
| Tenant scope | coupon lookup includes `tenantId`; a foreign coupon is indistinguishable from a missing one |
| Order state | only `PENDING` orders accept a coupon (`409 invalid_order_state`) |
| Single coupon | an order that has one is rejected (`409 coupon_already_applied`) |
| Validity window | `active`, `startsAt <= now <= endsAt` |
| Currency | `coupon.currency === order.currency` |
| Redemption cap | atomic conditional increment, `409 coupon_exhausted` |
| Arithmetic | integer cents; `PERCENT` rounds, `FIXED` is capped at the subtotal |
| Audit | `coupon_redemptions` row `(tenantId, couponId, orderId)` |

The endpoint is a **sub-resource action**: `POST /orders/{orderId}/coupon` with `{ "code": "..." }`. It is not `PATCH /orders/{orderId}` with `"discountCents"`, because a client must never choose its own discount — the server computes it from the coupon.

Coupon codes are **normalized to uppercase** at the boundary (`.transform((value) => value.toUpperCase())`), so `save10` and `SAVE10` are the same coupon. Users do not type case consistently; the API should not punish them.

---

## 3. Example

### The body and the normalizing schema

```ts
// src/schemas/commerce.ts (excerpt)
export const applyCouponSchema = z
  .object({
    code: z.string().trim().min(3).max(40).transform((value) => value.toUpperCase()),
  })
  .strict();
```

### The transaction

```ts
// src/services/orders.ts (excerpt)
const updated = await prisma.$transaction(async (tx) => {
  const order = await tx.order.findFirst({
    where: { id: input.orderId, tenantId: input.tenantId },
    include: { items: true },
  });
  if (!order) throw new HttpProblem(404, 'not_found', 'Order not found.');
  if (order.status !== 'PENDING') {
    throw new HttpProblem(409, 'invalid_order_state', `Order is ${order.status}, not PENDING.`);
  }
  if (order.couponId) {
    throw new HttpProblem(409, 'coupon_already_applied', 'This order already has a coupon.');
  }
```

State checks come first. A paid order cannot be discounted after the fact, and an order with a coupon cannot stack a second one — the schema has a single `couponId`, so stacking is impossible by construction rather than by an unenforced rule.

```ts
  const coupon = await tx.coupon.findFirst({
    where: { tenantId: input.tenantId, code: input.code },
  });
  const now = new Date();
  // Do not reveal whether a coupon exists in another tenant or in the future.
  if (
    !coupon ||
    !coupon.active ||
    coupon.startsAt > now ||
    coupon.endsAt < now ||
    coupon.currency !== order.currency
  ) {
    throw new HttpProblem(422, 'invalid_coupon', 'The coupon cannot be applied to this order.');
  }
```

Six different reasons share **one** answer: `422 invalid_coupon` with a generic detail. That is deliberate. Distinguishing "expired" from "does not exist" from "belongs to another shop" turns the endpoint into a **coupon enumeration oracle**: an attacker could test thousands of codes and learn which ones are real. The client gets enough to show "this coupon cannot be used"; support gets the specifics from logs and the coupon table.

Currency is part of validity: a `EUR` coupon on a `USD` order is not "a coupon that failed to match", it is simply not applicable.

### The math

```ts
const discountCents =
  coupon.type === 'PERCENT'
    ? Math.round((order.subtotalCents * (coupon.percentOff ?? 0)) / 100)
    : Math.min(coupon.amountOffCents ?? 0, order.subtotalCents);
```

Two cases, two safety rules:

- **Percent** is computed from the integer subtotal and rounded to the nearest cent. `10%` of `4999` is `499.9`, which is not a representable amount of money; the API must pick a side. It picks `Math.round` (half-up for positive values) and documents it — the transcript shows `500`.
- **Fixed** is capped at the subtotal: a 50-dollar coupon on a 20-dollar order discounts 20 dollars, never creating a negative total or a refund.

`subtotalCents - discountCents` is always an integer in `[0, subtotalCents]`. No floating point touches money anywhere in this path; chapter 7 explains why.

### Consuming the redemption atomically

```ts
// Atomic cap: only one transaction can consume the last redemption.
const consumed = await tx.coupon.updateMany({
  where: {
    id: coupon.id,
    tenantId: input.tenantId,
    active: true,
    redemptionCount: { lt: coupon.maxRedemptions },
  },
  data: { redemptionCount: { increment: 1 } },
});
if (consumed.count === 0) {
  throw new HttpProblem(409, 'coupon_exhausted', 'This coupon has reached its redemption limit.');
}
```

This is the concurrency heart of the pattern. Two orders race for the last redemption; PostgreSQL serializes the two `UPDATE`s, one sees a row matching `redemptionCount < maxRedemptions` and increments, the other matches zero rows and gets `409`. There is no read-then-increment gap.

The order is updated conditionally too, so a concurrent second coupon request cannot win twice:

```ts
const updatedOrder = await tx.order.updateMany({
  where: { id: order.id, tenantId: input.tenantId, status: 'PENDING', couponId: null },
  data: {
    couponId: coupon.id,
    couponCode: coupon.code,
    discountCents,
    totalCents: order.subtotalCents - discountCents,
    version: { increment: 1 },
  },
});
if (updatedOrder.count === 0) {
  throw new HttpProblem(409, 'coupon_already_applied', 'This order already has a coupon.');
}

await tx.couponRedemption.create({
  data: {
    id: newId('red'),
    tenantId: input.tenantId,
    couponId: coupon.id,
    orderId: order.id,
    customerId: order.customerId,
  },
});
```

If the order update fails, the transaction rolls back — including the `redemptionCount` increment. A coupon is never consumed by an order that did not get the discount.

### The requests (actual)

Expired coupon:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders/ord_demo_pending/coupon -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "code": "EXPIRED10" }'
```

```http
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: f12732b4-3f90-42c8-a5ea-e6211801d68e
Content-Type: application/problem+json; charset=utf-8
Content-Length: 249
Date: Thu, 29 Oct 2026 12:30:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_coupon","title":"Unprocessable Content","status":422,"detail":"The coupon cannot be applied to this order.","instance":"/v1/tenants/ten_acme/orders/ord_demo_pending/coupon","code":"invalid_coupon"}
```

A Globex coupon (`EU10`) on an Acme order:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders/ord_demo_pending/coupon -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "code": "EU10" }'
```

```http
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: a30f67db-f72c-4448-a51f-f35196242a32
Content-Type: application/problem+json; charset=utf-8
Content-Length: 249
Date: Thu, 29 Oct 2026 12:30:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_coupon","title":"Unprocessable Content","status":422,"detail":"The coupon cannot be applied to this order.","instance":"/v1/tenants/ten_acme/orders/ord_demo_pending/coupon","code":"invalid_coupon"}
```

Byte-for-byte the same body as the expired coupon, right down to `instance` (the request path is identical); only `X-Request-Id` differs between the two captures. An attacker holding an `EU10` code learns nothing about whether it exists in another tenant.

Valid coupon, typed in lowercase:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders/ord_demo_pending/coupon -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "code": "save10" }'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 33e556e4-97fe-497a-9a00-b247f6f38cc5
Content-Type: application/json; charset=utf-8
Content-Length: 391
Date: Thu, 29 Oct 2026 12:30:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"ord_demo_pending","status":"PENDING","customerId":"cus_acme_03","items":[{"productId":"prd_hoodie","sku":"HOO-001","name":"Trail Hoodie","unitPriceCents":4999,"quantity":1,"lineTotalCents":4999}],"subtotalCents":4999,"discountCents":500,"totalCents":4499,"currency":"USD","couponCode":"SAVE10","version":2,"createdAt":"2026-01-20T09:00:00.000Z","updatedAt":"2026-10-29T12:30:36.725Z"}
```

`4999 × 10% = 499.9 → 500`. The response echoes the **normalized** code `SAVE10`, not the lowercase input, and returns the full updated order — the client does not need a follow-up `GET`. `version` moved to 2 for `If-Match` clients.

Applying it again:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders/ord_demo_pending/coupon -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "code": "SAVE10" }'
```

```http
HTTP/1.1 409 Conflict
X-Request-Id: fbaf75ba-90e2-4037-bee0-c41a4d870610
Content-Type: application/problem+json; charset=utf-8
Content-Length: 241
Date: Thu, 29 Oct 2026 12:30:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/coupon_already_applied","title":"Conflict","status":409,"detail":"This order already has a coupon.","instance":"/v1/tenants/ten_acme/orders/ord_demo_pending/coupon","code":"coupon_already_applied"}
```

`409`, not `200 changed:false`: unlike ban/unban, applying a coupon is **not** idempotent by intent — the client asked to add a discount to an order that already has one, and the correct answer is "this cannot be done". (If you wanted replay safety for the same code, the operation would need an idempotency key; here the rule is "one coupon per order", and a second attempt is simply invalid.)

A coupon with one redemption — order A:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' -H 'Idempotency-Key: coupon-max1-order-a' --data-binary '{
  "customerId": "cus_acme_14",
  "items": [ { "productId": "prd_mug", "quantity": 1 } ]
}'
```

```http
HTTP/1.1 201 Created
X-Request-Id: 6eae8442-c396-43c7-88db-130c24d69b68
Cache-Control: no-store
Location: /v1/tenants/ten_acme/orders/ord_da7064ec-5848-48ba-9101-a0d489fb1a38
Content-Type: application/json; charset=utf-8
Content-Length: 402
Date: Thu, 29 Oct 2026 12:30:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"ord_da7064ec-5848-48ba-9101-a0d489fb1a38","status":"PENDING","customerId":"cus_acme_14","items":[{"productId":"prd_mug","sku":"MUG-001","name":"Camp Mug","unitPriceCents":1299,"quantity":1,"lineTotalCents":1299}],"subtotalCents":1299,"discountCents":0,"totalCents":1299,"currency":"USD","couponCode":null,"version":1,"createdAt":"2026-10-29T12:30:36.753Z","updatedAt":"2026-10-29T12:30:36.753Z"}
```

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders/ord_da7064ec-5848-48ba-9101-a0d489fb1a38/coupon -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "code": "MAX1" }'
```

```http
HTTP/1.1 200 OK
X-Request-Id: c517de48-3dcd-4038-be48-7d935a9af211
Content-Type: application/json; charset=utf-8
Content-Length: 406
Date: Thu, 29 Oct 2026 12:30:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"ord_da7064ec-5848-48ba-9101-a0d489fb1a38","status":"PENDING","customerId":"cus_acme_14","items":[{"productId":"prd_mug","sku":"MUG-001","name":"Camp Mug","unitPriceCents":1299,"quantity":1,"lineTotalCents":1299}],"subtotalCents":1299,"discountCents":100,"totalCents":1199,"currency":"USD","couponCode":"MAX1","version":2,"createdAt":"2026-10-29T12:30:36.753Z","updatedAt":"2026-10-29T12:30:36.780Z"}
```

A second order, then the same coupon:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' -H 'Idempotency-Key: coupon-max1-order-b' --data-binary '{
  "customerId": "cus_acme_15",
  "items": [ { "productId": "prd_tee", "quantity": 1 } ]
}'
```

```http
HTTP/1.1 201 Created
X-Request-Id: 4febc124-ca13-489a-a004-232c03b2262c
Cache-Control: no-store
Location: /v1/tenants/ten_acme/orders/ord_a8358c49-7937-4e62-bbab-810cce34b477
Content-Type: application/json; charset=utf-8
Content-Length: 409
Date: Thu, 29 Oct 2026 12:30:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"ord_a8358c49-7937-4e62-bbab-810cce34b477","status":"PENDING","customerId":"cus_acme_15","items":[{"productId":"prd_tee","sku":"TEE-001","name":"Classic T-Shirt","unitPriceCents":1999,"quantity":1,"lineTotalCents":1999}],"subtotalCents":1999,"discountCents":0,"totalCents":1999,"currency":"USD","couponCode":null,"version":1,"createdAt":"2026-10-29T12:30:36.800Z","updatedAt":"2026-10-29T12:30:36.800Z"}
```

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders/ord_a8358c49-7937-4e62-bbab-810cce34b477/coupon -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "code": "MAX1" }'
```

```http
HTTP/1.1 409 Conflict
X-Request-Id: d2427a3d-675e-4575-b45e-d09b0fe0ec1c
Content-Type: application/problem+json; charset=utf-8
Content-Length: 266
Date: Thu, 29 Oct 2026 12:30:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/coupon_exhausted","title":"Conflict","status":409,"detail":"This coupon has reached its redemption limit.","instance":"/v1/tenants/ten_acme/orders/ord_a8358c49-7937-4e62-bbab-810cce34b477/coupon","code":"coupon_exhausted"}
```

`coupon_exhausted` is distinct from `invalid_coupon` on purpose: the coupon is real and applicable, but the business limit is gone. The client can say "this offer has ended" instead of "this code is wrong".

A paid order:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders/ord_demo_payable/payments -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' -H 'Idempotency-Key: coupon-pay-demo' --data-binary '{ "provider": "fakepay", "providerRef": "fp_coupon_demo" }'
```

```http
HTTP/1.1 201 Created
X-Request-Id: 7e5c04f7-fa17-43c4-98fd-40f420bdc69e
Cache-Control: no-store
Content-Type: application/json; charset=utf-8
Content-Length: 226
Date: Thu, 29 Oct 2026 12:30:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"pay_779918c6-61b3-4bc4-ae93-ba59b960c82b","orderId":"ord_demo_payable","status":"SUCCEEDED","amountCents":2598,"currency":"USD","provider":"fakepay","providerRef":"fp_coupon_demo","createdAt":"2026-10-29T12:30:36.832Z"}
```

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders/ord_demo_payable/coupon -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "code": "SAVE10" }'
```

```http
HTTP/1.1 409 Conflict
X-Request-Id: ffc7855d-b28b-4d6c-9310-f7c5c045d9c3
Content-Type: application/problem+json; charset=utf-8
Content-Length: 230
Date: Thu, 29 Oct 2026 12:30:36 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_order_state","title":"Conflict","status":409,"detail":"Order is PAID, not PENDING.","instance":"/v1/tenants/ten_acme/orders/ord_demo_payable/coupon","code":"invalid_order_state"}
```

The payment charged `2598` — the order's total at the time it was paid. A discount applied after payment would require a refund, so the state check is the only sane answer.

---

## 4. Bad vs good

**Bad:** check the cap, then increment.

```ts
// Bad: two orders can both see "1 left"
const coupon = await tx.coupon.findFirst({ where: { code } });
if (coupon.redemptionCount >= coupon.maxRedemptions) throw new HttpProblem(409, 'coupon_exhausted', '...');
await tx.coupon.update({ data: { redemptionCount: coupon.redemptionCount + 1 } });
```

Two concurrent requests both read `maxRedemptions - 1`, both pass, both increment — one coupon used twice over its limit. Worse, the absolute write (`coupon.redemptionCount + 1`) overwrites any increment that happened in between, so the count can even go backwards in effect.

**Good:** one conditional statement.

```ts
// Good
const consumed = await tx.coupon.updateMany({
  where: { id, tenantId, active: true, redemptionCount: { lt: coupon.maxRedemptions } },
  data: { redemptionCount: { increment: 1 } },
});
if (consumed.count === 0) throw new HttpProblem(409, 'coupon_exhausted', '...');
```

**Bad:** float percentages.

```ts
// Bad: 19.99 * 0.1 = 1.9989999999999999
const discount = order.subtotal * coupon.percent / 100;
const total = order.subtotal - discount;
```

Serialized totals drift by a cent, then by a few cents after refunds, and reconciliation never balances. **Good:** integer cents, explicit rounding, `Math.min` for fixed discounts.

**Bad:** revealing why a coupon failed.

```
# Bad: enumeration oracle
404 {"detail":"Coupon not found"}
422 {"detail":"Coupon expired"}
422 {"detail":"Coupon belongs to another tenant"}
```

An attacker can now probe codes to learn which ones exist and when they expire. **Good:** one `422 invalid_coupon` for every non-applicable reason, with details in server logs.

**Bad:** letting a client set the discount.

```json
PATCH /orders/ord_1  { "discountCents": 5000 }
```

**Good:** the client names the coupon; the server computes `discountCents` and `totalCents`.

**Bad:** consuming the redemption before the order update, without a transaction. If the order update fails, the coupon is gone and no order got the discount. **Good:** all three writes (`coupon`, `order`, `couponRedemption`) in one `$transaction`.

---

## 5. In a real multi-tenant e-commerce platform

Marketing runs a "10% off" campaign in Acme and a "10 EUR off" campaign in Globex with the same code `SAVE10`. Because coupon lookup is `(tenantId, code)`, the two campaigns never collide, and an Acme order using `SAVE10` applies the Acme percentage, not Globex's fixed amount.

A flash sale has `maxRedemptions: 100`. At 09:59:59.900, several hundred checkouts submit at once. The conditional increment lets exactly 100 transactions consume a redemption; the rest get `409 coupon_exhausted` and the storefront shows "this offer has ended". Nobody gets a discount that the campaign did not budget for.

A customer pays, then tries to add a discount code. The order is `PAID`; the API returns `409 invalid_order_state`. The alternative — applying the discount and issuing a partial refund — is a different product decision, and it belongs in a refund endpoint with its own audit trail.

Support asks "which orders used MAX1?" The `coupon_redemptions` table answers with tenant, coupon, order, customer, and time; `@@unique([tenantId, couponId, orderId])` guarantees one row per order even if a bug path retried the create.

---

## 6. When to use it and when NOT

**Use this pattern when:**

- Discounts are rules, not fields: validity windows, currency, caps, stacking policy.
- Money must balance exactly across order, payment, and refund.
- Multiple tenants share code names and must never see each other's coupons.

**Do not:**

- **Let clients compute or submit the discount.** Always recompute server-side from the coupon row.
- **Return different errors for "not found" vs "expired" vs "wrong tenant"** if codes are guessable. One error, logged details.
- **Increment counters outside the transaction** that applies the discount.
- **Use floats for percentages.** Even when the input is "10%", the result is money.
- **Allow stacking without an explicit model.** This API stores one `couponId` per order; supporting two coupons needs a join table, an ordering rule, and a cap policy — not a loop that applies discounts twice.
- **Apply discounts to paid orders silently.** Decide whether that is a refund, with its own endpoint.

---

## 7. Common mistakes

1. **Read-then-write on `redemptionCount`.** Overspends the campaign; use a conditional update.
2. **Float math or `toFixed` at the edge.** Round once, in integer cents, at the point of computation.
3. **Percent rounding undocumented.** `499.9` → `500` vs `499` changes the total by a cent and the reconciliation by more; pick and document (this API uses `Math.round`).
4. **Fixed discount not capped at the subtotal.** Produces negative totals or accidental store credit.
5. **Missing currency check.** A `EUR` coupon silently discounts a `USD` order by treating 10 as 10 of anything.
6. **Coupon enumeration.** Distinct errors for expired / foreign / missing codes.
7. **Case-sensitive codes.** `save10` rejected when `SAVE10` exists; normalize at the boundary.
8. **No single-coupon rule.** Two sequential discounts quietly stack.
9. **Consuming the coupon before the order update, outside a transaction.** Lost redemption or free discount.
10. **No unique redemption row.** Retries create duplicate audit rows and break "which orders used this coupon" reports.
11. **Applying to non-`PENDING` orders.** Discount after payment is a refund, not an update.

---

## 8. Try it yourself

Add a **minimum subtotal** to coupons and a **per-customer limit**, without breaking the atomic cap.

Requirements:

1. Add `minSubtotalCents Int @default(0)` to `Coupon` and a migration; a coupon whose minimum exceeds the order subtotal is `422 invalid_coupon` (same generic answer).
2. Enforce **one redemption per customer per coupon** using `coupon_redemptions`: before consuming, count rows for `(tenantId, couponId, customerId)`; if any exist, `409 coupon_already_redeemed` (a distinct code is fine here — the customer already knows they used it).
3. Keep the global `maxRedemptions` cap atomic and keep all checks in the same transaction.
4. Add a request to `requests/25e-pattern-apply-coupon.http` and a transcript for the new failure.

**Hint:** the per-customer check is a read, so it is racy under concurrency — but `@@unique([tenantId, couponId, orderId])` does not protect it. Add `@@unique([tenantId, couponId, customerId])` if the rule is truly one per customer forever (it usually is), and translate the `P2002` into `409`, just like `sku_taken` in 25a. The minimum-subtotal check belongs with the other validity checks, before the redemption increment, so a rejected coupon never consumes a use. For the response, decide whether the minimum appears in `detail` — if coupons are guessable, "minimum not met" is safe to reveal only when the code itself was valid; that nuance is the exercise.

---

## 9. Next

The final chapter is the master checklist: one pass over every topic in this course, written for the moment you review an API change rather than study it.

Next: [26. Master checklist](26-master-checklist.md)
