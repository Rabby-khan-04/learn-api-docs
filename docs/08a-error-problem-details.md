# 08a. Error design: RFC 9457 Problem Details

> **Run order:** in-memory server, port 4011, auth off.
>
> Every request below is copied from `transcripts/08a-error-problem-details.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

When something goes wrong at a shop, you want a note that says:

- **what kind of problem** it is (using a fixed word from a list, so a machine knows),
- **a short title** for humans,
- **how serious** it is (the status number),
- **what exactly happened** in this case,
- **where** it happened (which page, which form),
- **a stable code** your program can check.

What you do not want is a giant crash diary with the shop's secret notes. That scares customers and helps attackers.

RFC 9457 is the standard shape for that note.

---

## 2. Real name

**RFC 9457 — Problem Details for HTTP APIs** (which obsoletes RFC 7807) defines a JSON (or XML) format for error bodies with media type `application/problem+json`.

Standard members:

| Member | Type | Meaning |
|---|---|---|
| `type` | URI | Identifies the problem *type*. Dereferenceable to docs. Defaults to `about:blank`. |
| `title` | string | Short, human-readable summary of the type. Should be stable for the type. |
| `status` | integer | HTTP status code, repeated for consumers that only log the body. |
| `detail` | string | Human-readable explanation of *this occurrence*. |
| `instance` | URI | Identifies *this occurrence* (often the request URL). |

Extension members are allowed and are where the useful API-specific data lives. This course adds:

| Member | Type | Meaning |
|---|---|---|
| `code` | string | Stable machine-readable code (`sku_taken`, `invalid_cursor`). This is what clients switch on. |
| `errors` | array | Field-level errors: `pointer`, `code`, `message` (chapter 08b). |
| `currentVersion` | integer | Present on `412` concurrency failures (chapter 13c). |
| `operationStatus` | string | Present on `409` for incomplete exports (chapter 18). |
| `retryAfterSeconds` | integer | Mirrors `Retry-After` on `429` (chapter 16). |

Design rules:

1. **One error format for every endpoint.** A client writes one parser.
2. **Status code and `status` agree.** A mismatch is a bug.
3. **`code` is the contract.** Do not rename it; do not make clients match English `detail`.
4. **`detail` is for humans and must be safe.** No stack traces, SQL, internal IDs, or secrets.
5. **`instance` is the request URL**, including the query string, so support can reproduce.
6. **`type` is stable.** If it is a real URL, it must resolve; if it is an example domain, say so.
7. **Never put an error body on `204`**, and never return a success body with an error status.
8. **`401` still needs `WWW-Authenticate`; `429` still needs `Retry-After`.** The body is not a substitute for headers.

RFC 9457 does not define error *codes* or field errors; that is why `code` and `errors[]` are extensions here. Stripe uses `{"error": {...}}` and Azure uses `{"error": {"code", "message"}}`; both are sensible vendor formats, but a standard shape plus extensions lets generic tooling understand the outer layer.

---

## 3. Example

The central error type and serializer:

```ts
// src/http/problem.ts (excerpt, comments added)
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly options: {
      title?: string;
      type?: string;
      errors?: ProblemFieldError[];
      headers?: Record<string, string>;
      extensions?: Record<string, unknown>;
    } = {},
  ) { super(detail); }
}

export function problemBody(req: Request, error: HttpProblem) {
  return {
    type: error.options.type ?? `https://api-learn.example/problems/${error.code}`,
    title: error.options.title ?? TITLES[error.status] ?? 'Error',
    status: error.status,
    detail: error.detail,
    instance: req.originalUrl,           // includes path + query
    code: error.code,
    ...(error.options.errors ? { errors: error.options.errors } : {}),
    ...error.options.extensions,          // currentVersion, operationStatus, ...
  };
}
```

Handlers never build error JSON:

```ts
// src/routes/products.ts (excerpt)
const record = await store.findProduct(tenantId, productId);
if (!record) throw notFound('Product not found.'); // one middleware formats it
```

### `404` for a missing resource

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_missing
HTTP/1.1 404 Not Found
X-Request-Id: 7b3b4447-41f0-4572-8d15-28603e57cc21
Content-Type: application/problem+json; charset=utf-8
Content-Length: 193
Date: Thu, 29 Oct 2026 12:26:55 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"Product not found.","instance":"/api/tenants/ten_acme/products/prd_missing","code":"not_found"}
```

