# 22. Consistency, naming, and API review

> **Run order:** Prisma server, port 4010, auth on.
>
> Every request below is copied from `transcripts/22-consistency-and-review.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

You walk into a shop where one door says **PUSH**, the next says **pull**, a third has a handle you are supposed to turn. All three doors work. You still hate the shop.

An API is the same. If one endpoint calls the page size `limit`, another calls it `perPage`, and a third calls it `pageSize`, every client developer has to remember which door is which. The individual endpoints can all be correct and the API still feels broken.

Consistency is the rule that **the same idea looks the same everywhere**, and a **review** is the moment where someone checks that rule before the code ships — with a list, not from memory.

---

## 2. Real name

**API consistency** (or **convention**) is a property of the whole surface, not of a single endpoint: the same naming, shapes, status codes, headers, and error format across resources. It is written down as a **style guide** and enforced in **API review**.

Three layers make it real:

1. **A written style guide.** Short rules with examples: JSON casing, timestamp format, ID format, money format, collection envelope, pagination parameters, error members, status-code mapping, header names. If it is not written, two reviewers will disagree and the codebase will follow whoever merged last.
2. **Shared code.** Rules that live only in a document decay. Rules that live in one shared module — a shared list-query schema, a shared pagination serializer, a single error handler — cannot be implemented differently in a new route without someone noticing.
3. **A review gate.** A checklist applied to every API change: naming, status codes, tenant scoping, errors, pagination, idempotency, caching, docs.

The four requests in this chapter are a **consistency audit**: each one hits a different resource and shows that the same conventions hold across all of them. Nothing new is implemented here; the chapter is about proving the surface is coherent and giving you the rules to keep it that way.

---

## 3. Example

### The rules that are shared in code

Every collection in the API uses one query schema, defined once:

```ts
// src/http/pagination.ts (excerpt)
export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).optional(),
    cursor: z.string().min(1).max(500).optional(),
    includeTotal: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();
```

Because `productListQuerySchema` and `customerListQuerySchema` both extend this shape, `limit` means the same thing, has the same bounds, and defaults the same way in every list endpoint. A new resource that invents `perPage` would have to bypass this module — visible in review.

Pages are serialized the same way:

```ts
// src/http/pagination.ts (excerpt)
export function pageMeta(
  result: { hasMore: boolean; nextCursor?: string | null; total?: number },
  query: ListQuery,
): PageMeta {
  return {
    limit: query.limit,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor ?? null,
    ...(query.offset !== undefined ? { offset: query.offset } : {}),
    ...(result.total !== undefined ? { total: result.total } : {}),
  };
}
```

`hasMore` and `nextCursor` are always present; `offset` and `total` appear only when they are meaningful. Clients can write one pagination loop for every collection.

Errors have exactly one shape, produced in one place:

```ts
// src/http/problem.ts (excerpt)
export function problemBody(req: Request, error: HttpProblem) {
  const base = {
    type: error.options.type ?? `https://api-learn.example/problems/${error.code}`,
    title: error.options.title ?? TITLES[error.status] ?? 'Error',
    status: error.status,
    detail: error.detail,
    instance: req.originalUrl,
    code: error.code,
    ...(error.options.errors ? { errors: error.options.errors } : {}),
    ...error.options.extensions,
  };
  return base;
}
```

No route builds error JSON by hand. `type` and `code` are derived from the same string (`forbidden` → `.../problems/forbidden`), so a client can branch on `code` and a human can open `type` in a browser.

The customer list route is a good sample of the conventions in practice — parse with the schema, check pagination mode, call the store with the tenant, serialize with the shared helper:

```ts
// src/routes/customers.ts (excerpt)
router.get('/', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const query = parseInput(customerListQuerySchema, req.query);
  assertPaginationMode(query);
  const result = await store.listCustomers(tenantId, {
    q: query.q,
    status: query.status,
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
    cursor: query.cursor,
    includeTotal: query.includeTotal,
  });
  noStore(res);
  res.status(200).json({
    data: result.items.map(customerDto),
    pagination: pageMeta(result, {
      limit: query.limit,
      offset: query.offset,
      cursor: query.cursor,
      includeTotal: query.includeTotal,
    }),
  });
});
```

Every list route in the project follows these five lines in the same order. That is the pattern a reviewer checks for.

### The written rules

The style guide this course follows, as a reviewable table:

| Concern | Rule | Where it is enforced |
| --- | --- | --- |
| Paths | plural nouns, `/v1/tenants/{tenantId}/<resource>`, no verbs except action sub-resources (`/ban`, `/payments`) | review + `openapi.ts` |
| JSON fields | `camelCase` | DTOs |
| Query parameters | `camelCase` (`includeTotal`, `minPriceCents`), never `snake_case` | Zod schemas |
| IDs | opaque, prefixed: `prd_`, `cus_`, `ord_`, `pay_`, `op_`, `whe_` | `src/lib/ids.ts` |
| Money | integer minor units + ISO 4217 currency, never floats | DTOs + Zod |
| Time | ISO 8601 UTC with milliseconds (`2026-10-29T12:29:29.000Z`) | `iso()` |
| Single resource | bare object | DTO |
| Collection | `{ "data": [...], "pagination": {...} }` | `pageMeta` |
| Missing resource | `404` + `not_found` problem | `notFound()` |
| Validation failure | `422` + `validation_failed` + `errors[]` pointers | `parseInput` |
| State conflict | `409` + specific `code` (`sku_taken`, `coupon_exhausted`) | route/service |
| Cache headers | reads: `private, max-age=60` + `Vary`; collections and private state: `no-store` | `sendCacheable` / `noStore` |
| Sensitive fields | never in list responses (webhook `secret`) | DTOs |
| Tenant scope | tenant from the verified token, compared to the path | `tenantScope` |

### The audit requests (actual)

Single resource — bare object, canonical fields:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/products/prd_tee -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 0d3bce1b-3eb0-4322-abbe-3aa5e27e459e
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:29:29 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:29:18.671Z"}
```

