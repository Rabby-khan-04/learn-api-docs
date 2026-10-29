# 20. Webhooks

> **Run order:** Prisma server, port 4010 (auth on), plus the demo receiver on port **4020** (`npm run webhook:receiver`).
>
> Every request below is copied from `transcripts/20-webhooks.txt`, captured with `curl` on 2026-10-29. The last four calls talk to the receiver directly, not to the API.

---

## 1. Simple explanation (like I'm 7)

You order a pizza. Instead of calling the shop every minute to ask "is it ready?", you give the shop your **phone number**. When the pizza is done, the shop calls **you**.

That is a **webhook**: the API calls your server when something happens. But anyone can call your number and pretend to be the shop, so the shop also says a **secret password** on every call. You check the password before believing the message.

And if your phone is busy, the shop tries again a few times. If you hear the same message twice (because the first confirmation got lost), you must not bake a second pizza — you recognize the message number and ignore the duplicate.

---

## 2. Real name

A **webhook** is an HTTP callback: the provider sends a `POST` with an event payload to a URL registered by the consumer. It inverts the polling model of chapter 18 — instead of the client asking repeatedly, the server pushes when there is news.

The contract has four parts:

1. **Registration.** `POST /webhook-endpoints` with a URL; the server returns a **signing secret once**.
2. **Delivery.** `POST` JSON to the URL with event headers and an HMAC signature.
3. **Verification.** The receiver recomputes the HMAC over the raw body and a timestamp, compares in constant time, and rejects stale or mismatched requests.
4. **Reliability.** At-least-once delivery with retries; the receiver must be **idempotent** and tolerate duplicates and out-of-order events.

Signing scheme in this project:

```
X-Webhook-Signature: t=<unix-seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

Headers:

| Header | Purpose |
| --- | --- |
| `x-webhook-event` | Event type (`order.created`, `order.paid`) |
| `x-webhook-event-id` | Stable event id; also inside the body |
| `x-webhook-delivery` | Delivery attempt record id (useful for support) |
| `x-webhook-signature` | `t=...,v1=...` |

Delivery lifecycle (`webhook_deliveries`):

```
PENDING → DELIVERED
        ↘ FAILED (after 3 attempts)
```

Key truths:

- **At-least-once, not exactly-once.** Networks fail after the receiver processed the event; a retry is inevitable. The receiver dedupes by `event.id`.
- **Order is not guaranteed.** `order.paid` may arrive before `order.created` if retries interleave. Consumers must handle it (fetch current state rather than assume sequence).
- **Signatures bind the body and time.** The timestamp prevents replay of an old captured request; the HMAC prevents forgery. Verify the **raw bytes**, not a re-serialized JSON object.
- **Secrets are shown once.** Listing endpoints never returns the secret; losing it means rotating it.

---

## 3. Example

### Registering an endpoint

```ts
// src/routes/webhook-endpoints.ts (excerpt)
const endpoint = await prisma.webhookEndpoint.create({
  data: {
    id: newId('whe'),
    tenantId,
    url: body.url,
    secret: `whsec_${randomBytes(24).toString('base64url')}`,
  },
});
res.status(201).location(`/v1/tenants/${tenantId}/webhook-endpoints/${endpoint.id}`).json({
  id: endpoint.id,
  url: endpoint.url,
  active: endpoint.active,
  // Shown once, at creation. List responses never include it.
  secret: endpoint.secret,
  createdAt: iso(endpoint.createdAt),
});
```

`webhookEndpointSchema` only checks `z.url().max(500)` here. **Production must also block SSRF**: reject private/link-local addresses, resolve DNS and re-check, disallow redirects to private ranges, and consider an egress proxy. A webhook URL is a server-side request forgery primitive if left unchecked.

### Signing and delivering

```ts
// src/services/webhooks.ts (excerpt)
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

