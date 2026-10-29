# 25d. Pattern: fraud ban/unban

> **Run order:** Prisma server, port 4010, auth on.
>
> Every request below is copied from `transcripts/25d-pattern-fraud-ban-unban.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

A shop has a list of customers. Sometimes a customer does something bad — keeps taking money back after getting the goods — and the shop says "no more shopping for you". That is a **ban**.

Two important rules:

1. Saying "you are banned" twice must not count twice. The second time changes nothing; it just says "yes, still banned".
2. Every ban and unban must be written in a **logbook** with who did it and why, because later someone will ask "why was this person banned, and who decided?"

And the shop next door cannot ban *your* customers, even if it knows their names.

---

## 2. Real name

Banning is a **state transition on a resource**, not a generic update:

```
          ban                 unban
 ACTIVE ───────► BANNED ──────────► ACTIVE
   │                │
   └── ban (no-op)  └── unban (no-op)
```

The endpoint is an **action sub-resource**: `POST /customers/{customerId}/ban`. Why `POST` and not `PATCH /customers/{customerId}` with `{"status":"BANNED"}`?

- A `PATCH` says "set these fields". It invites clients to set `status` directly, bypassing the transition rules, the reason requirement, and the audit event.
- An action endpoint names the intent, has its own body (a required `reason`), its own authorization, and its own side effects (the audit row, a future webhook).

The rules this pattern implements:

| Rule | Implementation |
| --- | --- |
| Ban requires a reason (3–500 chars) | `banCustomerSchema` / `unbanCustomerSchema` |
| Repeating a ban is safe | compare `bannedAt`, return `changed: false` |
| Status is derived, not stored | DTO computes `status` from `bannedAt` |
| Reason is preserved after unban | `banReason` is not cleared on unban |
| Every real transition is audited | `fraud_events` row with actor + reason |
| Only some roles may ban | `requireRole('ADMIN', 'SUPPORT', 'PLATFORM_ADMIN')` |
| Tenant isolation | `tenantScope` before the route; store query filters `tenantId` |

`status` is a **derived field**: the database stores `bannedAt` (a timestamp), and the DTO maps it to `ACTIVE` or `BANNED`. Storing both a boolean and a timestamp would let them disagree; a single source cannot.

---

## 3. Example

### The body

```ts
// src/schemas/customer.ts (excerpt)
export const banCustomerSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const unbanCustomerSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
```

A required, bounded reason is the difference between an auditable action and an anonymous click. `.strict()` rejects `{ "reason": "...", "status": "BANNED" }` — the status is not the client's to set.

### The route: one loop for two actions

```ts
// src/routes/customers.ts (excerpt)
for (const [path, action, schema] of [
  ['ban', 'BAN', banCustomerSchema],
  ['unban', 'UNBAN', unbanCustomerSchema],
] as const) {
  router.post(`/:customerId/${path}`, requireRole('ADMIN', 'SUPPORT', 'PLATFORM_ADMIN'), async (req, res) => {
    const tenantId = tenantIdOf(req);
    const body = parseInput(schema, req.body);
    const result = await store.setCustomerBan(tenantId, pathParam(req, 'customerId'), action, body.reason);
    if (!result) throw notFound('Customer not found.');

    // Audit only real transitions; a repeated request is a safe no-op.
    if (result.changed && hooks.onFraudEvent) {
      await hooks.onFraudEvent({
        tenantId,
        customerId: result.customer.id,
        action,
        reason: body.reason,
        actor: req.auth?.subject ?? 'unknown',
      });
    }

    noStore(res);
    res.status(200).json({ customer: customerDto(result.customer), changed: result.changed });
  });
}
```

Four design choices packed into one handler:

- **`200` for both outcomes.** The action succeeded whether or not it changed anything; `changed` tells the client which. Returning `409` for an already-banned customer would make a retry look like an error.
- **Audit only when `changed`.** Two clicks on "Ban" produce one logbook entry, not two.
- **The actor comes from the token** (`req.auth.subject`), never from the body.
- **`noStore`** because the response reflects a private customer state.

### The transition itself

```ts
// src/store/prisma.ts (excerpt)
async setCustomerBan(tenantId, customerId, action, reason) {
  return this.prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({ where: { id: customerId, tenantId } });
    if (!customer) return null;
    const isBanned = customer.bannedAt !== null;
    if ((action === 'BAN' && isBanned) || (action === 'UNBAN' && !isBanned)) {
      return { customer: toCustomer(customer), changed: false };
    }
    const updated = await tx.customer.update({
      where: { id: customerId },
      data: {
        bannedAt: action === 'BAN' ? new Date() : null,
        banReason: action === 'BAN' ? reason : customer.banReason,
        version: { increment: 1 },
      },
    });
    return { customer: toCustomer(updated), changed: true };
  });
}
```

Reading `bannedAt` and deciding inside a transaction keeps the route simple, and `tenantId` in the lookup means a customer from another tenant is indistinguishable from a missing one (`404`).

There is a real limitation here, covered in mistakes below: under PostgreSQL's default `READ COMMITTED`, two simultaneous bans can both read `bannedAt = null` and both update, producing two audit entries. The transaction prevents torn state, not duplicate transitions. Chapter 13c's conditional-update pattern is the fix.

### Ban, repeat, unban, repeat (actual)

First ban:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/customers/cus_acme_12/ban -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "reason": "Chargeback abuse" }'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 6e476119-7a8d-4f72-ba1d-c2bc2cb36323
Content-Type: application/json; charset=utf-8
Content-Length: 281
Date: Thu, 29 Oct 2026 12:30:05 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"customer":{"id":"cus_acme_12","email":"lara.croft.12@example.com","name":"Lara Croft","status":"BANNED","bannedAt":"2026-10-29T12:30:05.915Z","banReason":"Chargeback abuse","version":2,"createdAt":"2026-01-12T09:00:00.000Z","updatedAt":"2026-10-29T12:30:05.915Z"},"changed":true}
```