No envelope on a single resource, `priceCents` is an integer, timestamps end in `Z`, the ID is prefixed.

Collection — same item shape inside `data`, pagination in one shared place:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/products?limit=2 -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 10301498-2058-4b66-9352-697cfe0c0a35
Content-Type: application/json; charset=utf-8
Content-Length: 668
Date: Thu, 29 Oct 2026 12:29:29 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","sku":"CAP-001","slug":"running-cap","name":"Running Cap","description":"Lightweight cap.","priceCents":2499,"currency":"USD","stock":0,"active":false,"version":1,"createdAt":"2026-01-01T12:00:00.000Z","updatedAt":"2026-10-29T12:29:18.671Z"},{"id":"prd_hoodie","sku":"HOO-001","slug":"trail-hoodie","name":"Trail Hoodie","description":"Fleece-lined hoodie.","priceCents":4999,"currency":"USD","stock":8,"active":true,"version":1,"createdAt":"2026-01-01T11:00:00.000Z","updatedAt":"2026-10-29T12:29:18.671Z"}],"pagination":{"limit":2,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDExOjAwOjAwLjAwMFoiLCJpZCI6InByZF9ob29kaWUifQ"}}
```

The items are byte-for-byte the same `Product` DTO as the single-resource response. That is not an accident of this route; `productDto` is the only serializer.

Error — the same five core members plus `code` and a stable `type`:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/products/prd_missing -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 404 Not Found
X-Request-Id: 6aad89d8-1b3e-4b1c-ad16-30be9106332e
Content-Type: application/problem+json; charset=utf-8
Content-Length: 192
Date: Thu, 29 Oct 2026 12:29:29 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"Product not found.","instance":"/v1/tenants/ten_acme/products/prd_missing","code":"not_found"}
```