const timestamp = Math.floor(Date.now() / 1000);
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-webhook-event': payload.type,
    'x-webhook-event-id': payload.id,
    'x-webhook-delivery': deliveryId,
    'x-webhook-signature': `t=${timestamp},v1=${signWebhook(secret, timestamp, rawBody)}`,
  },
  body: rawBody, // sign exactly these bytes
  signal: AbortSignal.timeout(2000),
});
```

The string-to-sign includes the timestamp, so a signature cannot be moved to another time. The body is `JSON.stringify(payload)` once, and the same string is both signed and sent — re-serializing on the receiver side would break the signature (key order, whitespace, number formatting).

### Retries and records

```ts
// src/services/webhooks.ts (excerpt)
for (let attemptNo = 1; attemptNo <= 3; attemptNo += 1) {
  await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { attempts: attemptNo, lastError: lastError || null } });
  try {
    const response = await fetch(/* ... */);
    if (response.ok) { /* status DELIVERED, deliveredAt */ return; }
    lastError = `HTTP ${response.status}`;
  } catch (error) {
    lastError = error instanceof Error ? error.message : 'delivery failed';
  }
  if (attemptNo < 3) await sleep(300 * attemptNo);
}
await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'FAILED', lastError } });
```

Every endpoint gets its own delivery row; `@@unique([tenantId, eventId, endpointId])` (chapter 11) prevents duplicate rows for the same event/endpoint pair. Three attempts with a 300/600 ms backoff and a 2 s timeout are tutorial values; production wants exponential backoff with jitter, a persisted `nextAttemptAt`, and a worker so retries survive restarts.

### Registered endpoints

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/webhook-endpoints -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 200 OK
X-Request-Id: afe604ba-8f0a-49dd-b53d-235478f61c0b
Content-Type: application/json; charset=utf-8
Content-Length: 123
Date: Thu, 29 Oct 2026 12:29:18 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"wh_acme","url":"http://localhost:4020/hooks/orders","active":true,"createdAt":"2026-10-29T12:29:18.738Z"}]}
```

No secret in the list. `wh_acme` points at the demo receiver; it is created by the seed.

### Create a second, broken endpoint (to show retries)

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/webhook-endpoints -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "url": "http://localhost:4099/hooks/dead" }'
HTTP/1.1 201 Created
X-Request-Id: 37af2cbe-439e-4557-a9ec-d33731c6f87b
Location: /v1/tenants/ten_acme/webhook-endpoints/whe_7267fba3-9251-4009-951d-83dfc00fa8a6
Content-Type: application/json; charset=utf-8
Content-Length: 193
Date: Thu, 29 Oct 2026 12:29:18 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"whe_7267fba3-9251-4009-951d-83dfc00fa8a6","url":"http://localhost:4099/hooks/dead","active":true,"secret":"whsec_6OV6zX8no63941DyVtAC-SGw1WlzesnX","createdAt":"2026-10-29T12:29:18.925Z"}
```

`4099` has nothing listening, so delivery will retry and fail. The secret is in this response only.

### Create an order, which emits `order.created`

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/orders -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' -H 'Idempotency-Key: webhook-demo-001' --data-binary '{
  "customerId": "cus_acme_08",
  "items": [ { "productId": "prd_mug", "quantity": 1 } ]
}'
HTTP/1.1 201 Created
X-Request-Id: 897066af-6565-4bcb-93ae-9099ac01958c
Cache-Control: no-store
Location: /v1/tenants/ten_acme/orders/ord_b0a22855-297a-409a-9384-87936879feb1
Content-Type: application/json; charset=utf-8
Content-Length: 402
Date: Thu, 29 Oct 2026 12:29:18 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"ord_b0a22855-297a-409a-9384-87936879feb1","status":"PENDING","customerId":"cus_acme_08","items":[{"productId":"prd_mug","sku":"MUG-001","name":"Camp Mug","unitPriceCents":1299,"quantity":1,"lineTotalCents":1299}],"subtotalCents":1299,"discountCents":0,"totalCents":1299,"currency":"USD","couponCode":null,"version":1,"createdAt":"2026-10-29T12:29:18.947Z","updatedAt":"2026-10-29T12:29:18.947Z"}
```

The 201 returns immediately; delivery happens after the response, so a slow webhook cannot slow the order.