The response is a **state description**, not an empty acknowledgment: the client gets the customer it just changed and can render the new status immediately.

Repeat the identical ban:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/customers/cus_acme_12/ban -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "reason": "Chargeback abuse" }'
```

```http
HTTP/1.1 200 OK
X-Request-Id: a49080c0-ff55-4d7d-876c-c9809bf5d551
Content-Type: application/json; charset=utf-8
Content-Length: 282
Date: Thu, 29 Oct 2026 12:30:05 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"customer":{"id":"cus_acme_12","email":"lara.croft.12@example.com","name":"Lara Croft","status":"BANNED","bannedAt":"2026-10-29T12:30:05.915Z","banReason":"Chargeback abuse","version":2,"createdAt":"2026-01-12T09:00:00.000Z","updatedAt":"2026-10-29T12:30:05.915Z"},"changed":false}
```

`changed: false`, same `bannedAt`, same `version: 2`, same `updatedAt`. Nothing moved. The only difference in the body is one character (`true` vs `false`), which is why `Content-Length` is 281 vs 282.

Unban:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/customers/cus_acme_12/unban -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "reason": "Appeal accepted" }'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 58b6b85b-a5da-47a8-870c-e8c72533c0d5
Content-Type: application/json; charset=utf-8
Content-Length: 259
Date: Thu, 29 Oct 2026 12:30:05 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"customer":{"id":"cus_acme_12","email":"lara.croft.12@example.com","name":"Lara Croft","status":"ACTIVE","bannedAt":null,"banReason":"Chargeback abuse","version":3,"createdAt":"2026-01-12T09:00:00.000Z","updatedAt":"2026-10-29T12:30:05.942Z"},"changed":true}
```

Three fields moved: `bannedAt` → `null`, `version` → 3, `updatedAt`. `banReason` stays `"Chargeback abuse"` — the last ban reason is kept as history. That is a deliberate choice: the field documents *why the customer was last banned*, not *why they are currently banned*. The response makes the distinction visible because `status` is `ACTIVE` while `banReason` is not null.

The unban's own reason (`"Appeal accepted"`) is not forgotten either: it goes to the `fraud_events` audit row. The customer row is state; the audit table is history.

Repeat the unban:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/customers/cus_acme_12/unban -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "reason": "Appeal accepted" }'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 0e0228dd-9e32-4d05-9246-34f8d5f7f31f
Content-Type: application/json; charset=utf-8
Content-Length: 260
Date: Thu, 29 Oct 2026 12:30:05 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"customer":{"id":"cus_acme_12","email":"lara.croft.12@example.com","name":"Lara Croft","status":"ACTIVE","bannedAt":null,"banReason":"Chargeback abuse","version":3,"createdAt":"2026-01-12T09:00:00.000Z","updatedAt":"2026-10-29T12:30:05.942Z"},"changed":false}
```

Same shape, `changed: false`. A client that retries after a timeout gets a definitive answer in both directions.

Missing reason:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/customers/cus_acme_12/ban -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary \{\}
```

```http
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: e484b679-e810-46d7-9a05-8543c55daaec
Content-Type: application/problem+json; charset=utf-8
Content-Length: 352
Date: Thu, 29 Oct 2026 12:30:05 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/v1/tenants/ten_acme/customers/cus_acme_12/ban","code":"validation_failed","errors":[{"pointer":"/reason","code":"invalid_type","message":"Invalid input: expected string, received undefined"}]}
```