A different resource — same envelope, same parameter names, same timestamp format:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/customers\?limit=2\&sort=name\&includeTotal=true -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 40a4b8b8-ad24-49fe-8006-1026b174aae8
Content-Type: application/json; charset=utf-8
Content-Length: 601
Date: Thu, 29 Oct 2026 12:29:29 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"cus_acme_27","email":"alice.cooper.27@example.com","name":"Alice Cooper","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-27T09:00:00.000Z","updatedAt":"2026-10-29T12:29:18.686Z"},{"id":"cus_acme_01","email":"alice.johnson.1@example.com","name":"Alice Johnson","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:29:18.686Z"}],"pagination":{"limit":2,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDA5OjAwOjAwLjAwMFoiLCJpZCI6ImN1c19hY21lXzAxIn0","total":30}}
```

Same envelope, same `limit`/`hasMore`/`nextCursor` names, same timestamp format — and `total` appears only because `includeTotal=true` was sent.

### The review workflow

A review pass over an API change, in order:

1. **Read the route, not the diff.** Ask what resource is exposed, what the method means, and which status codes can come out. A diff that only adds fields to a DTO rarely breaks a contract; a new route always can.
2. **Check the shape against the style table** above. Field names, envelope, ID prefix, money, time.
3. **Check the unhappy paths.** For every `if` in the handler ask: which status, which `code`, does the body match `Problem`? Is `errors[]` used for field-level failures?
4. **Check the tenant.** Is `tenantIdOf(req)` the only tenant source? Is every store call passed the tenant? Does a missing row become 404 inside the tenant rather than 403 across tenants?
5. **Check state-changing semantics.** Is the operation idempotent where it must be (12), guarded by `If-Match` where it should be (13c), and does a failure leave nothing half-written (13b)?
6. **Check the document.** Does `/openapi.json` describe the new route, with the same required fields the Zod schema enforces? Add a real response body to the PR description so the reviewer can compare (chapter 21).
7. **Check the request file.** A new `.http` file with the golden path plus at least one failure, captured from a real run (the protocol in `docs/00-roadmap.md` §4.2).

The first four checks catch most drift; the last three catch the things that only show up in production.

---

## 4. Bad vs good

**Bad:** three list endpoints, three dialects.

```ts
// Bad: same idea, three spellings
GET /products?per_page=20&page=2&sort_by=name
// → { "items": [...], "meta": { "total_count": 30 } }

GET /customers?pageSize=20&offset=40&order=name
// → { "results": [...], "pageInfo": { "total": 30 } }

GET /orders?limit=20&skip=40&sort=name
// → [ ... ]   // bare array, no pagination at all
```

Every client now needs three adapters. Every bug report about pagination needs a fourth question: "which endpoint?" And the bare array cannot gain a `total` later without a breaking change.

**Good:** one contract, extended per resource.

```ts
// Good: src/http/pagination.ts, src/http/problem.ts
listQuerySchema           // limit, offset, cursor, includeTotal
pageMeta(result, query)   // limit, hasMore, nextCursor (+ offset, total when present)
problemBody(req, error)   // type, title, status, detail, instance, code, errors[]
```

The resource schemas extend the shared list schema (adding `q`, `status`, `sort`, `fields`), and DTOs handle the item shape. A reviewer can check the four requests above and see the contract holds.

**Also bad:** consistency enforced only by a document.

```
# Bad: a wiki page that says "use camelCase" while the code has price_cents
```

Nobody reads the wiki during a deadline. Shared modules and a checklist in the PR template survive deadlines; prose does not.

**Also good:** a consistency linter in CI.

```ts
// What a small check can assert without a linter library:
// - every path under /v1 starts with /v1/tenants/{tenantId}/ (except /health)
// - every error response content type is application/problem+json
// - every collection response schema contains data + pagination
// - every query parameter name matches /^[a-z][a-zA-Z0-9]*$/
```

Running those four assertions against `buildOpenApiDocument()` takes milliseconds and fails the build when someone adds `/v1/products` or returns `application/json` for errors. This project does not ship that check yet; it is the natural next step after chapter 21.

---

## 5. In a real multi-tenant e-commerce platform

The support console lists customers for one tenant, the admin console manages products, and the fraud team works with bans. Three front-ends, one API.

Because `limit`, `cursor`, `includeTotal`, the `{ data, pagination }` envelope, and the problem members are identical everywhere, the consoles share a single `fetchPage()` helper and a single `showProblem()` toast. When support says "the list jumped and I lost my place", the answer is the same cursor fix for every screen.

Tenant consistency has a second meaning: **the same tenant boundary on every resource**. A product fetch, a customer ban, an export poll, and a webhook delivery list all read the tenant from `tenantIdOf(req)` (the token-verified value), never from the body or a query string. An audit of chapter 17's pipeline therefore covers all 19 paths at once. Inconsistent tenant handling — one route trusting `req.query.tenantId` — is the single most dangerous inconsistency in a multi-tenant API, because it is invisible until someone exploits it.

---

## 6. When to use it and when NOT

**Use a style guide and review gate when:**

- More than one developer writes endpoints, or one developer writes them over a long time.
- External consumers exist; every inconsistency is a support ticket in someone else's codebase.
- You generate clients or docs; generators amplify inconsistencies into compile errors.
- You have patterns that must not be re-invented per endpoint: idempotency, pagination, errors, tenant scoping.

**Do not over-standardize:**

- **Do not force one status-code mapping for genuinely different semantics.** `409` with specific codes (`sku_taken`, `coupon_exhausted`, `idempotency_key_reused`) is consistency; collapsing all of them to `400` is uniformity that costs information.
- **Do not standardize payloads that answer different questions.** `Order` and `Product` do not need the same fields; they need the same *conventions*.
- **Do not make the checklist a rubber stamp.** A list that is ticked without reading the route is worse than no list, because it creates false confidence.
- **Do not chase consistency across API generations.** A `/v2` that changes the envelope is allowed to differ; document the mapping instead of contorting `/v1`.

---

## 7. Common mistakes

1. **Consistency drift after a new hire.** New endpoints copy the *closest* existing route instead of the style guide, and the closest route was already wrong. Fix: review against the table, not against neighbouring code.
2. **`snake_case` leaking from the database.** A DTO that spreads a Prisma row exposes `price_cents`. Chapter 10's whitelisting prevents it; the review checklist catches it when it slips.
3. **A second error shape.** One route returns `{ error: "Not found" }`; clients now need two parsers. This is almost always a route that built JSON by hand instead of throwing `HttpProblem`.
4. **Inconsistent pagination.** A list adds `page` next to `limit`, or returns `total` without `includeTotal`, and now the client's shared loop is wrong for one screen.
5. **Tenant handling that differs per route.** Path only, token only, body sometimes. Any difference is a potential cross-tenant bug; one helper (`tenantIdOf`) and one middleware (`tenantScope`) should be the only sources.
6. **Timestamps in different formats.** `createdAt` as epoch millis on one resource and ISO on another. Pick ISO 8601 UTC, everywhere (chapter 7).
7. **Money as a float in one endpoint.** `price: 19.99` next to `priceCents: 1999` invites rounding bugs and double conversions.
8. **Headers that appear only sometimes.** `ETag` on products but not customers; `Retry-After` on one 429 path. Clients end up with `if (endpoint === ...)`.
9. **Reviewing the happy path only.** The 200 was checked; the 409 body was invented in the PR text and never run. The checklist item "run one failure" exists for this.
10. **Documenting a convention but not testing it.** No request in CI exercises the cursor rule on customers, so the shared code drifts in one resource unnoticed.

---

## 8. Try it yourself

Review this proposed endpoint against the style guide, then fix it.

```ts
// Proposed: GET /v1/tenants/:tenantId/suppliers?per_page=20&sort_by=name
router.get('/:tenantId/suppliers', async (req, res) => {
  const suppliers = await prisma.supplier.findMany({
    where: { tenantId: req.params.tenantId },
    take: Number(req.query.per_page ?? 20),
    orderBy: { name: req.query.sort_dir === 'desc' ? 'desc' : 'asc' },
  });
  res.json(
    suppliers.map((s) => ({
      id: s.id,
      tenant_id: s.tenantId,
      name: s.name,
      created_at: s.createdAt,
    })),
  );
});
```

Find at least five violations of the table in section 3, then write the version you would approve. The endpoint deliberately has no auth middleware in the snippet; treat that as a sixth finding rather than something to fix in the query.

**Hint:** compare each line with the audit requests above. Parameter name (`per_page`, `sort_by`, `sort_dir`), envelope (bare array), casing (`tenant_id`, `created_at`), DTO leakage (`tenant_id` should not be exposed at all), raw `Number()` instead of the shared list schema, and `req.params.tenantId` used directly instead of the token-verified tenant. The approved version parses `listQuerySchema`, calls `store.listSuppliers(tenantIdOf(req), query)`, maps through `supplierDto`, and returns `{ data, pagination: pageMeta(...) }` with the standard problem handler for failures.

---

## 9. Next

So far every chapter has assumed REST is the right tool. Chapter 23 asks the opposite question — when GraphQL or tRPC would serve a consumer better, and why this public, multi-tenant commerce API still chooses REST.

Next: [23. Alternatives: GraphQL and tRPC](23-graphql-trpc-alternatives.md)