### Healthy endpoint: DELIVERED on the first attempt

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/webhook-endpoints/wh_acme/deliveries -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 200 OK
X-Request-Id: 3761b2c7-afb9-4105-bf9b-3606f0c60634
Content-Type: application/json; charset=utf-8
Content-Length: 272
Date: Thu, 29 Oct 2026 12:29:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"whd_7b8dd300-2e2c-4568-8f7b-ffa414e3db14","eventId":"evt_c318f9f5-43e9-4914-a8c8-2deb20207f45","eventType":"order.created","status":"DELIVERED","attempts":1,"lastError":null,"createdAt":"2026-10-29T12:29:18.959Z","deliveredAt":"2026-10-29T12:29:18.967Z"}]}
```

### Broken endpoint: FAILED after 3 attempts

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/webhook-endpoints/whe_7267fba3-9251-4009-951d-83dfc00fa8a6/deliveries -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 200 OK
X-Request-Id: 2e81e229-d009-4469-946f-d071b4076c4a
Content-Type: application/json; charset=utf-8
Content-Length: 257
Date: Thu, 29 Oct 2026 12:29:22 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"whd_8f3f7da2-38be-43f8-b1bb-a49ef46827f1","eventId":"evt_c318f9f5-43e9-4914-a8c8-2deb20207f45","eventType":"order.created","status":"FAILED","attempts":3,"lastError":"fetch failed","createdAt":"2026-10-29T12:29:18.961Z","deliveredAt":null}]}
```

Same `eventId` as the healthy delivery: one event, one delivery per endpoint. `attempts: 3` and `lastError: "fetch failed"` are what an operator needs to diagnose; do not hide them.

### A tenant cannot see another tenant's deliveries

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_globex/webhook-endpoints/wh_acme/deliveries -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 403 Forbidden
X-Request-Id: abc74856-a4b4-40b4-8b52-56240414379d
Content-Type: application/problem+json; charset=utf-8
Content-Length: 240
Date: Thu, 29 Oct 2026 12:29:22 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/forbidden","title":"Forbidden","status":403,"detail":"This token is not allowed to access that tenant.","instance":"/v1/tenants/ten_globex/webhook-endpoints/wh_acme/deliveries","code":"forbidden"}
```

### The receiver: valid signature, accepted

The receiver is a separate Express app (`scripts/webhook-receiver.ts`) that listens on 4020, reads the **raw** body, and verifies `t` and `v1`:

```console
$ curl -sS -i --request POST http://localhost:4020/hooks/orders -H 'Content-Type: application/json' -H 'X-Webhook-Signature: t=1793277068,v1=55823b131deee40a0758c1e55f5dcb5a5cfa402ec543a6c05669025238dff944' --data-binary '{"id":"evt_demo_0001","type":"order.created","data":{"orderId":"ord_demo_pending"}}'
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 35
ETag: W/"23-Hb81zufyQ22iv23kQ26pIwpmivo"
Date: Thu, 29 Oct 2026 12:31:08 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"received":true,"duplicate":false}
```

`X-Powered-By` and the weak ETag are byproducts of the tiny demo receiver (the API itself disables both); they are not part of the webhook contract.

### The same event again: duplicate, but still 200

```console
$ curl -sS -i --request POST http://localhost:4020/hooks/orders -H 'Content-Type: application/json' -H 'X-Webhook-Signature: t=1793277068,v1=55823b131deee40a0758c1e55f5dcb5a5cfa402ec543a6c05669025238dff944' --data-binary '{"id":"evt_demo_0001","type":"order.created","data":{"orderId":"ord_demo_pending"}}'
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 34
ETag: W/"22-A/EZTkeyyrDOEXJE4tVzxbisBO4"
Date: Thu, 29 Oct 2026 12:31:08 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"received":true,"duplicate":true}
```

The receiver remembered `evt_demo_0001` and did nothing the second time, but it still answers 2xx. Returning an error for a duplicate would make the sender retry forever.

### Wrong signature: 401

```console
$ curl -sS -i --request POST http://localhost:4020/hooks/orders -H 'Content-Type: application/json' -H 'X-Webhook-Signature: t=1793277068,v1=deadbeef' --data-binary '{"id":"evt_demo_0001","type":"order.created","data":{"orderId":"ord_demo_pending"}}'
HTTP/1.1 401 Unauthorized
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 30
ETag: W/"1e-sW25V/1f0LtpK2K/TT45NVFjgZQ"
Date: Thu, 29 Oct 2026 12:31:08 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"error":"signature mismatch"}
```

### Stale timestamp: 401 before checking payload

```console
$ curl -sS -i --request POST http://localhost:4020/hooks/orders -H 'Content-Type: application/json' -H 'X-Webhook-Signature: t=1793276168,v1=6923358ec64851904652398a1e0cd0024664702a8024ee7204cd81a367f9e2d0' --data-binary '{"id":"evt_demo_0001","type":"order.created","data":{"orderId":"ord_demo_pending"}}'
HTTP/1.1 401 Unauthorized
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 36
ETag: W/"24-HJmhMFSvEEvtqHbWw4/u3l0aE9g"
Date: Thu, 29 Oct 2026 12:31:08 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"error":"timestamp too old (900s)"}
```

The receiver allows a 300-second window; this signature is 900 s old, so it is rejected even though the HMAC format is valid. Without a timestamp check, a captured request could be replayed forever. (The receiver's error text is plain JSON here because it is a demo app; a production receiver would return an RFC 9457 problem.)

Matching `.http` file: [`requests/20-webhooks.http`](../requests/20-webhooks.http). Full capture: [`transcripts/20-webhooks.txt`](../transcripts/20-webhooks.txt).

---

## 4. Bad vs good

**Bad — no signature, or a shared static token**

A URL alone is not authentication; URLs leak through logs, screenshots, and redirects. A token in the query is visible everywhere and cannot bind the body. Use an HMAC over the exact body plus a timestamp.

**Bad — verifying a re-serialized body**

```ts
// DANGER DEMO — DO NOT SHIP
const body = await req.json();
const expected = hmac(secret, JSON.stringify(body)); // key order/whitespace may differ
```

If the framework parsed and re-stringified, byte order can change and the signature never matches — or worse, you "fix" it by disabling verification. Read the raw bytes.

**Bad — comparing with `===`**

Timing leaks can theoretically recover a signature byte by byte. Use `crypto.timingSafeEqual` on equal-length buffers.

**Bad — treating a non-2xx as "no retry needed"**

Senders retry on timeouts, connection errors, and 5xx; they usually stop on 4xx. A receiver that returns 500 for "duplicate" gets hammered. Return 2xx once the event is safely recorded, even if it is a duplicate.

**Bad — assuming exactly-once and ordering**

Retries duplicate; independent events reorder. Consumers must be idempotent (dedupe by event id) and state-aware (fetch the current order instead of assuming the paid event implies created arrived).

**Bad — webhook URL pointing anywhere**

The API makes an outbound request to a user-supplied URL. Without SSRF protection, `http://169.254.169.254/...` or `http://localhost:5434` becomes reachable from your network. Validate schemes, block private ranges, re-check after DNS resolution, and do not follow redirects blindly.