`422` with a pointer, not `400`: the JSON is well-formed, the content is not acceptable (chapter 8b).

Support role banning:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/customers/cus_acme_13/ban -H 'Authorization: Bearer tok_acme_support' -H 'Content-Type: application/json' --data-binary '{ "reason": "Suspicious refund pattern" }'
```

```http
HTTP/1.1 200 OK
X-Request-Id: b5ede64a-0f57-4d09-87f6-468542d9a102
Content-Type: application/json; charset=utf-8
Content-Length: 288
Date: Thu, 29 Oct 2026 12:30:05 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"customer":{"id":"cus_acme_13","email":"mona.lisa.13@example.com","name":"Mona Lisa","status":"BANNED","bannedAt":"2026-10-29T12:30:05.980Z","banReason":"Suspicious refund pattern","version":2,"createdAt":"2026-01-13T09:00:00.000Z","updatedAt":"2026-10-29T12:30:05.980Z"},"changed":true}
```

Support can ban — this is a support workflow, not an admin-only one. The role list is a product decision, expressed in one line (`requireRole`).

Cross-tenant attempt with an Acme admin token:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_globex/customers/cus_globex_01/ban -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "reason": "Cross-tenant attempt" }'
```

```http
HTTP/1.1 403 Forbidden
X-Request-Id: 13c822fe-5e56-4971-b658-0abcb4fe8c46
Content-Type: application/problem+json; charset=utf-8
Content-Length: 231
Date: Thu, 29 Oct 2026 12:30:05 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/forbidden","title":"Forbidden","status":403,"detail":"This token is not allowed to access that tenant.","instance":"/v1/tenants/ten_globex/customers/cus_globex_01/ban","code":"forbidden"}
```

`403` here is correct and different from 25a's `404`: the *tenant* in the path is not accessible to this token at all. The request is rejected before the customer is looked up, so the response reveals nothing about `cus_globex_01`.