`type` names the problem class; `detail` says what this occurrence found. A UI can show `detail`; a program switches on `code` and `status`.

### `400` for malformed JSON

```console
$ curl -sS -i --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Content-Type: application/json' --data-binary '{"sku": "BAD-001",'
HTTP/1.1 400 Bad Request
X-Request-Id: a4a48547-1f98-4334-a4b6-c4ac26b0471e
Content-Type: application/problem+json; charset=utf-8
Content-Length: 210
Date: Thu, 29 Oct 2026 12:26:55 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/malformed_json","title":"Bad Request","status":400,"detail":"The request body is not valid JSON.","instance":"/api/tenants/ten_acme/products","code":"malformed_json"}
```

No `errors[]`: there is no field path to point at when the document cannot be parsed.

### `422` with field errors

```console
$ curl -sS -i --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Content-Type: application/json' --data-binary '{
  "sku": "tee-1",
  "slug": "Bad Slug",
  "name": "",
  "priceCents": -1,
  "currency": "usd",
  "stock": 1.5
}'
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 7934cd77-8d4b-43a6-9c36-400a467ab0a3
Content-Type: application/problem+json; charset=utf-8
Content-Length: 829
Date: Thu, 29 Oct 2026 12:26:55 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products","code":"validation_failed","errors":[{"pointer":"/sku","code":"invalid_format","message":"Use uppercase letters, digits, and hyphens."},{"pointer":"/slug","code":"invalid_format","message":"Use lowercase letters, digits, and hyphens."},{"pointer":"/name","code":"too_small","message":"Too small: expected string to have >=1 characters"},{"pointer":"/priceCents","code":"too_small","message":"Too small: expected number to be >=0"},{"pointer":"/currency","code":"invalid_format","message":"Use a three-letter ISO 4217 code such as USD."},{"pointer":"/stock","code":"invalid_type","message":"Invalid input: expected int, received number"}]}
```

Six violations in one response. A client can highlight every bad field at once. Chapter 08b dissects the `errors[]` contract.

### `404` for an unknown route

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/invoices
HTTP/1.1 404 Not Found
X-Request-Id: 9df08701-7d1e-4af9-ae69-4012262d14c2
Content-Type: application/problem+json; charset=utf-8
Content-Length: 215
Date: Thu, 29 Oct 2026 12:26:55 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"No route matches GET /api/tenants/ten_acme/invoices.","instance":"/api/tenants/ten_acme/invoices","code":"not_found"}
```

The catch-all middleware still returns the same shape. An unknown URL and a missing product are both `not_found`, but the `detail` distinguishes them. If you want them distinguishable by machines, add a distinct code (`route_not_found`); this API keeps one code and accepts the ambiguity for a teaching surface.

### A successful response is not a problem document

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_tee
HTTP/1.1 200 OK
X-Request-Id: fc61061c-e301-48ae-a3e0-ba433575df96
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:26:55 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}
```

Note the media type: success is `application/json`, errors are `application/problem+json`. A client can branch on `Content-Type` alone if it wants to.

Matching `.http` file: [`requests/08a-error-problem-details.http`](../requests/08a-error-problem-details.http). Full capture: [`transcripts/08a-error-problem-details.txt`](../transcripts/08a-error-problem-details.txt).

---

## 4. Bad vs good

**Bad — three formats in one API**

```http
HTTP/1.1 400 Bad Request
Content-Type: text/html

<html><body>Error: invalid input</body></html>
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "success": false, "message": "Validation error", "errors": ["bad sku"] }
```

```http
HTTP/1.1 500 Internal Server Error
Content-Type: text/plain

PrismaClientKnownRequestError: Unique constraint failed on the fields: (`sku`)
    at ... /srv/app/node_modules/@prisma/client/...
```

Problems:

- Three parsers, three behaviours, three places to forget.
- HTML in an API breaks every JSON client.
- `200` with failure defeats every piece of HTTP infrastructure (chapter 03).
- The `500` leaks schema and file paths; an attacker learns your stack and your table names.