**Good — sign raw bytes, verify time, dedupe, record, retry**

**Trade-offs:**

- **Webhooks vs polling vs SSE.** Webhooks are efficient and near-real-time but require a public receiver, retry infrastructure, and signature verification. Polling is simpler and works behind firewalls. Many providers offer both (chapters 18 and 20).
- **Retry on 4xx vs only 5xx/timeouts.** A 410 Gone or 404 usually means the endpoint is misconfigured and retrying will not help; a 401 might be fixed later. This demo retries all failures three times for simplicity. Production should classify: retry 408/429/5xx and network errors; stop on other 4xx (but still record).
- **At-least-once vs exactly-once.** Exactly-once across a network is impossible without distributed transactions. Promise at-least-once and make consumers idempotent; state that in the docs.
- **Inline retries vs a queue.** Inline `sleep` ties up the request's async context and dies on restart. A durable queue with `nextAttemptAt` is the production shape; the delivery table already has room for it.
- **One secret per endpoint vs account-wide.** Per-endpoint secrets limit blast radius and allow rotation per integration; account-wide is simpler. This API uses per-endpoint.
- **Secret rotation.** Support two active secrets during rotation (sign with both, verify with either) or provide a "rotate" endpoint with an overlap window. This tutorial issues one and never rotates.
- **Payload size.** Include enough to identify the event, not the entire resource; let the consumer fetch details with its own credentials. Smaller payloads mean less PII in transit and fewer stale copies. This payload includes `orderId`, `customerId`, totals.
- **Event versioning.** When the payload shape changes, keep event type names stable and add fields additively (chapter 14), or introduce `order.created.v2`. Consumers ignore unknown fields.

---

## 5. In a real multi-tenant e-commerce platform

