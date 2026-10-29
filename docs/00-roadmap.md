# REST API Design — Beginner to Advanced

**Project:** multi-tenant e-commerce API, built and tested chapter by chapter.

**Status:** complete. All 35 chapters, the running API, the `.http` request files, and the `curl` transcripts are written and verified on 2026-10-29.

**Review model:** you waived the original batch-by-batch pauses ("do everything in one go and I will review them at once"), so the whole course was delivered in one pass. Every chapter still follows the same 9-section template and the verification protocol below.

**Last updated:** 2026-10-29

---

## 1. What you will be able to do

By the end of this course you will be able to:

- Design resource-oriented endpoints for a multi-tenant e-commerce platform.
- Choose methods and status codes deliberately, not by habit.
- Design list endpoints with filters, search, sorting, field selection, and cursor pagination.
- Return stable JSON: opaque IDs, ISO 8601 UTC timestamps, integer minor units plus currency.
- Return machine-readable errors with RFC 9457 Problem Details and field-level validation.
- Validate every input at the boundary with Zod, and shape every output through DTOs.
- Make order creation and payments safe to retry with idempotency keys and transactions.
- Handle partial updates, bulk operations, and lost-update conflicts with ETags and `If-Match`.
- Version and deprecate an API without breaking existing clients.
- Cache safely, rate limit with standard headers, and scope every query to a tenant.
- Model long-running jobs, uploads, and signed webhooks.
- Generate OpenAPI 3.2 from the same Zod schemas used at runtime.
- Review an API against a checklist and recognize the mistakes that cause production incidents.

---

## 2. The platform we will build

A platform where one deployment serves many shops (**tenants**). Each tenant has its own products, customers, orders, coupons, and fraud events. Tenant rows never mix.

```
Tenant (ten_acme, ten_globex, ...)
 ├── Product          priceCents + currency, stock, version
 ├── Customer         email unique per tenant, bannedAt, banReason
 ├── Order            status, totals in minor units, idempotencyKeyId
 │    └── OrderItem
 ├── Coupon           PERCENT | FIXED, startsAt/endsAt, maxRedemptions
 │    └── CouponRedemption
 ├── Payment
 ├── FraudEvent
 ├── IdempotencyKey   key + requestHash + stored response
 └── (later) WebhookEndpoint, WebhookDelivery, Upload, Operation
```

Design rules used in every chapter:

| Concern | Convention |
|---|---|
| Tenant scoping | Every tenant-owned row has `tenantId`; every query filters by it. Missing it is a **danger demo**. |
| IDs | Opaque, prefixed strings: `prd_...`, `cus_...`, `ord_...`. Never expose auto-increment integers. |
| Money | Integer **minor units** (`priceCents: 1999`) plus ISO 4217 `currency: "USD"`. No floats. |
| Time | ISO 8601 UTC string: `2026-10-29T11:33:04.000Z`. Never local time. |
| Casing | `camelCase` JSON fields, `kebab-case` query parameters, plural nouns in paths. |
| Errors | `application/problem+json` with `type`, `title`, `status`, `detail`, `code`, and `errors[]`. |
| Secrets | No real credentials. No third-party calls. Local throwaway infrastructure only. |

Store evolution:

- **Chapters 01–10:** in-memory store. Fast feedback, focus on HTTP and JSON design.
- **Chapter 11:** move to PostgreSQL 17 + Prisma 7 (reusing the patterns from your `prisma/prisma-learn` project) because idempotency, concurrency, and pagination need real constraints and transactions.
- **Chapters 12–26:** PostgreSQL.

URL evolution:

- **Chapters 01–13:** mounted at `/api/...`.
- **Chapter 14:** introduce `/v1/...`, keep `/api` as a deprecated alias with `Deprecation`/`Sunset` headers. This makes versioning a real migration, not a slide.
- **Chapters 15–26:** `/v1/...`.

---

## 3. Environment (verified, not assumed)

Everything below was read from the actual machine on 2026-10-29.

