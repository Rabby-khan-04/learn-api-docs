# 12. Idempotency keys

> **Run order:** Prisma server, port 4010, auth off, cache off.
>
> Every request below is copied from `transcripts/12-idempotency-keys.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

You ask the shop clerk: "One chocolate please." The clerk writes "CHOCOLATE #1" on a note. The phone rings, the clerk gets distracted, and you are not sure whether the chocolate was sold to you.

So you say the same thing again: "One chocolate, note #1."

The clerk checks the note. "Already done, here is the same chocolate, I did not sell you a second one."

The **note number** is the idempotency key. If you repeat the same request with the same note, you get the same result. If you try to use note #1 for a totally different order, the clerk says "no, that note is for the first request."

---

## 2. Real name

An **idempotency key** is a client-generated unique value (a header, almost always `Idempotency-Key`) that lets a server recognize a retried request and return the original result instead of performing the action twice.

Why POST needs it: GET, PUT, PATCH, and DELETE are designed to be safe to repeat (chapter 02). POST is not. Payment providers, mobile networks, and load balancers all retry. Without a key, "create order" can become "create two orders".

The contract of this chapter:

| Situation | Server behavior |
| --- | --- |
| First request with `(tenantId, key)` | Execute, store status + body, return them |
| Exact same request again | Return stored status + body, add `Idempotent-Replayed: true` |
| Same key, different method/path/body | `409 idempotency_key_reused` |
| Same key while the first request is still running | `409 idempotency_in_progress` |
| Request fails (validation, stock, etc.) | Delete the key so the client may retry |
| No key on a required endpoint | `400 idempotency_key_required` |

Supporting rules:

1. **The key is scoped per tenant.** `UNIQUE (tenant_id, key)`: Acme's key never collides with Globex's.
2. **The request is hashed.** SHA-256 of canonical JSON plus method and path decides "same request". A different body is not a retry, it is a mistake.
3. **The response is stored, not recomputed.** Replaying must return the original 201 and the original order id.
4. **Keys expire.** 24 hours here; cleanup is by `expires_at`. A key used next week is a new key.
5. **Failure is not a result.** A 422/409/500 attempt deletes the row, so a corrected retry is allowed.
6. **The write and the key record are one unit.** The order row references the idempotency row, inside the same transaction.

---

## 3. Example

### The header is validated like any other input

```ts
// src/schemas/commerce.ts (excerpt)
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, digits, dot, colon, underscore, or hyphen.');
```

```ts
// src/routes/orders.ts (excerpt)
function idempotencyKeyFrom(req: Request): string {
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

The check happens **before** parsing the body or touching stock. A keyless request does no work.

### The core algorithm

```ts
// src/services/idempotency.ts (excerpt, comments added)
const requestHash = createHash('sha256')
  .update(canonicalJson(input.body)) // stable key order
  .digest('hex');

const existing = await prisma.idempotencyKey.findUnique({
  where: { tenantId_key: { tenantId: input.tenantId, key: input.key } },
});

if (existing) {
  if (!sameRequest(existing, requestHash, input.method, input.path)) {
    throw new HttpProblem(409, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
  }
  if (existing.statusCode === null) {
    throw new HttpProblem(409, 'idempotency_in_progress', 'The original request is still in progress.');
  }
  return { status: existing.statusCode, body: existing.responseBody, replayed: true };
}

// Claim the key first...
row = await prisma.idempotencyKey.create({ data: { /* ... */ statusCode: null } });

try {
  const result = await input.execute(row.id);       // the real work, in a transaction
  await prisma.idempotencyKey.update({ where: { id: row.id }, data: { statusCode: result.status, responseBody: result.body } });
  return { ...result, replayed: false };
} catch (error) {
  await prisma.idempotencyKey.delete({ where: { id: row.id } }).catch(() => undefined);
  throw error;                                       // failure does not poison the key
}
```

Two concurrent first requests race on `create`; the loser gets Prisma `P2002` and re-reads the winner's row. That is why the unique constraint (chapter 11) is load-bearing.

### The order is created with the key id attached

```ts
// src/services/orders.ts (excerpt)
await tx.order.create({
  data: {
    id: orderId,
    tenantId: input.tenantId,
    // ...
    idempotencyKeyId: idempotencyRowId, // unique: one order per successful key
  },
});
```

### First request: 201, new order

```console
$ curl -sS -i --request POST http://localhost:4010/api/tenants/ten_acme/orders -H 'Content-Type: application/json' -H 'Idempotency-Key: order-idem-demo-001' --data-binary '{
  "customerId": "cus_acme_01",
  "items": [
    { "productId": "prd_tee", "quantity": 2 },
    { "productId": "prd_mug", "quantity": 1 }
  ]
}'
HTTP/1.1 201 Created
X-Request-Id: 2578293a-3279-43fb-9fd1-05caaad13ac8
Cache-Control: no-store
Location: /api/tenants/ten_acme/orders/ord_bbbd1e9e-14a4-49c4-b899-254baf3dc2f4
Content-Type: application/json; charset=utf-8
Content-Length: 524
Date: Thu, 29 Oct 2026 12:27:12 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"ord_bbbd1e9e-14a4-49c4-b899-254baf3dc2f4","status":"PENDING","customerId":"cus_acme_01","items":[{"productId":"prd_mug","sku":"MUG-001","name":"Camp Mug","unitPriceCents":1299,"quantity":1,"lineTotalCents":1299},{"productId":"prd_tee","sku":"TEE-001","name":"Classic T-Shirt","unitPriceCents":1999,"quantity":2,"lineTotalCents":3998}],"subtotalCents":5297,"discountCents":0,"totalCents":5297,"currency":"USD","couponCode":null,"version":1,"createdAt":"2026-10-29T12:27:12.951Z","updatedAt":"2026-10-29T12:27:12.951Z"}
```

### Exact retry: same order, same 201, replay header

```console
$ curl -sS -i --request POST http://localhost:4010/api/tenants/ten_acme/orders -H 'Content-Type: application/json' -H 'Idempotency-Key: order-idem-demo-001' --data-binary '{
  "customerId": "cus_acme_01",
  "items": [
    { "productId": "prd_tee", "quantity": 2 },
    { "productId": "prd_mug", "quantity": 1 }
  ]
}'
HTTP/1.1 201 Created
X-Request-Id: 5d97e2d4-8eef-4a4c-a30a-bc61d7fd669e
Idempotent-Replayed: true
Cache-Control: no-store
Location: /api/tenants/ten_acme/orders/ord_bbbd1e9e-14a4-49c4-b899-254baf3dc2f4
Content-Type: application/json; charset=utf-8
Content-Length: 524
Date: Thu, 29 Oct 2026 12:27:13 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"ord_bbbd1e9e-14a4-49c4-b899-254baf3dc2f4","items":[{"sku":"MUG-001","name":"Camp Mug","quantity":1,"productId":"prd_mug","lineTotalCents":1299,"unitPriceCents":1299},{"sku":"TEE-001","name":"Classic T-Shirt","quantity":2,"productId":"prd_tee","lineTotalCents":3998,"unitPriceCents":1999}],"status":"PENDING","version":1,"currency":"USD","createdAt":"2026-10-29T12:27:12.951Z","updatedAt":"2026-10-29T12:27:12.951Z","couponCode":null,"customerId":"cus_acme_01","totalCents":5297,"discountCents":0,"subtotalCents":5297}
```

Note the JSON key order differs from the first response: PostgreSQL `jsonb` does not preserve object key order. The **values** are identical, and JSON object order is not significant. Do not write clients (or tests) that compare raw strings.

### Same key, different body: 409, nothing created

```console
$ curl -sS -i --request POST http://localhost:4010/api/tenants/ten_acme/orders -H 'Content-Type: application/json' -H 'Idempotency-Key: order-idem-demo-001' --data-binary '{
  "customerId": "cus_acme_01",
  "items": [
    { "productId": "prd_tee", "quantity": 3 }
  ]
}'
HTTP/1.1 409 Conflict
X-Request-Id: 330592b8-4f69-4ccd-bff8-8a9e73b5151f
Content-Type: application/problem+json; charset=utf-8
Content-Length: 249
Date: Thu, 29 Oct 2026 12:27:13 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/idempotency_key_reused","title":"Conflict","status":409,"detail":"This Idempotency-Key was already used with a different request.","instance":"/api/tenants/ten_acme/orders","code":"idempotency_key_reused"}
```

### No key: 400 before any work

```console
$ curl -sS -i --request POST http://localhost:4010/api/tenants/ten_acme/orders -H 'Content-Type: application/json' --data-binary '{
  "customerId": "cus_acme_01",
  "items": [
    { "productId": "prd_tee", "quantity": 1 }
  ]
}'
HTTP/1.1 400 Bad Request
X-Request-Id: 3feacaab-4870-4ad9-b246-419194b74545
Content-Type: application/problem+json; charset=utf-8
Content-Length: 261
Date: Thu, 29 Oct 2026 12:27:13 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/idempotency_key_required","title":"Bad Request","status":400,"detail":"Send an Idempotency-Key header so a retry cannot create a duplicate.","instance":"/api/tenants/ten_acme/orders","code":"idempotency_key_required"}
```

`400` because the request is malformed at the protocol level (a required header is missing); the semantic validation of the body has not even run. Compare with `422` for a body that is present but invalid (chapter 08b).

### Payments use the same mechanism

```console
$ curl -sS -i --request POST http://localhost:4010/api/tenants/ten_acme/orders/ord_demo_payable/payments -H 'Content-Type: application/json' -H 'Idempotency-Key: pay-idem-demo-001' --data-binary '{
  "provider": "fakepay",
  "providerRef": "fp_charge_demo_001"
}'
HTTP/1.1 201 Created
X-Request-Id: 25e48662-dd83-4d3f-8c3b-eb83be8ca1b5
Cache-Control: no-store
Content-Type: application/json; charset=utf-8
Content-Length: 230
Date: Thu, 29 Oct 2026 12:27:13 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"pay_27d2a55c-1a67-43ef-8169-686acad29bf7","orderId":"ord_demo_payable","status":"SUCCEEDED","amountCents":2598,"currency":"USD","provider":"fakepay","providerRef":"fp_charge_demo_001","createdAt":"2026-10-29T12:27:13.066Z"}
```

The retry returns the same payment, not a second charge:

```console
$ curl -sS -i --request POST http://localhost:4010/api/tenants/ten_acme/orders/ord_demo_payable/payments -H 'Content-Type: application/json' -H 'Idempotency-Key: pay-idem-demo-001' --data-binary '{
  "provider": "fakepay",
  "providerRef": "fp_charge_demo_001"
}'
HTTP/1.1 201 Created
X-Request-Id: b6e49a49-b5de-4519-b892-000ba7b83250
Idempotent-Replayed: true
Cache-Control: no-store
Content-Type: application/json; charset=utf-8
Content-Length: 230
Date: Thu, 29 Oct 2026 12:27:13 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"pay_27d2a55c-1a67-43ef-8169-686acad29bf7","status":"SUCCEEDED","orderId":"ord_demo_payable","currency":"USD","provider":"fakepay","createdAt":"2026-10-29T12:27:13.066Z","amountCents":2598,"providerRef":"fp_charge_demo_001"}
```

And the payment key cannot be redirected to a different charge reference:

```console
$ curl -sS -i --request POST http://localhost:4010/api/tenants/ten_acme/orders/ord_demo_payable/payments -H 'Content-Type: application/json' -H 'Idempotency-Key: pay-idem-demo-001' --data-binary '{
  "provider": "fakepay",
  "providerRef": "fp_charge_OTHER"
}'
HTTP/1.1 409 Conflict
X-Request-Id: 36b17c7f-dac9-40f6-8803-8a42b8e833bf
Content-Type: application/problem+json; charset=utf-8
Content-Length: 275
Date: Thu, 29 Oct 2026 12:27:13 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/idempotency_key_reused","title":"Conflict","status":409,"detail":"This Idempotency-Key was already used with a different request.","instance":"/api/tenants/ten_acme/orders/ord_demo_payable/payments","code":"idempotency_key_reused"}
```

Matching `.http` file: [`requests/12-idempotency-keys.http`](../requests/12-idempotency-keys.http). Full capture: [`transcripts/12-idempotency-keys.txt`](../transcripts/12-idempotency-keys.txt).

---

## 4. Bad vs good

**Bad — "just retry, it's probably fine"**

```ts
// DANGER DEMO — DO NOT SHIP
router.post('/orders', async (req, res) => {
  const order = await createOrder(req.body); // no key check
  res.status(201).json(order);
});
```

Problems:

- A network timeout after commit + a client retry creates a second order and a second charge.
- Load balancers and mobile SDKs retry automatically; you do not control the client.
- Nothing distinguishes "retry" from "the user really wants two orders".
- If the server crashes mid-write, the client cannot safely retry at all.

**Bad — dedupe in a JavaScript `Map`**

An in-process set works until the second instance starts, or the process restarts. It is not a dedupe; it is a hope.

**Good — durable key row with a unique constraint**

```ts
const result = await runIdempotent(prisma, { tenantId, key, method, path, body, execute });
if (result.replayed) res.set('Idempotent-Replayed', 'true');
res.status(result.status).json(result.body);
```

**Trade-offs:**

- **Store the response vs recompute it.** Storing is the only way to return the *same* resource id after a retry. Recomputing after a GET can work for reads but not for "create", because the second computation has no memory of the first id.
- **Hash the whole body vs trust the key alone.** Hashing catches client bugs (key reused with new content) and returns a clear 409. Trusting the key alone silently returns unrelated results.
- **24 hours vs forever.** Long enough for any realistic retry window, short enough to keep the table small. Stripe keeps keys for 24 hours; this course matches that. Expiry must be documented, because after expiry the same key can create a second resource.
- **`Idempotent-Replayed: true` vs an unchanged 201.** RFC 9110 has no standard replay header. A custom header helps debugging and testing; the status and body remain the contract. Some APIs instead return the original response with no marker. Either is defensible; be consistent.
- **Required vs optional.** This API requires a key on order and payment creation, because duplicates cost money. Making it optional accepts a correctness hole for convenience. Resource-creating POSTs with low stakes (a note) may leave it optional, but then your docs must say retries can duplicate.
- **In-progress semantics.** Returning 409 `idempotency_in_progress` is honest. Some APIs block until the first finishes; that ties up connections and needs a timeout. 409 plus a retry-after strategy is simpler; the key expires if the first attempt dies.
- **Failure handling.** Deleting the key on failure is the friendliest choice (a fixed 422 can be retried). The alternative — storing error responses — is also valid, but then a permanent validation error blocks that key forever unless you add expiry for failures too.

---

## 5. In a real multi-tenant e-commerce platform

A customer taps "Place order" on mobile. The request reaches the API and commits the order, but the response is lost in a tunnel. The app retries with the same key. The API returns the original order and `Idempotent-Replayed: true`; the customer sees one order, the warehouse receives one pick task, and the payment intent is charged once.

At the same time, the key is tenant-scoped: the same value `order-2026-10-29-abc` used by Globex is a different record. A shared key table without `tenantId` in the unique constraint would let one tenant's retry replay another tenant's body — a catastrophic leak. The constraint shape *is* the security boundary.

Support tooling reads `Idempotency-Replayed` logs to distinguish "customer clicked twice" from "our network duplicated the request". Finance reconciles `payments` against the provider with `providerRef` and finds no double charges.

---

## 6. When to use it and when NOT to

**Use an idempotency key when:**

- A POST creates money-moving or irreversible effects (orders, payments, refunds, payouts).
- Clients have automatic retries (mobile, SDKs, job queues).
- The operation is expensive or slow enough that timeouts are realistic.
- You cannot make the operation naturally idempotent (for example, a client-chosen id with PUT).

**When not to:**

- **GET, PUT, DELETE** are already idempotent by method semantics; a key adds nothing (a PUT with the same body and URL is naturally safe).
- **Natural-key creation**, such as `PUT /carts/{cartId}` where the client owns the id: repeating the PUT targets the same resource.
- **Read-only POSTs** (search with a long query) where duplicates cost nothing, though caching may help.

**Prefer a client-supplied id + PUT** when you can: it is simpler than a key table. Use an idempotency key when the server must generate the id and the request must not be repeated (the common Stripe-style model).

---

## 7. Common mistakes

1. **Key not scoped by tenant.** A global unique key lets tenants collide or replay each other's responses.
2. **Not hashing the body.** A reused key with new data silently returns the old result instead of a 409.
3. **Hashing the raw body string.** `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same request; use canonical JSON.
4. **Forgetting method/path in the hash.** The same key on `/orders` and `/orders/{id}/payments` must not replay across endpoints.
5. **Storing the key only after success.** A crash after commit but before the key write allows a duplicate on retry. Claim first, then execute.
6. **Storing the key after a failure.** A transient 500 becomes permanent: every retry returns the stored 500. Delete on failure (or store with expiry).
7. **Returning a different body on replay.** Clients diff responses; return exactly what was stored.
8. **Assuming JSON key order is stable.** `jsonb` reorders keys; compare values, not strings.
9. **No expiry or cleanup.** The table grows forever; index `expires_at` and purge.
10. **Trusting a client-provided `Idempotency-Key` as an auth token.** It is not authentication; authentication is separate (chapter 17).
11. **Replaying a 201 as 200.** Status is part of the stored response; keep it.
12. **Making the key optional for money operations.** Document the consequence, or require it.
13. **Logging the key with the body unredacted.** Keys plus payloads can contain personal data; treat logs like data.

---

## 8. Try it yourself

**Exercise.** A refund endpoint `POST /v1/tenants/{tenantId}/orders/{orderId}/refunds` is added. It must not refund twice.

1. Add an `Idempotency-Key` requirement. What status and problem code should a keyless request get?
2. The same key is sent with a different `amountCents`. What should happen, and why not a second refund?
3. Design the storage: which columns, which unique constraint, how long until expiry.
4. Describe what happens when two identical requests arrive at the same millisecond, step by step.
5. Write two curl commands: one that creates, one that proves the replay.

**Hint.** Reuse `runIdempotent` and the `idempotency_keys` table. Keyless: 400 `idempotency_key_required` (mirror orders). Different amount: 409 `idempotency_key_reused`, because the hash includes the body. Columns: `tenant_id`, `key`, `request_hash`, `method`, `path`, `status_code`, `response_body`, `expires_at`, with `UNIQUE (tenant_id, key)`. Concurrent: both compute the same hash, both try `create`, one wins, the loser gets `P2002`, re-reads, sees `status_code` null or set, and returns 409 in-progress or the stored response. Curl: POST twice with `Idempotency-Key: refund-demo-001` and the same body; the second must show `Idempotent-Replayed: true` and the same refund id.

---

## 9. Next

[13a. PUT vs PATCH and partial updates →](13a-put-vs-patch-partial-updates.md)