Acme registers a webhook to its order-management system. When a customer checks out, the API writes the order, returns 201, and asynchronously delivers `order.created` to every active Acme endpoint. Acme's receiver verifies the signature, dedupes by `event.id` (stored in its own database with a unique constraint), fetches the order through the API for details, and creates a pick task.

Acme's endpoint is down for maintenance. The provider retries with backoff, records `FAILED` after the final attempt, and surfaces the delivery in the endpoint's deliveries list. Acme's ops team sees the failure, fixes the receiver, and uses a replay tool (not implemented here) to redeliver failed events. Because the consumer dedupes, a replay is safe.

Globex is a separate tenant with its own endpoints and secrets. A Globex admin cannot list Acme's deliveries (403), and the delivery rows are tenant-scoped in every query. The signing secret is shown once at creation; if it leaks, Acme rotates it, and the old secret stops working after the overlap window.

A malicious Globex admin registers a webhook URL pointing at an internal metadata service. SSRF protection (absent in this tutorial, mandatory in production) rejects private and link-local addresses before any request is made.

---

## 6. When to use it and when NOT to

**Use webhooks when:**

- Consumers need to react promptly to events.
- Polling would be wasteful or too slow.
- Consumers can expose an HTTPS endpoint and verify signatures.

**When not to:**

- **Small, non-urgent syncs** where a scheduled pull is simpler and more robust.
- **Consumers behind strict firewalls** that cannot accept inbound traffic — offer polling.
- **Delivery of huge payloads.** Send a reference and let the consumer fetch.

**Do not** use webhooks for authorization or as the source of truth. The event is a notification; the API remains authoritative, and the consumer should verify state before acting.

---

## 7. Common mistakes

1. **No signature verification.** Anyone who learns the URL can inject events.
2. **Signing parsed JSON instead of raw bytes.** Signature never matches or verification is disabled.
3. **No timestamp or no window.** Captured requests can be replayed forever.
4. **String comparison instead of constant-time.** Timing side channel.
5. **No idempotency at the receiver.** Retries create duplicate orders/tasks.
6. **Returning 4xx/5xx to duplicates.** Sender retries forever or marks healthy deliveries failed.
7. **Assuming ordering.** `paid` before `created` breaks state machines.
8. **Retrying forever on permanent 4xx.** Noise and load for a broken endpoint.
9. **No delivery records or visible errors.** Nobody can diagnose failures.
10. **Synchronous delivery in the request path.** A slow receiver adds latency to checkout.
11. **SSRF.** Registering arbitrary URLs lets attackers reach internal services.
12. **Secret in list responses or logs.** Leaks the ability to forge events.
13. **No secret rotation.** A leaked secret cannot be replaced without downtime.
14. **Payloads with full PII.** More exposure and stale copies; send ids plus minimal fields.
15. **No replay tool.** Failed deliveries cannot be recovered without re-emitting the event.
16. **No size/time limits on the receiver.** A slow consumer hangs the sender's worker.
17. **Ignoring `Retry-After`/backoff on 429.** Sender and receiver fight.

---

## 8. Try it yourself

**Exercise.** Add a `customer.banned` event emitted by the ban endpoint (chapter 25d).

1. Define the payload: which ids/fields are enough for a consumer to act without fetching everything?
2. The consumer receives `customer.banned` twice and `customer.unbanned` before `customer.banned`. What does an idempotent, state-aware handler do?
3. Write the receiver's verification steps in order, including where the raw body comes from.
4. The endpoint returns 410 Gone. Retry or stop? Why?
5. Design secret rotation with zero downtime.

**Hint.** Payload: `{ eventId, type: "customer.banned", data: { customerId, reason, bannedAt } }`; no email needed (consumer can fetch if authorized). Dedupe by eventId; on either event, fetch the customer's current state and apply it — the latest state wins, so out-of-order delivery converges. Verify: read raw body → parse `t=,v1=` → reject if `|now - t| > 300` → recompute HMAC over `${t}.${raw}` → timing-safe compare → dedupe → apply → 2xx. 410 means the endpoint is permanently gone: stop retrying (mark endpoint inactive), keep the delivery record. Rotation: two secrets active; sign with the new one (or both headers), verify with either; retire the old after the overlap.

---

## 9. Next

[21. OpenAPI from Zod →](21-openapi-from-zod.md)
