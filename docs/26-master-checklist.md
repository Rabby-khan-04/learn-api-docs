# 26. Master checklist

> **No new requests in this chapter.** Every item below points back to a chapter where the behaviour was executed and captured. The checklist is the course compressed into something you can use during a review.

---

## 1. Simple explanation (like I'm 7)

A pilot does not trust memory before takeoff. There is a list on a card: flaps, fuel, doors. The pilot has done it a thousand times, and still reads the list out loud.

This is that card for APIs. You built every item on it. Now you read it before shipping, so that being tired on a Friday afternoon does not decide whether tenant data leaks.

---

## 2. Real name

A **design review checklist** turns conventions into a repeatable gate. It is applied to every change that alters the HTTP surface: a new route, a new field, a new status code, a new header, a new error code.

It has three properties:

1. **Item-level.** Each line is a yes/no question with a pointer to the evidence (code, request, transcript), not a vague principle.
2. **Ordered by blast radius.** Tenancy and authorization first (a breach), then money and state (a loss), then contract and ergonomics (a support ticket).
3. **Small enough to actually run.** This one is 60 items and takes about 15 minutes per change.

The five patterns from part V are the stress tests: if the checklist passes on products CRUD, order creation, customer search, ban/unban, and coupons, it will pass on the next resource too.

---

## 3. Example

### The checklist itself

Each group is a gate. Stop at the first "no".

#### A. Tenancy and authorization (a failure here is a breach)

- [ ] **A1. Every tenant-owned row has `tenantId`, and every query filters by it.** Evidence: `where: { tenantId, ... }` in `src/store/prisma.ts`. Chapter 11.
- [ ] **A2. The tenant comes from the verified principal, not the body or a query string.** `tenantIdOf(req)` reads the value set by `tenantScope`. Chapters 17, 22.
- [ ] **A3. The path tenant is compared with the token tenant before any lookup.** Mismatch → `403` with no existence signal. Chapter 17.
- [ ] **A4. A foreign ID *inside* an accessible tenant is `404`, not `403`.** Chapters 17, 25a.
- [ ] **A5. Missing credentials → `401` with `WWW-Authenticate`; wrong role → `403`.** Chapter 17.
- [ ] **A6. Actions have an explicit role list.** `requireRole('ADMIN', 'SUPPORT', 'PLATFORM_ADMIN')` on writes. Chapters 17, 25d.
- [ ] **A7. The cross-tenant test exists.** "Tenant A's token cannot read or write tenant B" is in the suite for every resource. Chapters 17, 25a.
- [ ] **A8. No endpoint outside the tenant tree except `/health` (and the docs surface, by decision).** Chapter 21.

#### B. Methods, status codes, and state (a failure here loses money)

- [ ] **B1. `GET` is safe and side-effect free.** Chapter 2.
- [ ] **B2. `POST` creates or acts; `PUT` replaces; `PATCH` merges; `DELETE` deletes.** Chapters 2, 13a.
- [ ] **B3. `201` has a `Location`, `202` has `Location` + `Retry-After`, `204` has no body, `304` has no body.** Chapters 3, 18.
- [ ] **B4. Errors are `4xx`/`5xx`, never `200` with an error body.** Chapters 3, 24.
- [ ] **B5. `401` vs `403` and `400` vs `422` are chosen deliberately.** Chapters 3, 8b.
- [ ] **B6. `409` is used for state conflicts with a specific `code`; `412` for failed preconditions.** Chapters 12, 13c, 25b.
- [ ] **B7. Mutating an existing resource keeps its identity and bumps `version`.** Chapter 13c.
- [ ] **B8. Delete semantics are explicit:** soft delete for referenced rows, hard delete only with a plan. Chapter 25a.
- [ ] **B9. State machines reject invalid transitions (`409 invalid_order_state`).** Chapters 25b, 25d, 25e.

#### C. URLs and naming

- [ ] **C1. Plural nouns, no verbs except action sub-resources (`/ban`, `/coupon`, `/payments`).** Chapters 1, 4, 25d.
- [ ] **C2. Paths start `/v1/tenants/{tenantId}/...`; the deprecated alias is not documented.** Chapters 4, 14, 21.
- [ ] **C3. Nesting stops at the identity that owns the resource; deeper relationships use query parameters or sub-collections.** Chapter 4.
- [ ] **C4. JSON is `camelCase`; query parameters are `camelCase`; headers are canonical (`Idempotency-Key`, `If-Match`).** Chapters 7, 22.
- [ ] **C5. IDs are opaque, prefixed, and never sequential.** Chapters 7, 24.
- [ ] **C6. Money is integer minor units plus ISO 4217; time is ISO 8601 UTC.** Chapter 7.