**Good — one problem shape, safe details**

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{
  "type": "https://api-learn.example/problems/sku_taken",
  "title": "Conflict",
  "status": 409,
  "detail": "That SKU already exists for this tenant.",
  "instance": "/api/tenants/ten_acme/products",
  "code": "sku_taken"
}
```

**Trade-offs:**

- **Problem Details vs vendor envelopes.** RFC 9457 is standard and self-describing, but clients built for Stripe/Azure expect their envelope. A mapper can adapt; changing your API per client cannot.
- **`type` as a real URL.** Dereferenceable type URLs are excellent documentation but require hosting and stability. This course uses `https://api-learn.example/...` as a clearly non-production namespace. Do not use a domain you do not control.
- **`detail` text.** Stable, useful text helps humans; but clients must never parse it. Keep the machine contract in `code` and `errors[]`.
- **`instance` including the query string.** Great for support, but be careful: query strings can contain sensitive values (tokens in badly designed APIs). This API keeps credentials in headers, so the URL is safe to echo.

---

## 5. In a real multi-tenant e-commerce platform

A partner's bulk importer gets a `422` with six field errors. It maps `pointer` to spreadsheet columns and shows a red cell per error, instead of failing the whole file on the first problem.

A mobile app gets a `409 sku_taken` while creating a product. It shows "SKU already used by another product in your shop" and focuses the SKU field. It does not parse a 500.

A support engineer sees `X-Request-Id: 7b3b4447-...` in a customer ticket. The API logged the same ID with the full internal error; the customer-facing body only had the safe summary. That is the split: internal detail in logs, safe problem details on the wire.

A tenant admin hits `403` because their token belongs to another tenant. The `code` is `forbidden`; the app does not retry with the same token, because chapter 17's contract says it will never work.

---

## 6. When to use it and when NOT to

**Use RFC 9457 when:**

- The API is HTTP/JSON and consumed by more than one client.
- You want standard tooling and a predictable parser.
- You need both human-readable and machine-readable error information.

**When not to:**

- **Streaming or binary protocols** (gRPC) have their own status model; do not bolt JSON problem details onto them.
- **Non-HTTP transports** (message queues) need their own error envelope.
- **A single internal consumer with generated types** may prefer a typed union; the wire format can still be Problem Details, but the client does not need to parse strings.
- **`204` responses**: there is no body by definition.

**Do not** switch formats per endpoint. If one endpoint returns Problem Details and another returns `{error}`, you have two APIs.

---

## 7. Common mistakes

1. **Leaking stack traces, SQL, or ORM errors.** A `500` body should be generic; details go to logs with the request ID.
2. **Status/body mismatch.** `{"status": 200}` on a `422`, or `title` saying "Not Found" with `status: 500`.
3. **Missing `code`.** Clients then parse `detail` and break when copy changes.
4. **Unstable `type` URLs.** Changing the path breaks clients that switch on it.
5. **`errors[]` with human sentences but no pointers.** Chapter 08b fixes this.
6. **Omitting `WWW-Authenticate` on `401`.** RFC 9110 requires it; the body does not satisfy the requirement.
7. **Omitting `Retry-After` on `429`.** Clients cannot back off correctly.
8. **Returning a 200 HTML error page from a proxy.** Configure gateways to emit your problem shape too.
9. **Using `detail` for secrets.** It is logged by clients and often shown to end users.
10. **Different shapes for auth vs validation vs not-found.** One shape, many codes.

---

## 8. Try it yourself

**Exercise.** Add a `POST /api/tenants/{tenantId}/products/{productId}/archive` action that returns `409` if the product is already archived. Design its problem body before writing code:

1. What `code` would you use?
2. What `type` URI?
3. What belongs in `detail`?
4. Does it need `errors[]`?
5. What `title`?

**Hint.** Look at existing codes (`sku_taken`, `coupon_already_applied`, `invalid_order_state`). A good code is lowercase snake_case and names the condition, not the endpoint. `errors[]` is for field-level violations; a state conflict is not a field error, so it is usually absent. Use the standard title for the status ("Conflict") unless you have a more specific stable title. Run the endpoint and paste the real response into the chapter, not an imagined one.

---

## 9. Next

[08b. Error design: validation errors and codes →](08b-validation-errors-error-codes.md)