Platform admin doing the same across tenants:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_globex/customers/cus_globex_01/ban -H 'Authorization: Bearer tok_platform' -H 'Content-Type: application/json' --data-binary '{ "reason": "Platform-level fraud review" }'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 7ec18188-5cef-4270-a064-1a601c581a54
Content-Type: application/json; charset=utf-8
Content-Length: 299
Date: Thu, 29 Oct 2026 12:30:06 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"customer":{"id":"cus_globex_01","email":"alice.johnson.1@example.com","name":"Alice Johnson","status":"BANNED","bannedAt":"2026-10-29T12:30:06.003Z","banReason":"Platform-level fraud review","version":2,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:30:06.003Z"},"changed":true}
```

The platform role is a deliberate, narrow exception. It is also the highest-risk token in the system: it can act on any tenant, so its use must be audited and its issuance restricted (chapter 17).

The audit row written by the hook:

```ts
// src/app.ts (excerpt)
onFraudEvent: async (event) => {
  await prisma.fraudEvent.create({
    data: {
      id: newId('fre'),
      tenantId: event.tenantId,
      customerId: event.customerId,
      action: event.action,
      reason: event.reason,
      actor: event.actor,
    },
  });
},
```

One row per real transition: `BAN` with `"Chargeback abuse"` by `user_acme_admin`, `UNBAN` with `"Appeal accepted"` by `user_acme_admin`, and nothing for the two repeated calls.

---

## 4. Bad vs good

**Bad:** a generic status update.

```ts
// Bad: no reason, no transition rules, no audit
PATCH /customers/cus_123
{ "status": "BANNED" }
```

The client can set `status` to anything the schema allows, skip the reason, and the audit log has no idea a human decided this. It also invites `status: "ACTIVE"` to silently undo a fraud decision from a settings screen.

**Good:** a named action with a required rationale.

```ts
// Good
POST /customers/cus_123/ban
{ "reason": "Chargeback abuse" }
```

**Bad:** `409` when the customer is already banned.

```
# Bad: the client's retry looks like a failure
409 {"code":"already_banned"}
```

The operation is **idempotent by effect**: "make sure this customer is banned". A retry after a timeout is not an error; it is the same intent. `409` forces the client to treat "already in the desired state" as a failure path.

**Good:** `200` with `changed: false`, and an audit skip.

**Bad:** storing `status` and `bannedAt` separately.

```ts
// Bad: they will disagree
{ status: 'BANNED', bannedAt: null }
```

A migration, a partial update, or a bug sets one and not the other; now `status=BANNED` filters and `bannedAt` displays disagree. Derive `status` from `bannedAt`.

**Bad:** clearing `banReason` on unban. The customer row then cannot answer "why was this person ever banned?", and the audit table becomes the only source — but support screens read the customer. **Good:** keep the last reason and document that it is historical.

**Bad:** an unbounded `reason` or a free-text `actor` from the request body. Both are attacker-controlled input in your audit log. **Good:** `reason` is bounded and trimmed; `actor` comes from the authenticated principal.

---

## 5. In a real multi-tenant e-commerce platform

A fraud analyst sees three chargebacks from the same customer in a week. They open the customer, click **Ban**, type "Three chargebacks in 7 days", and confirm. The customer's next order is rejected with `409 customer_banned` (25b). The audit row records the analyst's token subject, the reason, and the time.

Two weeks later the customer appeals. Support reviews the history (the `fraud_events` rows), accepts the appeal, and unbans. The customer row keeps `banReason: "Three chargebacks in 7 days"` but `status` is `ACTIVE`, so the next order goes through. The support agent's token subject is in the unban audit row.

An analyst double-clicks Ban during a slow network. The second click returns `200 changed: false`; no second audit row; no duplicate "account banned" email.

Globex's analyst tries the same URL with Acme's customer ID: `403` before any lookup. Acme's analyst tries a Globex URL: also `403`. The tenant boundary is the same middleware as every other resource (chapter 17), not a special case in this handler.

---

## 6. When to use it and when NOT

**Use action endpoints (`POST /resource/{id}/{action}`) when:**

- The change is a **state machine transition** with rules, not a field assignment.
- The action has a required rationale, an audit entry, or a side effect (webhook, email).
- The action is **idempotent by intent** ("ensure banned"), and repeating it must be safe.
- Different roles may perform different actions on the same resource.

**Do not:**

- **Add a ban endpoint for every boolean.** If there are no rules, no reason, and no audit, `PATCH` on the field is fine.
- **Return `204` and nothing else** when the client needs the resulting state; a `200` with the resource saves a follow-up `GET`.
- **Put the actor in the body.** It comes from the token.
- **Let the action clear unrelated state.** Unban must not wipe the ban history.
- **Forget concurrency.** Two concurrent bans should produce one transition; see the limitation above and the exercise.

---

## 7. Common mistakes

1. **`409` for already-banned.** Makes retries look like failures; use `200 changed: false`.
2. **Auditing every request instead of every transition.** The fraud log fills with duplicates and the timeline becomes unreadable.
3. **No reason, or a reason capped at 10 characters.** The audit row cannot answer "why" six months later.
4. **`actor` from the request body.** Anyone can write any name into your compliance log.
5. **Clearing `banReason` on unban.** Loses history that support needs.
6. **Storing `status` alongside `bannedAt`.** Two sources of truth; derive the one from the other.
7. **Read-then-write without a predicate.** The implementation in this chapter can produce two transitions under concurrency; a conditional `updateMany` with `bannedAt: null` / `bannedAt: { not: null }` makes the transition atomic.
8. **`403` vs `404` confusion.** A foreign *tenant* is `403` (rejected before lookup); a foreign *customer ID* inside your tenant is `404` (it does not exist for you).
9. **Banning without a cross-tenant test.** The test "tenant A's token cannot ban tenant B's customer" belongs in the suite for every action endpoint.
10. **Over-broad effects.** A ban that also deletes orders or anonymizes data makes an appeal impossible; state transitions should be reversible unless the business explicitly says otherwise.

---

## 8. Try it yourself

Make the transition atomic and expose the audit trail.

1. Replace the read-then-write in `setCustomerBan` with a conditional update:
   - ban: `updateMany({ where: { id, tenantId, bannedAt: null }, data: { bannedAt: ..., banReason: reason, version: { increment: 1 } } })`;
   - unban: the same with `bannedAt: { not: null }`.
   - `count === 1` → changed; `count === 0` → read the customer to distinguish "already in the desired state" (`200 changed:false`) from "not found" (`404`).
2. Add `GET /v1/tenants/{tenantId}/customers/{customerId}/fraud-events` returning `{ data: [...] }` of `{ id, action, reason, actor, createdAt }`, newest first, tenant-scoped.
3. Prove it: fire two bans concurrently (`xargs -P2`) and confirm exactly one `changed: true` and one `fraud_events` row.

**Hint:** the conditional update removes the race but introduces the two-meaning `count: 0`; the extra read is cheap and only runs on no-op. For the audit endpoint, `fraud_events` is indexed `(tenantId, customerId, createdAt)` already, so a `findMany` with `orderBy: { createdAt: 'desc' }` is enough. When you test concurrency, give the two requests different reasons — then the audit row tells you which one won, and the loser's response should be `changed: false` with the winner's reason already on the customer.

---

## 9. Next

The last pattern is the one with the most arithmetic: applying a coupon to an order, where expiry, currency, redemption limits, and rounding all meet.

Next: [25e. Pattern: applying a coupon](25e-pattern-apply-coupon.md)