#### D. Query, pagination, and representation

- [ ] **D1. Filters are allowlisted; unknown parameters are rejected (`.strict()`), not ignored.** Chapters 5a, 22.
- [ ] **D2. Sort fields and directions are enums, with a stable `id` tie-breaker.** Chapters 5a, 25c.
- [ ] **D3. Search is bounded, case-insensitive, and cannot be a cost amplifier.** Chapter 5b.
- [ ] **D4. `fields=` never drops `id` and never returns unrequested fields.** Chapter 5b.
- [ ] **D5. Collections use `{ data, pagination }`; singles are bare objects.** Chapters 6a, 22.
- [ ] **D6. Cursor and offset are mutually exclusive; `total` is opt-in and offset-only.** Chapters 6a, 6b, 25c.
- [ ] **D7. Cursors are opaque, validated, and carry a tie-breaker; a cursor with an incompatible sort is rejected.** Chapter 25c.
- [ ] **D8. Responses go through a DTO whitelist; internal columns cannot leak.** Chapters 10, 24.
- [ ] **D9. Derived fields (like `status` from `bannedAt`) have one source.** Chapter 25d.
- [ ] **D10. Snapshots are stored at write time for historical records (order items).** Chapters 11, 25b.

#### E. Errors and validation

- [ ] **E1. Errors are `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `code`.** Chapters 8a, 22.
- [ ] **E2. `type` and `code` are stable; clients branch on `code`, not on prose.** Chapter 8a.
- [ ] **E3. Field errors use `errors[]` with JSON pointers.** Chapter 8b.
- [ ] **E4. The Zod schema is the only input contract; `.strict()` everywhere.** Chapter 9.
- [ ] **E5. No stack traces, SQL, or internal IDs in `detail`.** Chapters 8a, 24.
- [ ] **E6. Coupon-forgiveness rule: errors that enable enumeration are collapsed to one generic answer.** Chapter 25e.

#### F. Writes, concurrency, and idempotency

- [ ] **F1. `POST` that creates money or work requires `Idempotency-Key`; missing → `400`.** Chapters 12, 25b.
- [ ] **F2. The key is unique per tenant, stores the request hash, method, and path, and replays the response.** Chapter 12.
- [ ] **F3. Same key + different body → `409`; still running → `409`.** Chapter 12.
- [ ] **F4. Side effects (webhooks, emails) fire only on first execution, never on replay.** Chapters 12, 25b.
- [ ] **F5. `PUT`/`PATCH` are guarded by `If-Match` or a version precondition; stale writes get `412`.** Chapter 13c.
- [ ] **F6. Partial updates distinguish absent from `null`.** Chapter 13a.
- [ ] **F7. Bulk operations are bounded, ordered before `/:id`, and either atomic or per-item reported.** Chapter 13b.
- [ ] **F8. Stock/counter changes use conditional updates, never read-then-write.** Chapters 25b, 25e.
- [ ] **F9. Multi-row effects are in one transaction; a failure leaves nothing half-written.** Chapters 25b, 25e.
- [ ] **F10. State transitions are idempotent by intent (`200 changed:false`) or explicitly reject repeats.** Chapters 25d, 25e.

#### G. Caching, limits, and long-running work

- [ ] **G1. Private reads send `Cache-Control: private, max-age=...`, `ETag`, and `Vary: Authorization`.** Chapter 15.
- [ ] **G2. Collections and private state send `no-store`.** Chapters 15, 22.
- [ ] **G3. `If-None-Match` returns `304` with no body.** Chapter 15.
- [ ] **G4. Rate limiting is keyed by tenant (or token), mounted after authentication, and returns `429` + `Retry-After` + `RateLimit` headers.** Chapter 16.
- [ ] **G5. Long work returns `202` with an operation resource, and polling distinguishes queued/running/succeeded/failed.** Chapter 18.
- [ ] **G6. Uploads bound size and type, sniff content, and store under a server-chosen tenant-scoped key.** Chapter 19.
- [ ] **G7. Webhooks are signed with a timestamped HMAC over the raw body, retried, and deduped by event ID.** Chapter 20.
- [ ] **G8. Webhook secrets are returned once and never listed.** Chapter 20.

#### H. Contract and change management

- [ ] **H1. `/openapi.json` is generated from the same Zod schemas used at runtime.** Chapter 21.
- [ ] **H2. Input schemas use `io: 'input'`; defaulted fields are not `required`.** Chapter 21.
- [ ] **H3. The document is validated in CI and diffed against the live route surface.** Chapters 21, 22.
- [ ] **H4. Additive changes only within `/v1`; breaking changes get a new major.** Chapter 14.
- [ ] **H5. Deprecations send `Deprecation` and `Sunset`, and are announced before they are enforced.** Chapter 14.
- [ ] **H6. Every error code added is in the contract and has a documented meaning.** Chapters 8b, 21.
- [ ] **H7. A matching `.http` request and a captured transcript exist for the golden path and at least one failure.** The verification protocol in `docs/00-roadmap.md` §4.2.

#### I. Operability and review hygiene

- [ ] **I1. Every response carries a request ID; logs correlate it.** Chapters 8a, 22.
- [ ] **I2. `X-Powered-By` is disabled; default ETags are disabled or deliberately used.** Chapters 10, 15, 24.
- [ ] **I3. The PR description contains a real request/response pair, not invented output.** Chapter 22.
- [ ] **I4. The new route has a cross-tenant test and a failure-path test.** Chapters 17, 22.
- [ ] **I5. N+1 is checked on list endpoints (`take: limit + 1`, no per-row queries).** Chapters 24, 25a.
- [ ] **I6. Indexes exist for the filters, sorts, and keyset predicates used.** Chapters 6b, 11, 25c.
- [ ] **I7. Nothing in the diff trusts client input for auth, money, tenant, or state.** Chapters 9, 17, 25e.

### How to run it in 15 minutes

1. **Read the route, not the diff** (2 min). Identify the resource, method, and every status code it can emit.
2. **Gate A and B first** (5 min). Tenancy, auth, methods, statuses. Most serious bugs die here.
3. **Walk D–F** (5 min). Shapes, errors, idempotency, concurrency.
4. **H and I** (3 min). Contract, docs, tests, request evidence.
5. **Write down any "no" with a file and line.** A checklist with an unlocated "no" is a feeling; with a location it is a fix.

### A review of a real change against this list

Take the coupon endpoint from chapter 25e and spot-check:

| Item | Evidence |
| --- | --- |
| A1 | `tx.coupon.findFirst({ where: { tenantId, code } })` |
| A3 | `tenantScope` runs before the route; the path tenant is verified (17) |
| B3 | `200` with the updated order; no `Location` (the resource did not move) |
| B6 | `409 coupon_already_applied`, `409 coupon_exhausted`, `409 invalid_order_state` |
| B9 | non-`PENDING` orders rejected |
| D8 | `orderDto` returns only public fields |
| E1 | all failures are `problem+json` with `code` |
| E6 | expired / foreign / inactive / wrong currency collapse to `422 invalid_coupon` |
| F8 | conditional `updateMany` on `redemptionCount` |
| F9 | coupon increment, order update, redemption insert in one `$transaction` |
| H1 | `ApplyCoupon` in `components.schemas`, generated from `applyCouponSchema` |
| I7 | discount computed server-side; the client sends only the code |

Two items fail or are weak, and that is the point of a checklist:

- **A7** (cross-tenant test) is not shipped as an automated test in this teaching repo; the transcripts prove it manually. In production it must be a test.
- **F10** (idempotency by intent) is deliberately not satisfied: re-applying a coupon returns `409`. That is a product decision, documented in 25e — the checklist should record "intentional exception", not force uniformity.

A checklist that never produces "intentional exception" is not being read.

---

## 4. Bad vs good

**Bad:** a review comment thread.

```
"Should this be 400 or 422?"
"Can someone from another tenant call this?"
"Did we test the cursor?"
```

Three questions, zero shared answers, and the same questions next week.

**Good:** the same review against the list.

```
B5: 422 — body parsed, reference invalid (transcript 25b)
A3: tenantScope on router mount; 403 captured in 25d
D7: cursor+sort rejected with 422; request in 25c
```

The difference is not diligence; it is that the answers exist before the review starts.

**Bad:** a 200-item checklist nobody finishes. It becomes a ritual: tick all, ship. **Good:** the 60 items above, ordered by blast radius, with a time budget and an "intentional exception" column.

**Bad:** checking the happy path and calling it done. **Good:** I4 — one cross-tenant test and one failure path per route, both executed.

---

## 5. In a real multi-tenant e-commerce platform

The checklist pays off in three recurring situations:

- **A new resource** (suppliers, shipments): copy the products slice, then walk A–F. The items that fail are almost always A1, A3, D5, and E1, because those are the ones that are easy to omit when copying a handler but not a route registration.
- **A new action** (refund, cancel, resend webhook): B9, F1, F10, and F4 decide whether the action is safe to retry and whether it double-fires events.
- **A breaking change** (order item shape, error member rename): H4 and H5 decide whether it ships as `/v1` additive or as a new major with a sunset window.

Tenant isolation is the item that never gets to be "best effort". Every other line can have a documented exception; A1–A5 cannot, because the failure is not a bad developer experience — it is one tenant reading another tenant's customers.

---

## 6. When to use it and when NOT

**Use the full list when:**

- A change adds or alters a route, status code, header, or error code.
- A new engineer is about to copy an existing slice (the checklist is the difference between copying the pattern and copying the bugs).
- You are reviewing an inherited API before taking ownership.

**Use a subset when:**

- Only a DTO field was added → C4, D8, H1, H4.
- Only a new error code → E1, E2, H6.
- Only a performance change → I5, I6, G1.

**Do not:**

- **Treat it as a substitute for tests.** The list tells you what to test; it does not test anything.
- **Use it to block unrelated work.** A checklist is a gate for the HTTP surface, not for every commit.
- **Add items you never check.** Every dead item makes the live ones less credible.
- **Ignore the "intentional exception" column.** Uniformity for its own sake produces worse APIs (25e's `409` is the example).

---

## 7. Common mistakes

1. **Checklist as ritual.** Ticking without evidence. Fix: every "yes" needs a file, a request, or a test name.
2. **Reviewing the diff, not the surface.** The diff shows the handler; the surface includes the route registration, the middleware order, and the OpenAPI document.
3. **Tenant checks last.** If A fails, nothing else matters. Order the gates by blast radius.
4. **New route, old habits.** Copying a handler without copying its route-level guards (`requireRole`, `tenantScope`).
5. **No failure-path evidence.** The happy path was run; the `409` body was invented. Chapter 22's I3 exists for this.
6. **Documenting after shipping.** The OpenAPI component is missing, so generated clients cannot call the new route; add it in the same PR.
7. **No index for the new filter.** The endpoint is correct and the database is unhappy; I6.
8. **Ignoring replay semantics on new side effects.** A new webhook or email fires twice because F4 was not checked.
9. **Treating "it works" as "it is consistent".** A `200` with an error body works for the author and breaks every generic client.
10. **Never updating the list.** When a new class of bug escapes, add one item — one, with a pointer to the incident — or the list rots.

---

## 8. Try it yourself

Apply the checklist to a route that does not exist yet: `POST /v1/tenants/{tenantId}/products/{productId}/archive`.

The intent: hide a product from the storefront without deleting it, keeping it visible to admins.

1. Write the endpoint contract: method, path, request body, success response, error codes.
2. Walk every group A–I and write the evidence you would require. Where the answer is "not yet", write the work item.
3. Decide the two genuinely ambiguous points: is `archive` idempotent by intent (like ban) or a conflict on repeat (like coupon)? Does it need `Idempotency-Key`, or is the state check enough?
4. Add one item to the checklist that this exercise revealed and the list is missing.

**Hint:** `archive` is closer to `ban` than to `coupon` — it is "ensure this product is not on the storefront", so `200` with `changed:false` on repeat is the natural contract, and an `Idempotency-Key` is unnecessary because the state check makes the write safe. It still needs `If-Match` if admins can archive and unarchive concurrently (F5), a cross-tenant test (A7), and a decision about whether `archivedAt` replaces `active:false` or coexists with it (D9 — one source of truth). The item most likely missing from the list is **"does the new state appear in every read path, including search and export?"** — the export in chapter 18 reads products too.

---

## 9. Next

You are at the end of the course. The roadmap is the map back: each chapter's checkbox is ticked, and `docs/00-roadmap.md` records the final verified state of the API, the transcripts, and the environment.

Next: [Back to the roadmap](00-roadmap.md)