| Tool | Version | Notes |
|---|---|---|
| Node.js | **24.19.0** | `engines.node >= 24` |
| npm | **11.17.0** | |
| Express | **5.3.0** | Express 5; no deprecated Express 4 patterns |
| Zod | **4.6.7** | Includes `z.toJSONSchema()` for OpenAPI generation |
| TypeScript | **5.9.3** | strict mode, `NodeNext` modules, `noUncheckedIndexedAccess` |
| tsx | **4.23.15** | runs TypeScript directly |
| @types/express | **5.0.6** | |
| @types/node | **24.10.1** | |
| PostgreSQL | **17** | dedicated throwaway container `api-learn-db`, port 5434, from chapter 11 |
| Prisma | **7.10.1** | `prisma-client` generator, `@prisma/adapter-pg`, `prisma.config.ts` safety gate |
| OpenAPI | **3.2.0** | current specification, released 2025-09-23 |

Baseline run (actual output):

```console
$ node --version
v24.19.0

$ npm ls express zod typescript tsx --depth=0
api-learn@1.0.0 /home/sunny/app/nimo/rest-api-design/api-learn
├── express@5.3.0
├── tsx@4.23.15
├── typescript@5.9.3
└── zod@4.6.7
```

```console
$ curl -sS -i http://localhost:4010/health
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 15
ETag: W/"f-VaSQ4oDUiZblZNAEkkN+sX+q3Sg"
Date: Thu, 29 Oct 2026 11:33:04 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"status":"ok"}
```

Two deliberate observations:

- Express sends a weak `ETag` even on this trivial response. Chapter 15 explains what that means and when it is wrong.
- `X-Powered-By` advertises the framework. It is visible in this **baseline** capture on purpose; the finished API removes it (`app.disable('x-powered-by')`) and disables the default ETag (`app.set('etag', false)`) in chapter 10, and every later transcript reflects that. To see the baseline again, run the memory server from the first commit of the chapter-01 snapshot.

