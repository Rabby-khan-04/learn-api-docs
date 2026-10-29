# 08b. Error design: validation errors and codes

> **Run order:** in-memory server, port 4011, auth off.
>
> Every request below is copied from `transcripts/08b-validation-errors-error-codes.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

You hand in a form. The teacher does not just say "wrong". The teacher circles **each** mistake:

- "Your name line is empty — line 1."
- "Your price is below zero — line 4."
- "This word must be in capitals — line 2."

Then you can fix all of them in one go.

A validation error response is those circles, written for a computer: which field (`pointer`), what kind of mistake (`code`), and a short explanation (`message`).

---

## 2. Real name

A **validation error** is a `400` (could not parse) or `422` (parsed but invalid) response whose body explains which inputs failed and why.

This API's `errors[]` array is an **extension member** of RFC 9457 (chapter 08a):

```json
{
  "code": "validation_failed",
  "errors": [
    { "pointer": "/sku", "code": "invalid_format", "message": "Use uppercase letters, digits, and hyphens." },
    { "pointer": "/updates/0/priceCents", "code": "too_small", "message": "Too small: expected number to be >=0" }
  ]
}
```

The parts:

| Part | Rule |
|---|---|
| `pointer` | **JSON Pointer** (RFC 6901) to the offending value. Root is `""`; array items use numbers (`/updates/0/priceCents`). Escape `~` as `~0` and `/` as `~1`. |
| `code` | Stable machine code for the *kind* of failure (`invalid_format`, `too_small`, `invalid_type`, `version_mismatch`, `not_found`, `unrecognized_keys`). |
| `message` | Human-readable, safe, specific. Not "Invalid input". |

Rules:

1. **One entry per violation.** Do not stop at the first error; users hate fixing one field at a time.
2. **Pointers must resolve.** A client should be able to walk its own request document to the bad value.
3. **Codes are a catalog.** They are part of the contract; document them and keep them stable. Messages can change.
4. **No internal details.** No regexes from internals, no SQL, no stack traces. The Zod default messages are acceptable because they describe the value, not the system.
5. **`400` vs `422`:** malformed JSON is `400` with no `errors[]`; schema/semantic failures are `422` with `errors[]`. Chapter 03 explains the split.
6. **Bulk operations need pointers too.** A failure in item 0 must say `/updates/0/...`, not just "one update failed" (chapter 13b).

Why not reuse `title` for the field error? Because `title` is per problem *type*; `errors[]` is per occurrence. Mixing them loses the structure.

---

## 3. Example

Zod issues are mapped to pointers and codes in one place:

```ts
// src/http/problem.ts (excerpt, comments added)
function pointerFor(path: PropertyKey[]): string {
  if (path.length === 0) return '';                    // the whole body
  return `/${path
    .map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1')) // RFC 6901
    .join('/')}`;
}

export function fieldErrors(error: ZodError): ProblemFieldError[] {
  return error.issues.map((issue) => ({
    pointer: pointerFor(issue.path),   // e.g. ['updates', 0, 'priceCents'] -> "/updates/0/priceCents"
    code: issue.code,                  // Zod's stable issue code
    message: issue.message,
  }));
}

