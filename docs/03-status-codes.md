# 03. Status codes that matter

> **Run order:** in-memory server, port 4011, **auth on** for this chapter so `401`/`403` are real.
>
> ```console
> AUTH_ENABLED=on CACHE_ENABLED=off LEGACY_DEPRECATION_HEADERS=off PORT=4011 npm run start:memory
> ```
>
> Every request below is copied from `transcripts/03-status-codes.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

When you ask for something at a shop, the person behind the counter says one short thing first:

- "Here you go." — it worked.
- "I made it for you." — it did not exist before; now it does.
- "Done, nothing else to say." — I did the thing and there is no receipt to hand you.
- "I don't understand your order." — your words were garbled.
- "Who are you?" — I need to know you first.
- "I know you, but you can't have this." — you are not allowed.
- "We don't have that." — it does not exist.
- "That clashes with something already here." — conflict.
- "I understood you, but the order doesn't make sense." — invalid content.
- "Slow down, too many requests."
- "Something broke on our side."

HTTP status codes are those short answers, standardised. The first digit is the family: `2xx` worked, `3xx` look elsewhere, `4xx` you did something the server rejects, `5xx` the server failed.

The number is not decoration. Clients, gateways, and retry libraries branch on it without reading your JSON.

---

## 2. Real name

A **status code** is a three-digit integer in the HTTP response status line, defined by [RFC 9110 §15](https://www.rfc-editor.org/rfc/rfc9110.html#name-status-codes). It is machine-readable and comes with a reason phrase that is **not** semantically meaningful (`422` is rendered as "Unprocessable Entity" by Node's HTTP stack and "Unprocessable Content" by RFC 9110 — clients must use the number, never the phrase).

The codes this course uses:

| Code | Name | When |
|---|---|---|
| `200` | OK | Successful read or update with a body. |
| `201` | Created | A new resource exists; send `Location`. |
| `202` | Accepted | Work queued, not finished (chapter 18). |
| `204` | No Content | Success with no body (typical `DELETE`). |
| `304` | Not Modified | Conditional `GET` hit (chapter 15). |
| `400` | Bad Request | Malformed request: unparseable JSON, broken syntax. |
| `401` | Unauthorized | Missing or invalid credentials. Must include `WWW-Authenticate`. |
| `403` | Forbidden | Authenticated, not permitted. |
| `404` | Not Found | Resource does not exist *for this caller/tenant*. |
| `409` | Conflict | Request conflicts with current state (duplicate SKU, wrong order status). |
| `412` | Precondition Failed | `If-Match` did not match (chapter 13c). |
| `413` | Content Too Large | Body/file too big (chapter 19). |
| `415` | Unsupported Media Type | Wrong `Content-Type` or file type. |
| `422` | Unprocessable Content | Well-formed but invalid semantically (schema/semantic failure). |
| `429` | Too Many Requests | Rate limited (chapter 16). |
| `500` | Internal Server Error | Unhandled server bug. Never leak details. |
| `503` | Service Unavailable | Temporary overload/maintenance; may include `Retry-After`. |

Two distinctions deserve their own paragraphs.

### `401` vs `403`

- `401 Unauthorized` really means **unauthenticated**: "I do not know who you are, or your credentials are invalid." RFC 9110 requires a `WWW-Authenticate` challenge describing how to authenticate.
- `403 Forbidden` means **authenticated but not allowed**: "I know who you are; you still cannot do this."

A missing token is `401`. A valid token for tenant Acme requesting tenant Globex is `403`. Returning `403` for a missing token hides the fact that authentication is possible; returning `401` for an authenticated-but-denied request tells the client to re-authenticate, which will not help and can cause a login loop.

### `400` vs `422`

Both mean "the client sent something wrong." The useful split:

- `400` — the server could not even parse the request (malformed JSON, invalid query syntax).
- `422` — parsed successfully but failed validation or domain rules expressed as content errors (currency not ISO 4217, price negative, referenced product missing).

Stripe historically returns `400` for many validation failures; RFC 9110 defines `422` and this course follows it, because it lets clients distinguish "fix your JSON" from "fix your field values". The trade-off is in the roadmap's disagreement table.

### `200` with an error body

The anti-pattern: always return `200` and put `{"success": false, "error": "..."}` in the body. It forces every client to parse the body to know whether the call worked, breaks generic retry/circuit-breaker middleware, poisons caches with error pages, and makes dashboards show 100% success during an outage. DANGER DEMO in chapter 24 shows it live.

---

## 3. Example

The error middleware in `src/http/problem.ts` owns every error response. Handlers throw a typed problem; the middleware maps it to the status line and an RFC 9457 body.

```ts
// src/http/problem.ts (excerpt, comments added)
export function unauthorized(detail: string): HttpProblem {
  return new HttpProblem(401, 'invalid_token', detail, {
    // RFC 9110: 401 responses must carry a challenge.
    headers: { 'WWW-Authenticate': 'Bearer realm="api-learn", error="invalid_token"' },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  const error = notFound(`No route matches ${req.method} ${req.path}.`);
  res.status(404).type('application/problem+json').json(problemBody(req, error));
}

// Unhandled errors become a generic 500; the stack trace is logged, never sent.
console.error(`[${req.requestId}] unhandled error`, error);
res.status(500).type('application/problem+json').json(problemBody(req, new HttpProblem(
  500, 'internal_error', 'An unexpected error occurred.',
)));
```

### `200 OK` — read

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_tee -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 200 OK
X-Request-Id: d1911f22-d329-4945-bddb-3c140506f022
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:26:40 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}
```

### `201 Created` — create, with `Location`

```console
$ curl -sS -i --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{
  "sku": "SOC-001",
  "slug": "trail-socks",
  "name": "Trail Socks",
  "priceCents": 999,
  "currency": "USD",
  "stock": 40
}'
HTTP/1.1 201 Created
X-Request-Id: afeb3484-4723-435c-ad7d-d6e87cb70a6f
Location: /api/tenants/ten_acme/products/prd_d5e94793-3359-457b-92e8-ea9fe0afbf58
Content-Type: application/json; charset=utf-8
Content-Length: 275
Date: Thu, 29 Oct 2026 12:26:40 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_d5e94793-3359-457b-92e8-ea9fe0afbf58","sku":"SOC-001","slug":"trail-socks","name":"Trail Socks","description":null,"priceCents":999,"currency":"USD","stock":40,"active":true,"version":1,"createdAt":"2026-10-29T12:26:40.687Z","updatedAt":"2026-10-29T12:26:40.687Z"}
```

`description` is absent in the request but `null` in the response: the schema default (chapter 09) and the DTO (chapter 10) decide that, not the store.

### `204 No Content` — delete

```console
$ curl -sS -i --request DELETE http://localhost:4011/api/tenants/ten_acme/products/prd_d5e94793-3359-457b-92e8-ea9fe0afbf58 -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 204 No Content
X-Request-Id: 03488036-5e77-4b08-afa4-d72269a43454
Date: Thu, 29 Oct 2026 12:26:40 GMT
Connection: keep-alive
Keep-Alive: timeout=5
```

There is no `Content-Length` and no body. Do not send `{"deleted": true}` with `204`; some clients discard it, and it contradicts the code.

### `400 Bad Request` — unparseable JSON

```console
$ curl -sS -i --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{"sku": "BAD-001",'
HTTP/1.1 400 Bad Request
X-Request-Id: ddd22457-4451-4080-92b8-5477678b9870
Content-Type: application/problem+json; charset=utf-8
Content-Length: 210
Date: Thu, 29 Oct 2026 12:26:40 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/malformed_json","title":"Bad Request","status":400,"detail":"The request body is not valid JSON.","instance":"/api/tenants/ten_acme/products","code":"malformed_json"}
```

The error has no `errors[]` array: there is no field to point at, because the document itself is broken. Chapter 08b covers when to include field errors.

### `404 Not Found`

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_missing -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 404 Not Found
X-Request-Id: 2176d9e6-dd92-408b-84e5-05e8b71d2d6d
Content-Type: application/problem+json; charset=utf-8
Content-Length: 193
Date: Thu, 29 Oct 2026 12:26:40 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"Product not found.","instance":"/api/tenants/ten_acme/products/prd_missing","code":"not_found"}
```

In a tenant-scoped API, "exists in another tenant" is also `404` for that caller. Chapter 17 shows the cross-tenant attempt: the middleware may answer `403` when the token itself is mismatched; when the query is scoped, the resource simply does not exist for you and the answer is `404`. Both avoid confirming that another tenant's ID is real.

### `409 Conflict` — duplicate SKU

```console
$ curl -sS -i --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{
  "sku": "TEE-001",
  "slug": "another-tee",
  "name": "Another Tee",
  "priceCents": 1999,
  "currency": "USD",
  "stock": 5
}'
HTTP/1.1 409 Conflict
X-Request-Id: 498e03f6-41bd-4fdd-a83e-a5de940aa454
Content-Type: application/problem+json; charset=utf-8
Content-Length: 202
Date: Thu, 29 Oct 2026 12:26:40 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/sku_taken","title":"Conflict","status":409,"detail":"That SKU already exists for this tenant.","instance":"/api/tenants/ten_acme/products","code":"sku_taken"}
```

`409` says: the request is valid in isolation, but it collides with current state. The `code` (`sku_taken`) is what the client can act on; do not make clients match on English `detail`.

### `422 Unprocessable Content` — valid JSON, invalid value

```console
$ curl -sS -i --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{
  "sku": "HAT-001",
  "slug": "sun-hat",
  "name": "Sun Hat",
  "priceCents": 1500,
  "currency": "usd",
  "stock": 10
}'
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 81517661-be96-47b9-8233-3fa81a4c911b
Content-Type: application/problem+json; charset=utf-8
Content-Length: 335
Date: Thu, 29 Oct 2026 12:26:40 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products","code":"validation_failed","errors":[{"pointer":"/currency","code":"invalid_format","message":"Use a three-letter ISO 4217 code such as USD."}]}
```

Note the reason phrase says "Unprocessable Entity" while RFC 9110 calls it "Unprocessable Content". Node's `http` module emits the older phrase. Clients must key on `422`, and our body's `title` is the stable "Validation Failed".

### `401 Unauthorized` — no credentials

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_tee
HTTP/1.1 401 Unauthorized
X-Request-Id: ef1f72fd-a1c4-472f-8346-e07f4ab6d1d3
WWW-Authenticate: Bearer realm="api-learn", error="invalid_token"
Content-Type: application/problem+json; charset=utf-8
Content-Length: 209
Date: Thu, 29 Oct 2026 12:26:40 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_token","title":"Unauthorized","status":401,"detail":"A Bearer token is required.","instance":"/api/tenants/ten_acme/products/prd_tee","code":"invalid_token"}
```

### `403 Forbidden` — valid token, wrong tenant

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_globex/products -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 403 Forbidden
X-Request-Id: 42f54ac3-3701-40e2-893b-a2179da97564
Content-Type: application/problem+json; charset=utf-8
Content-Length: 213
Date: Thu, 29 Oct 2026 12:26:40 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/forbidden","title":"Forbidden","status":403,"detail":"This token is not allowed to access that tenant.","instance":"/api/tenants/ten_globex/products","code":"forbidden"}
```

Matching `.http` file: [`requests/03-status-codes.http`](../requests/03-status-codes.http). Full capture: [`transcripts/03-status-codes.txt`](../transcripts/03-status-codes.txt).

---

## 4. Bad vs good

**Bad — one status for everything**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "success": false, "errorCode": 404, "message": "Product not found" }
```

Why it is bad:

- Retry middleware sees `200` and stops; circuit breakers see success; metrics are green during an outage.
- Caches may store the error as a valid representation of the resource.
- The client must know your envelope before it can branch, so every new client re-implements HTTP.
- The `errorCode` inside the body duplicates HTTP with a private vocabulary nobody else understands.

**Good — status line plus problem body**

```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json

{ "type": ".../not_found", "title": "Not Found", "status": 404, "detail": "Product not found.",
  "instance": "/api/tenants/ten_acme/products/prd_missing", "code": "not_found" }
```

The status line is enough for infrastructure; the body is enough for humans and for client-specific handling, and chapter 08a standardises it.

**Trade-off to know:** some clients (notably older SOAP/enterprise middleware) log `4xx` as alarms. That is a client configuration problem, not a reason to return `200`. If you must support such a client, fix the alarm, not the API.

---

## 5. In a real multi-tenant e-commerce platform

A partner integration creates products in bulk.

- `201` plus `Location` lets the partner store canonical URLs instead of guessing ID formats.
- A duplicate SKU returns `409 sku_taken` with a stable `code`; the partner's importer moves that row to a "review" queue instead of aborting the whole batch.
- A bad currency returns `422 validation_failed` with `pointer: "/currency"`; the partner highlights the spreadsheet cell.
- A missing token returns `401` with `WWW-Authenticate`; the partner refreshes the token and retries once.
- A token for another tenant returns `403`; the partner alerts an operator because this is a configuration bug, not a transient error.
- A `500` has no detail; the partner retries with backoff because it is safe to retry a failed read, and for writes it uses an idempotency key (chapter 12).

The status code decides the automated reaction; the `code` decides the business reaction. Both are part of your contract.

---

## 6. When to use it and when NOT to

**Use the standard codes** for everything they cover. Do not invent `299` or `499` for ordinary success/failure; intermediaries may treat unknown codes as errors or strip them.

**When to bend:**

- `202 Accepted` when work is queued and not done. Do not return `201` for a resource that does not exist yet (chapter 18 shows the task resource that does exist).
- `409` vs `422` for a business rule: if the request conflicts with current state (order already paid, coupon exhausted), `409`; if the payload is invalid on its own (negative price), `422`. When in doubt, ask "would this request be valid if the system were empty?" If yes, it is a conflict.
- `404` vs `403` for existence leaks: when revealing existence is itself sensitive (another tenant's order ID), prefer `404`. Document it. This course uses `403` for a token/path tenant mismatch at the middleware boundary and `404` for scoped lookups; both are defensible, but be consistent.

**When NOT to add a new code:**

- "Business error 1001" with `200` — no.
- `418` for a joke — only if you are a teapot.
- A custom `4xx` that means "validation failed" — `422` already exists.

---

## 7. Common mistakes

1. **`200` with an error body.** Covered above; the single most damaging habit in this list.
2. **`401` without `WWW-Authenticate`.** RFC 9110 requires the challenge. Clients and gateways use it.
3. **`403` for a missing token.** Makes the client think authentication will not help.
4. **`400` for everything.** Loses the parse-vs-validate distinction and makes client UX worse.
5. **`404` with a stack trace** or an ORM message like `PrismaClientKnownRequestError`. Leaks internals.
6. **`200` on create.** The resource did not exist before; `201` is how clients know to read `Location`.
7. **`204` with a body.** Contradictory; some clients ignore the body, others choke.
8. **`500` for client mistakes.** A missing required field is not a server bug.
9. **Wrong family for retries.** Returning `400` for a rate limit prevents clients from backing off; `429` is the contract (chapter 16).
10. **Inconsistent codes for the same failure** across endpoints. Chapter 22 turns this into a review checklist.

---

## 8. Try it yourself

**Exercise.** For each situation, choose the status code and say whether the response should include `WWW-Authenticate`, `Location`, or neither:

1. The client sends a valid token for `ten_acme` and requests `/tenants/ten_globex/orders/ord_1`.
2. The client sends no token at all.
3. The client creates an order; the order is created and stored.
4. The client tries to pay an order that is already `PAID`.
5. The client sends `{"priceCents": "cheap"}` to create a product.
6. The client sends `{ "sku": ` — truncated JSON.
7. The database is down and the handler throws.

**Hint.** 1 is authenticated-but-wrong-tenant, 2 is unauthenticated, 3 is a new resource, 4 is a state conflict, 5 is parsed-but-invalid, 6 is unparseable, 7 is a server failure. `WWW-Authenticate` belongs only to `401`; `Location` belongs only to a `201` (and `202` can carry it too, in chapter 18). For 4, ask whether the request would be fine in an empty system — the order state is what makes it invalid, so it is a conflict, not a validation failure.

---

## 9. Next

[04. URLs: resources, nouns, and nesting →](04-urls-resource-naming.md)