**Database plan:** a dedicated throwaway container `api-learn-db` on **port 5434** (port 5433 is already occupied by another project's database), database `api_learn`, user `postgres`, password `learn`. A Prisma config safety gate will refuse any URL that is not localhost + port 5434 + `/api_learn`, mirroring the gate in your existing Prisma project. Nothing outside `api-learn/` is written to.

---

## 4. How this course works

### 4.1 Chapter template (every chapter, all 9 sections)

1. **Simple explanation (like I'm 7):** short sentences, everyday analogy, no jargon.
2. **Real name:** the HTTP/API term and its technical definition.
3. **Example:** complete endpoint code with comments on important lines, plus exact `curl` requests and full responses.
4. **Bad vs good:** the bad design next to the better design, and why.
5. **In a real multi-tenant e-commerce platform:** one concrete scenario.
6. **When to use it and when NOT to.**
7. **Common mistakes.**
8. **Try it yourself:** one exercise with a hint.
9. **Next:** link to the next chapter.

### 4.2 Verification protocol

- Every endpoint is started locally and every request is run with `curl` before it appears in a chapter.
- Responses in chapters are pasted from actual terminal output, including headers where they matter. No invented output.
- Each chapter ships a matching `requests/NN-....http` file for the REST Client so you can replay the same calls.
- A chapter is not "done" until `npm run typecheck` passes and the requests were re-run after the final code edit.
- Exact I/O is captured once per chapter; if OS/date values are variable, the chapter says so.

### 4.3 Danger demos

Any example that leaves out `tenantId` — even intentionally — is fenced as:

> **DANGER DEMO — DO NOT SHIP.** No tenant filter. This returns other tenants' data.

Production examples always receive the tenant from the path *and* verify it against the authenticated principal (chapter 17).

### 4.4 Build-up rule

No concept is used before it is explained. If a later idea is needed early (for example, a status code before chapter 3), the chapter either avoids it or explicitly defers it. Data shapes also grow gradually: prices and timestamps appear only after chapter 7 explains their conventions.

### 4.5 Delivery

Work was originally planned in batches of 3–5 chapters with a pause for review. You asked for everything in one pass, so the batches were waived and the full course was delivered at once. The chapter template, the danger-demo rule, and the verification protocol were not relaxed.

---

## 5. Sources of truth, and how disagreements are handled

Primary sources:

- [MDN — HTTP](https://developer.mozilla.org/en-US/docs/Web/HTTP)
- [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- [RFC 9111 — HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html)
- [RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)
- [RFC 9745 — The Deprecation HTTP Response Header Field](https://www.rfc-editor.org/rfc/rfc9745.html) (March 2025)
- [RFC 8594 — The Sunset HTTP Header Field](https://www.rfc-editor.org/rfc/rfc8594.html) (May 2019)
- [RFC 9651 — Structured Field Values for HTTP](https://www.rfc-editor.org/rfc/rfc9651.html)
- [RFC 7396 — JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396.html)
- [RFC 6902 — JSON Patch](https://www.rfc-editor.org/rfc/rfc6902.html)
- [OpenAPI Specification 3.2.0](https://spec.openapis.org/oas/v3.2.0.html)
- [Stripe API reference](https://docs.stripe.com/api), especially [errors](https://docs.stripe.com/api/errors), [idempotent requests](https://docs.stripe.com/api/idempotent_requests), [versioning](https://docs.stripe.com/api/versioning)
- [Microsoft Azure REST API Guidelines](https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md)
- [Google API Improvement Proposals (AIPs)](https://google.aip.dev/)
- [Zod documentation — JSON Schema](https://zod.dev/json-schema)
- [Prisma 7 documentation](https://www.prisma.io/docs)

Known disagreements and the position this course takes:

| Topic | Positions in the wild | Our default | Trade-off |
|---|---|---|---|
| Error body | RFC 9457 `application/problem+json`; Stripe `{"error":{...}}`; Azure `{"error":{"code","message"}}` | RFC 9457 + `code` + `errors[]` extension members | Standards-based and self-describing, but clients expecting a vendor envelope need a mapper. |
| Validation status | Stripe returns `400` for most validation failures; RFC 9110 defines `422`; conventions vary by vendor | `400` for malformed JSON; `422` for well-formed JSON that fails the schema/semantics | Distinguishes "could not parse" from "parsed, but rejected"; some clients treat all 4xx alike anyway. |
| Versioning | URL major (`/v1`, GitHub); dated header (`Stripe-Version`); query (`api-version=...`, Azure) | URL major + additive-only evolution | Easy to see and cache; coarse-grained, and a new major means a new URL surface. |
| Partial update | `PUT` full replace; `PATCH` JSON Merge Patch (RFC 7396); JSON Patch (RFC 6902) | `PUT` full replace, `PATCH` merge patch, both guarded by `If-Match` | Merge patch cannot express "set to null" vs "remove" without care; JSON Patch is more powerful but harder to use. |
| List shape | Bare array; `{data, has_more}` (Stripe); `{value, nextLink}` (Azure) | Envelope with `data` + pagination metadata for collections; bare object for single resources | Envelopes allow metadata; bare arrays are simpler but cannot evolve. |
| Pagination | Offset/page; cursor | Cursor by default; offset only for admin/export when random access is required | Cursor is stable and fast but cannot jump to page N and makes totals expensive. |
| IDs | Auto-increment integers; UUIDs; prefixed opaque IDs | Prefixed opaque strings | Debuggable and non-enumerable; slightly longer payloads and requires prefix validation. |
| Tenant identity | Path; subdomain; token claim | Path in this course, plus token-claim verification in production | Explicit and easy to audit; a path alone is never authorization. |
| Rate-limit headers | IETF `RateLimit`/`RateLimit-Policy` (still an Internet-Draft as of 2026-10, revision 11); legacy `X-RateLimit-*` | `Retry-After` (RFC 9110) + `RateLimit`/`RateLimit-Policy` with documented compatibility behavior | The draft is not final; emitting only draft headers can surprise clients, so chapter 16 documents both and why. |
| 401 vs 403 | Widely confused | 401 = not authenticated (or credentials invalid); 403 = authenticated but not allowed | Chapter 3 covers the subtle "401 without `WWW-Authenticate`" rule. |

If a source disagrees, the chapter shows the disagreement, names the source, and states the decision for this platform.

---

## 6. Roadmap — numbered table of contents

Each item is a topic checkbox. Files are one topic per file; large topics are split (`05a`, `05b`, `06a`, `06b`, `08a`, `08b`, `13a`–`13c`, `25a`–`25e`).

### Part I — Foundations (in-memory, chapters 01–10)

- [x] **01. What REST is and is not** — `docs/01-what-rest-is.md`
  Resources, representations, client/server, statelessness, uniform interface; why `/getProducts` is not REST. Builds: read-only in-memory catalog at `/api/...`. Done when: you can separate REST *constraints* from "JSON over HTTP".
- [x] **02. HTTP methods: safe, idempotent, and when to use each** — `docs/02-http-methods.md`
  GET, POST, PUT, PATCH, DELETE; safe vs idempotent; why GET must not mutate. Builds: read + create + delete product operations in memory. Done when: you can predict retry behavior for each method.
- [x] **03. Status codes that matter** — `docs/03-status-codes.md`
  200, 201, 202, 204, 400, 401, 403, 404, 409, 422, 429, 500, 503; 401 vs 403; 400 vs 422; 200-with-error trap. Builds: status behavior for the product endpoints. Done when: every response has a justified code.
- [x] **04. URLs: resources, nouns, and nesting** — `docs/04-urls-resource-naming.md`
  Plural nouns, resource identity, nesting depth, why verbs in paths are a smell, tenant prefix. Builds: final URL scheme `/api/tenants/{tenantId}/products/{productId}`. Done when: you can refactor a verb URL into resources and defend the depth.

### Part II — Representations and boundaries (in-memory, chapters 05–10)

- [x] **05a. Query parameters: filtering and sorting** — `docs/05a-query-filtering-sorting.md`
  Filter syntax, allowlists, multi-value filters, sort fields and direction, stable tie-breakers. Builds: filtered/sorted product list. Done when: unknown or hostile parameters cannot reach the query layer.
- [x] **05b. Query parameters: searching and field selection** — `docs/05b-query-search-field-selection.md`
  Search semantics, case-insensitivity, escaping, `fields=` sparse fieldsets, always-returned fields. Builds: product search + field selection. Done when: search cannot be used for cost amplification or injection.
- [x] **06a. Pagination: offset** — `docs/06a-pagination-offset.md`
  `limit`/`offset` (or page), bounds, stable ordering, response shape, total counts and their cost. Builds: paginated product list. Done when: you can explain duplicate/skip rows under concurrent inserts.
- [x] **06b. Pagination: cursor** — `docs/06b-pagination-cursor.md`
  Opaque cursors, keyset predicates, `nextCursor`, `hasMore`, totals trade-off, multi-column cursors. Builds: cursor-based product list. Done when: paging is stable while rows are inserted.
- [x] **07. JSON conventions** — `docs/07-json-conventions.md`
  camelCase, envelopes, ISO 8601 UTC, opaque IDs, integer minor units + ISO 4217 currency, null vs absent. Builds: canonical Product/Customer/Order representations. Done when: no float money and no local-time strings remain.
- [x] **08a. Error design: RFC 9457 Problem Details** — `docs/08a-error-problem-details.md`
  `application/problem+json`, `type`/`title`/`status`/`detail`/`instance`, stable `code`, extension members. Builds: central error handler for the API. Done when: every error is machine-readable and no stack trace leaks.
- [x] **08b. Error design: validation errors and codes** — `docs/08b-validation-errors-error-codes.md`
  Field errors, pointers, multiple violations, stable error catalog, 400 vs 422, safe messages. Builds: `errors[]` shape used by every endpoint. Done when: a client can map every failure to a field and a code.
- [x] **09. Validation with Zod** — `docs/09-validation-zod.md`
  Parse at the boundary, strict objects, coercion rules, refinements, trimming output, clear messages. Builds: validated create/update product bodies and query schemas. Done when: handler code never trusts `req.body`.
- [x] **10. Response shaping and DTOs** — `docs/10-response-shaping-dtos.md`
  Whitelisting fields, mapper functions, never returning ORM models, derived vs stored fields, tenant-safe serialization. Builds: explicit Product/Customer DTOs. Done when: adding a secret column cannot leak it.

### Part III — Data and correctness (PostgreSQL + Prisma, chapters 11–14)

- [x] **11. From in-memory to PostgreSQL + Prisma** — `docs/11-postgres-prisma-migration.md`
  Dockerized throwaway Postgres, Prisma 7 config safety gate, tenant composite keys/indexes, migrations, seed, repository boundaries. Builds: real schema and repositories for products/customers/orders. Done when: the API behaves the same and tenant filters are query-level.
- [x] **12. Idempotency keys** — `docs/12-idempotency-keys.md`
  `Idempotency-Key` for order creation/payments, request hashing, unique constraint, stored response, replay, 409 on reuse with a different body, expiry. Builds: idempotent order creation. Done when: a retried request creates exactly one order.
- [x] **13a. PUT vs PATCH and partial updates** — `docs/13a-put-vs-patch-partial-updates.md`
  Full replacement vs merge patch, absent vs null, unknown fields, response codes. Builds: replace + patch product endpoints. Done when: no partial update can silently wipe fields.
- [x] **13b. Bulk operations** — `docs/13b-bulk-operations.md`
  Bulk create/update/delete, per-item results, all-or-nothing vs partial success, limits, async bulk. Builds: bulk product price update. Done when: partial failures are reported per item without corrupting state.
- [x] **13c. Concurrency control: ETags, If-Match, versions** — `docs/13c-concurrency-etags-if-match.md`
  Lost updates, strong vs weak validators, `If-Match`, 412 vs 409, version fields, retry guidance. Builds: optimistic concurrency on products. Done when: two concurrent writers cannot silently overwrite each other.
- [x] **14. Versioning and deprecation** — `docs/14-versioning-deprecation.md`
  URL major versioning, additive changes, breaking-change catalog, `Deprecation` (RFC 9745) and `Sunset` (RFC 8594), migration windows. Builds: `/v1` mount plus deprecated `/api` alias with headers. Done when: old clients keep working while new ones migrate.

### Part IV — Production behavior (chapters 15–20)

- [x] **15. Caching and conditional requests** — `docs/15-caching-conditional-requests.md`
  `Cache-Control`, `ETag`, `If-None-Match`/304, `Vary`, private vs shared caches, tenant-aware cache keys, default Express ETags. Builds: cacheable product reads and 304 responses. Done when: no tenant can receive another tenant's cached body.
- [x] **16. Rate limiting and standard headers** — `docs/16-rate-limiting.md`
  429, `Retry-After`, `RateLimit`/`RateLimit-Policy` draft fields, per-tenant/per-key partitions, burst vs sustained, where to enforce. Builds: per-tenant limiter with headers. Done when: headers and 429 behavior are testable.
- [x] **17. Authentication, authorization, and tenant scoping** — `docs/17-auth-authorization-tenant-scoping.md`
  Bearer tokens, 401 with `WWW-Authenticate`, 403, scopes/roles, deriving tenant from the principal, defense in depth; brief, with pointers to the auth documentation. Builds: auth middleware + tenant match check on every endpoint. Done when: a token for tenant A cannot read tenant B even with a crafted URL.
- [x] **18. Long-running operations** — `docs/18-long-running-operations.md`
  `202 Accepted`, operation resources, `Location`, polling vs webhooks, terminal states, expiry. Builds: async product export with status endpoint. Done when: clients can distinguish accepted, running, succeeded, failed.
- [x] **19. File uploads** — `docs/19-file-uploads.md`
  Multipart limits, `415`/`413`, content sniffing, storage abstraction, signed URLs, virus-scan boundary, tenant prefixes. Builds: tenant-scoped product image upload (local disk stub). Done when: an upload cannot escape its tenant or overwrite another file.
- [x] **20. Webhooks** — `docs/20-webhooks.md`
  Outbound events, HMAC signing, timestamp + replay window, retries with backoff, idempotent receivers, delivery logs, local receiver. Builds: `order.created` delivery to a local receiver with signature verification. Done when: replaying a delivery cannot double-process an event.

### Part V — Contract, alternatives, and patterns (chapters 21–26)

- [x] **21. OpenAPI 3.2 from Zod schemas** — `docs/21-openapi-from-zod.md`
  One schema source, `z.toJSONSchema()`, document assembly, examples, error schemas, serving `/openapi.json`, Swagger UI locally, contract drift. Builds: generated OpenAPI document + local docs UI. Done when: the document matches live responses.
- [x] **22. Consistency, naming, and API review** — `docs/22-consistency-and-review.md`
  Naming rules, shared parameter conventions, response/error consistency, review workflow, review checklist. Builds: a written style guide and a review pass over the course API. Done when: you can review a PR against explicit rules.
- [x] **23. Alternatives: GraphQL and tRPC** — `docs/23-graphql-trpc-alternatives.md`
  What each optimizes, N+1 and caching trade-offs, public vs internal APIs, hybrid designs. Builds: comparison notes, not a rewrite. Done when: you can justify REST for a public multi-tenant commerce API.
- [x] **24. Common mistakes** — `docs/24-common-mistakes.md`
  `200` with an error body, verbs in URLs, inconsistent names, leaked internal fields, N+1 behind list endpoints, plus the course's own mistakes fixed live. Builds: a mistake catalog with reproduction requests. Done when: you can spot each one in a diff.
- [x] **25a. Pattern: multi-tenant products CRUD** — `docs/25a-pattern-products-crud.md`
  Full CRUD, tenant isolation, soft delete vs hard delete, uniqueness per tenant, validation, DTOs. Builds: the reference CRUD slice. Pitfalls: cross-tenant IDs, delete semantics.
- [x] **25b. Pattern: create an order with an idempotency key** — `docs/25b-pattern-order-idempotency.md`
  Price snapshotting, stock checks, transaction boundaries, idempotent replay, conflict on changed payload. Builds: order creation. Pitfalls: double charges, stale prices, partial writes.
- [x] **25c. Pattern: customers list with search, filters, cursor pagination** — `docs/25c-pattern-customers-search-cursor.md`
  Combining search + filters + cursor, tenant-local indexes, total counts, stable ordering. Builds: customer list. Pitfalls: cursor leaks, unindexed search, filter/cursor mismatch.
- [x] **25d. Pattern: fraud ban/unban** — `docs/25d-pattern-fraud-ban-unban.md`
  State transitions, idempotent actions, audit events, reason text, 409 on invalid transition, authorization. Builds: ban/unban endpoints. Pitfalls: duplicate bans, missing audit trail, over-broad effects.
- [x] **25e. Pattern: applying a coupon** — `docs/25e-pattern-apply-coupon.md`
  Validation window, stacking rules, race conditions, redemption limits, integer arithmetic, rounding. Builds: apply-coupon endpoint. Pitfalls: overspending redemptions, float math, leaked coupon enumeration.
- [x] **26. Master checklist** — `docs/26-master-checklist.md`
  One checkbox per topic in this roadmap, grouped for design review: resources, methods, status, URLs, query, pagination, JSON, errors, validation, DTOs, idempotency, updates, concurrency, versioning, caching, rate limits, auth/tenancy, async, uploads, webhooks, OpenAPI, consistency, alternatives, mistakes, patterns.

**File count:** 35 chapter files (01–26 with splits) plus this roadmap.

---

## 7. What each part adds to the running API

| Part | Store | What exists at the end |
|---|---|---|
| I | memory | Read/create/delete products with correct methods, status codes, URLs |
| II | memory | Filtering, sorting, search, field selection, both pagination styles, canonical JSON, Problem Details, Zod validation, DTOs |
| III | Postgres | Prisma schema, tenant-safe repositories, idempotent orders, PUT/PATCH/bulk, concurrency control, `/v1` + deprecation |
| IV | Postgres | Caching/304, rate limiting, auth + tenant enforcement, async export, uploads, signed webhooks |
| V | Postgres | OpenAPI 3.2, consistency guide, alternatives, mistake catalog, five production patterns, master checklist |

---

## 8. Delivery and review

The course was delivered in one pass at your request. The original plan (and the mapping to the chapter order) was:

| Batch | Chapters | Focus |
|---|---|---|
| 1 | 01, 02, 03, 04 | REST fundamentals, methods, status, URLs |
| 2 | 05a, 05b, 06a, 06b | Query parameters and pagination |
| 3 | 07, 08a, 08b, 09 | JSON, errors, validation |
| 4 | 10, 11, 12 | DTOs, PostgreSQL/Prisma, idempotency |
| 5 | 13a, 13b, 13c, 14 | Updates, bulk, concurrency, versioning |
| 6 | 15, 16, 17 | Caching, rate limiting, auth/tenancy |
| 7 | 18, 19, 20 | Async operations, uploads, webhooks |
| 8 | 21, 22, 23, 24 | OpenAPI, consistency, alternatives, mistakes |
| 9 | 25a, 25b, 25c, 25d, 25e | Real-world patterns |
| 10 | 26 | Master checklist + full end-to-end verification |

Since the pauses were waived, all ten batches are complete. Each chapter still ships with the same four artifacts: the chapter file, the code it describes, the matching `.http` request file, and the captured `curl` transcript.

---

## 9. Decisions (as built)

| Decision | Default | Alternative |
|---|---|---|
| API port | `4010` | any free port |
| Postgres | dedicated container `api-learn-db`, port `5434`, DB `api_learn` | reuse another project's DB (not recommended; port 5433 is occupied) |
| Tenant in URL | `/tenants/{tenantId}/...` for teaching and platform-admin clarity, verified against the token from chapter 17 | token-derived tenant only; would hide cross-tenant risks from examples |
| IDs | prefixed opaque strings (`prd_...`, `cus_...`) | UUIDs |
| Validation status | 400 malformed JSON; 422 schema/semantic failures | 400 for everything |
| Versioning | URL major `/v1` added in chapter 14 | dated header, Azure-style query parameter |
| Package manager | npm (already used) | pnpm/bun |
| ID generation | `crypto.randomUUID()` with type prefix | ULID library |

Every decision below is what the finished API actually does; the alternative column is the trade-off you would revisit in another context.

---

## 10. Scope and safety

- All work stays inside `api-learn/`. Other projects, databases, and containers are not modified.
- The database is local, throwaway, and password-protected only by a known dev password. It must never hold real data.
- No real third-party API is called and no real credentials are used. Webhook examples use a local receiver.
- Deprecated APIs are called out explicitly (for example, legacy `X-RateLimit-*` conventions and Express 4 patterns); the modern alternative is shown.
- Every request in a chapter is executed locally first. If something cannot be reproduced, the chapter says so instead of inventing output.

---

## 11. Final verified state

1. **Code:** `npm run typecheck` passes; the API runs on port 4010 against the local PostgreSQL 17 container. Run it with the defaults in `.env` (`AUTH_ENABLED=on`, `CACHE_ENABLED=on`); chapters 15–17 flip those flags for their own demos, and an instance left running from an earlier chapter keeps the old flag values until restarted.
2. **Requests:** every chapter's `curl` calls were executed and pasted into `transcripts/NN-*.txt`; chapter 23 is the only chapter with no requests (it is a comparison, and says so).
3. **Contract:** `/openapi.json` serves OpenAPI 3.2.0 with 19 paths, generated from the same Zod schemas the server validates with (chapter 21); `/docs` serves Swagger UI from local assets.
4. **Safety:** all work is inside `api-learn/`; the database is throwaway; no third-party service is called with real credentials; webhooks are demonstrated with the local receiver on port 4020.
5. **Review:** open `docs/26-master-checklist.md` and run it against any change that touches the HTTP surface.