export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpProblem(422, 'validation_failed', 'One or more fields are invalid.', {
      title: 'Validation Failed',
      errors: fieldErrors(result.error),
    });
  }
  return result.data;
}
```

Every route calls `parseInput` for bodies and query strings, so the mapping is uniform.

### Create with several invalid fields

```console
$ curl -sS -i --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Content-Type: application/json' --data-binary '{
  "sku": "tee-1",
  "slug": "Bad Slug",
  "name": "",
  "priceCents": -1,
  "currency": "usd",
  "stock": 1.5,
  "extra": true
}'
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: b1c6e054-0ed4-44e4-a262-97488c293caf
Content-Type: application/problem+json; charset=utf-8
Content-Length: 911
Date: Thu, 29 Oct 2026 12:26:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products","code":"validation_failed","errors":[{"pointer":"/sku","code":"invalid_format","message":"Use uppercase letters, digits, and hyphens."},{"pointer":"/slug","code":"invalid_format","message":"Use lowercase letters, digits, and hyphens."},{"pointer":"/name","code":"too_small","message":"Too small: expected string to have >=1 characters"},{"pointer":"/priceCents","code":"too_small","message":"Too small: expected number to be >=0"},{"pointer":"/currency","code":"invalid_format","message":"Use a three-letter ISO 4217 code such as USD."},{"pointer":"/stock","code":"invalid_type","message":"Invalid input: expected int, received number"},{"pointer":"","code":"unrecognized_keys","message":"Unrecognized key: \"extra\""}]}
```

Notice:

- `sku` is `tee-1`: uppercase regex fails, and the message says exactly what is allowed.
- `stock` is `1.5`: `invalid_type` (the schema wants an integer) rather than a range error.
- `extra` is not in the schema: pointer is `""` (the whole object) and code `unrecognized_keys`. `.strict()` is doing its job; chapter 05a showed the same for query parameters.

### Nested pointers in a bulk request

```console
$ curl -sS -D /tmp/api-learn-capture-EyvXSr/headers.txt -o /tmp/api-learn-capture-EyvXSr/body.bin --request PATCH http://localhost:4011/api/tenants/ten_acme/products/bulk -H 'Content-Type: application/json' --data-binary '{
  "updates": [
    { "id": "prd_tee", "priceCents": -100 }
  ]
}'
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 0a400366-21d0-42d7-a02b-a4a814ddd4bd
Content-Type: application/problem+json; charset=utf-8
Content-Length: 338
Date: Thu, 29 Oct 2026 12:26:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products/bulk","code":"validation_failed","errors":[{"pointer":"/updates/0/priceCents","code":"too_small","message":"Too small: expected number to be >=0"}]}
```

`/updates/0/priceCents` tells the client exactly which element and field. Without the index, a 50-item bulk request would be a guessing game. (The capture helper writes headers and body to temp files; the display above is the real response.)

### Semantic, not schema, failures

```console
$ curl -sS -D /tmp/api-learn-capture-EyvXSr/headers.txt -o /tmp/api-learn-capture-EyvXSr/body.bin --request PATCH http://localhost:4011/api/tenants/ten_acme/products/bulk -H 'Content-Type: application/json' --data-binary '{
  "updates": [
    { "id": "prd_tee", "priceCents": 2000, "expectedVersion": 999 },
    { "id": "prd_missing", "priceCents": 2000 }
  ]
}'
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 4c3907ca-ad3f-476d-a67c-8170a068e33f
Content-Type: application/problem+json; charset=utf-8
Content-Length: 445
Date: Thu, 29 Oct 2026 12:26:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/bulk_update_failed","title":"Validation Failed","status":422,"detail":"No products were changed because some updates failed.","instance":"/api/tenants/ten_acme/products/bulk","code":"bulk_update_failed","errors":[{"pointer":"/updates","code":"version_mismatch","message":"prd_tee: Expected version 999, found 1."},{"pointer":"/updates","code":"not_found","message":"prd_missing: Product not found."}]}
```

Here the body is schema-valid; the failures come from domain state. The top-level `code` changes to `bulk_update_failed`, and each entry names the item. The pointer is `/updates` rather than `/updates/0` because the store reports by ID, not index; that is a deliberate compromise (the client can still map by the ID in the message). Chapter 13b discusses making this richer with per-item result objects.

### A unique constraint is a conflict, not a validation error

```console
$ curl -sS -D /tmp/api-learn-capture-EyvXSr/headers.txt -o /tmp/api-learn-capture-EyvXSr/body.bin --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Content-Type: application/json' --data-binary '{
  "sku": "TEE-001",
  "slug": "duplicate-sku",
  "name": "Duplicate SKU",
  "priceCents": 1999,
  "currency": "USD",
  "stock": 1
}'
HTTP/1.1 409 Conflict
X-Request-Id: 68f5925b-33b4-4850-aad0-3809c41d308e
Content-Type: application/problem+json; charset=utf-8
Content-Length: 202
Date: Thu, 29 Oct 2026 12:26:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/sku_taken","title":"Conflict","status":409,"detail":"That SKU already exists for this tenant.","instance":"/api/tenants/ten_acme/products","code":"sku_taken"}
```

The payload is well-formed and each value is individually valid. The problem is the current state of the tenant. `409 sku_taken` is more useful than `422`, because the client can offer "open the existing product" rather than "fix your field". Do not force every business rule into `422`.

Matching `.http` file: [`requests/08b-validation-errors-error-codes.http`](../requests/08b-validation-errors-error-codes.http). Full capture: [`transcripts/08b-validation-errors-error-codes.txt`](../transcripts/08b-validation-errors-error-codes.txt).

---

## 4. Bad vs good

**Bad — first error only, no pointer, unsafe message**

```json
{ "error": "Invalid input: expected string, received number at sku" }
```

Problems:

- One error per round trip; a 20-field form becomes 20 requests.
- The field name is buried in prose; clients cannot reliably map it.
- The message may include internal schema details or values.
- No stable code; copy changes break clients.

**Bad — everything is 400, including state conflicts**

```http
HTTP/1.1 400 Bad Request

{ "message": "Product exists" }
```

The client cannot tell whether to fix the payload or resolve a conflict.

**Good — multiple structured errors, stable codes, correct status**

```json
{
  "code": "validation_failed",
  "errors": [
    { "pointer": "/sku", "code": "invalid_format", "message": "Use uppercase letters, digits, and hyphens." },
    { "pointer": "/priceCents", "code": "too_small", "message": "Too small: expected number to be >=0" }
  ]
}
```

**Trade-offs:**

- **Return all errors vs fail fast.** All errors is better UX but can reveal schema details to attackers. For public APIs, rate-limit validation-heavy endpoints and avoid echoing raw input values.
- **Zod's default messages vs custom ones.** Defaults are honest and stable-ish, but terse ("Too small: expected number to be >=0"). Custom messages read better but are another contract to maintain. This course uses custom messages for regex/format rules and defaults for numeric bounds.
- **Pointer to the array vs to the item.** `/updates/0/priceCents` is precise but couples the error to ordering; `/updates` with the ID in the message survives reordering. Choose per endpoint and document it.

---

## 5. In a real multi-tenant e-commerce platform

A spreadsheet importer sends 200 rows. The API validates every row and returns 14 errors with pointers like `/updates/37/priceCents`. The importer highlights 14 cells and imports nothing (all-or-nothing, chapter 13b). The operator fixes those cells and retries; the second attempt succeeds.

A storefront checkout sends an order with a negative quantity and an unknown product. The API returns `422` with `/items/0/quantity` (`too_small`) for the field problem, and a top-level `422 invalid_product` ("One or more products do not exist for this tenant") when the product lookup fails during order preparation. The checkout UI shows the quantity inline and the product message on the item row.

A partner retries a create after a timeout with the same idempotency key and a different body. That is `409 idempotency_key_reused` (chapter 12), not a validation error: the payload is fine; the key is already bound to another request.

The distinction matters for automation: `422` means "fix the request"; `409` means "resolve state"; `409 idempotency_key_reused` means "your retry logic is wrong".

---

## 6. When to use it and when NOT to

**Use `errors[]` when:**

- The request body or query has multiple fields.
- A client can map errors back to inputs.
- The failure is about the content of the request.

**When not to:**

- **Malformed JSON** — `400`, no field paths exist.
- **Authentication/authorization** — `401`/`403`, no field errors.
- **State conflicts** — `409`, maybe with a domain-specific extension, but not `errors[]` unless specific fields are at fault.
- **`500`** — never include internal field errors or stack details.
- **Huge batch failures** — 10,000 errors in one body is a DoS on the client. Cap the number of reported errors and summarize the rest (for example, "first 100 errors shown"). This API caps bulk updates at 50 items, so the worst case is bounded.

**Do not** put every domain rule into `422`. A coupon that expired is arguably a validation failure of the coupon, but chapter 25e returns `422 invalid_coupon` for expiry and `409 coupon_exhausted` for the redemption limit, because the first is about the coupon value and the second is about current state.

---

## 7. Common mistakes

1. **Stopping at the first validation error.** Slow, frustrating UX.
2. **Pointers that do not resolve** (`errors[0].field = "updates.0.price"` instead of `/updates/0/price`). JSON Pointer is the standard; use it.
3. **Forgetting to escape `~` and `/`** in pointer segments (rare, but RFC 6901 requires it).
4. **Unstable `code` values.** Clients switch on codes; renaming them is a breaking change.
5. **Leaking raw input values or internal regexes.** Attackers learn the schema; customers see secrets in logs.
6. **Using `422` for duplicates and conflicts.** `409` carries the state semantics.
7. **Using `400` for well-formed JSON that fails validation.** Loses the distinction chapter 03 established.
8. **Returning an unbounded error list for a batch.** Cap and summarize.
9. **Generic "Invalid input" messages.** They force support tickets.
10. **Inconsistent codes across endpoints for the same failure.** `invalid_format` here, `bad_format` there; chapter 22 reviews this.

---

## 8. Try it yourself

**Exercise.** Add a `POST /api/tenants/{tenantId}/products/{productId}/reviews` endpoint with body `{ rating, title, body }`. Write the Zod schema so that:

1. `rating` is an integer from 1 to 5.
2. `title` is 1–120 characters.
3. `body` is optional, max 2000 characters.
4. Unknown fields are rejected.

Then send a request with `rating: 6`, an empty title, and an extra `authorEmail` field. Before running it, predict the `errors[]` array (pointers, codes, order). Run it and compare. What order does Zod use?

**Hint.** `z.number().int().min(1).max(5)` produces `too_big` for 6. `z.string().min(1).max(120)` produces `too_small` for `""`. `.strict()` produces `unrecognized_keys` with pointer `""`. Zod reports issues in schema/parse order; do not promise clients a stable order, and do not make clients depend on it. If you want deterministic ordering, sort by pointer before returning. Also decide whether `rating: 6` should be `422 too_big` (schema) or a domain `422 invalid_rating`; both are defensible, but be consistent with the rest of the catalog.

---

## 9. Next

[09. Validation with Zod →](09-validation-zod.md)
