# 17. Authentication, authorization, and tenant scoping

> **Run order:** Prisma server, port 4010, **auth on**, cache off, deprecation headers off.
>
> Every request below is copied from `transcripts/17-auth-authorization-tenant-scoping.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

The school has a front door with a guard. The guard checks your **card**: "Is this really you?" That is **authentication** (who are you?).

Inside, there are classrooms for class 3A and class 3B. Your card says "3A". If you walk into 3B, the teacher says: "Your card is real, but you do not belong here." That is **authorization** (what may you do?).

Your card also says "student" or "teacher". A student may read the board but not change the rules. Same card, different permissions.

And one special inspector has a card that says "all classes". The inspector may visit any room, but a room that does not exist is still "no such room".

---

## 2. Real name

**Authentication** proves identity. **Authorization** decides permissions. **Tenant scoping** is authorization applied to a multi-tenant boundary: a valid Acme token must not read or write Globex data, even if it knows a Globex URL or id.

This project uses **Bearer tokens** (RFC 6750) — opaque strings mapped to a principal:

| Token | Tenant | Role |
| --- | --- | --- |
| `tok_acme_admin` | `ten_acme` | `ADMIN` |
| `tok_acme_support` | `ten_acme` | `SUPPORT` |
| `tok_globex_admin` | `ten_globex` | `ADMIN` |
| `tok_platform` | `null` | `PLATFORM_ADMIN` |

In production these would be JWTs or opaque tokens issued by an identity provider, validated and mapped to the same context. The **shape** of the checks is what matters here.

The request pipeline:

```
Bearer token → authenticate() → req.auth {subject, tenantId, role}
             → tenantScope()  → path :tenantId must match req.auth.tenantId
                                (PLATFORM_ADMIN exempt), tenant must exist
             → rateLimit()    → per-tenant quota
             → route          → requireRole(...) for writes
             → store          → every query includes tenantId
```

Rules:

1. **The token is the source of truth for tenant.** The path tenant is verified against it, never trusted on its own.
2. **401 vs 403.** Missing/invalid credentials → `401` with `WWW-Authenticate`. Valid credentials, insufficient permission → `403`.
3. **Tenant existence is hidden.** An unknown tenant returns `403`, not `404`, so the API does not confirm which tenant ids exist (except to a platform admin who already sees them).
4. **Resource ids are looked up within the tenant.** A Globex order id under Acme is `404`, not `403`: from Acme's point of view the resource does not exist.
5. **Writes require roles.** Reads are allowed to any valid tenant principal; create/update/delete require `ADMIN` or `PLATFORM_ADMIN`.
6. **Platform admin is the only cross-tenant role.** It is exempt from the tenant match but not from "tenant must exist".
7. **Auth-off is a danger demo.** Chapters 1–16 run with `AUTH_ENABLED=off`; the code labels that path explicitly.

---

## 3. Example

### Authentication

```ts
// src/http/auth.ts (excerpt)
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  if (!config.authEnabled) {
    // DANGER DEMO for chapters 1-16: any caller can pick any tenant.
    req.auth = { subject: 'tutorial', tenantId: null, role: 'DEVELOPMENT' };
    next();
    return;
  }

  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized('A Bearer token is required.');
  }
  const token = header.slice('Bearer '.length).trim();
  const principal = TOKENS[token];
  if (!principal) throw unauthorized('The Bearer token is invalid.');
  req.auth = principal;
  next();
}
```

`unauthorized()` (chapter 08a) always sets the challenge:

```ts
new HttpProblem(401, 'invalid_token', detail, {
  headers: { 'WWW-Authenticate': 'Bearer realm="api-learn", error="invalid_token"' },
});
```

### Tenant scoping

```ts
// src/http/auth.ts (excerpt)
export function tenantScope(tenantExists: (tenantId: string) => Promise<boolean>) {
  return async (req, _res, next) => {
    const tenantId = req.params.tenantId;
    // ... auth-off branch (danger demo) ...
    const auth = req.auth;
    if (!auth) throw unauthorized('Authentication is required.');
    if (auth.role !== 'PLATFORM_ADMIN' && auth.tenantId !== tenantId) {
      throw forbidden('This token is not allowed to access that tenant.');
    }
    if (!(await tenantExists(tenantId))) {
      throw forbidden('This token is not allowed to access that tenant.');
    }
    req.tenantId = tenantId;
    next();
  };
}
```

The order is deliberate: wrong tenant is rejected **before** the existence query, so a tenant token cannot probe which tenant ids exist.

### Role checks on writes

```ts
// src/routes/products.ts (excerpt)
router.post('/', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => { /* ... */ });
router.patch('/:productId', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => { /* ... */ });
```

```ts
// src/http/auth.ts (excerpt)
export function requireRole(...roles: AuthRole[]) {
  return (req, _res, next) => {
    if (!config.authEnabled) { next(); return; }
    const role = req.auth?.role;
    if (!role || !roles.includes(role)) {
      throw forbidden(`This action requires one of these roles: ${roles.join(', ')}.`);
    }
    next();
  };
}
```

### No credentials: 401 with a challenge

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/products
HTTP/1.1 401 Unauthorized
X-Request-Id: 31735ee1-6feb-42e4-a433-32d0e148f027
WWW-Authenticate: Bearer realm="api-learn", error="invalid_token"
Content-Type: application/problem+json; charset=utf-8
Content-Length: 200
Date: Thu, 29 Oct 2026 12:28:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_token","title":"Unauthorized","status":401,"detail":"A Bearer token is required.","instance":"/v1/tenants/ten_acme/products","code":"invalid_token"}
```

### Invalid token: still 401

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/products -H 'Authorization: Bearer tok_not_real'
HTTP/1.1 401 Unauthorized
X-Request-Id: 45a301f5-7e6f-4c67-a4af-8474231739f7
WWW-Authenticate: Bearer realm="api-learn", error="invalid_token"
Content-Type: application/problem+json; charset=utf-8
Content-Length: 201
Date: Thu, 29 Oct 2026 12:28:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_token","title":"Unauthorized","status":401,"detail":"The Bearer token is invalid.","instance":"/v1/tenants/ten_acme/products","code":"invalid_token"}
```

`401` means "I do not know who you are"; the body detail may differ (missing vs invalid) but the status and challenge are the same. Never reveal whether a token exists.

### Valid token, wrong tenant: 403

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_globex/products -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 403 Forbidden
X-Request-Id: 645de198-0b5c-4e8c-856a-f1f40759f18a
Content-Type: application/problem+json; charset=utf-8
Content-Length: 212
Date: Thu, 29 Oct 2026 12:28:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/forbidden","title":"Forbidden","status":403,"detail":"This token is not allowed to access that tenant.","instance":"/v1/tenants/ten_globex/products","code":"forbidden"}
```

The token is genuine; the tenant is not. `403`, not `401`: re-authenticating will not help.

### Matching tenant: 200

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/products\?limit=1 -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 200 OK
X-Request-Id: bb43a65a-9a29-4251-89e0-cf398cd9a4be
Content-Type: application/json; charset=utf-8
Content-Length: 398
Date: Thu, 29 Oct 2026 12:28:46 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","sku":"CAP-001","slug":"running-cap","name":"Running Cap","description":"Lightweight cap.","priceCents":2499,"currency":"USD","stock":0,"active":false,"version":1,"createdAt":"2026-01-01T12:00:00.000Z","updatedAt":"2026-10-29T12:28:43.654Z"}],"pagination":{"limit":1,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDEyOjAwOjAwLjAwMFoiLCJpZCI6InByZF9jYXAifQ"}}
```

### Support can read but cannot create

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/products -H 'Authorization: Bearer tok_acme_support' -H 'Content-Type: application/json' --data-binary '{
  "sku": "SUP-001",
  "slug": "support-product",
  "name": "Support Product",
  "priceCents": 100,
  "currency": "USD",
  "stock": 1
}'
HTTP/1.1 403 Forbidden
X-Request-Id: c4232ceb-9006-483a-bf98-957886fe850c
Content-Type: application/problem+json; charset=utf-8
Content-Length: 225
Date: Thu, 29 Oct 2026 12:28:46 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/forbidden","title":"Forbidden","status":403,"detail":"This action requires one of these roles: ADMIN, PLATFORM_ADMIN.","instance":"/v1/tenants/ten_acme/products","code":"forbidden"}
```

The tenant check already passed; this is the role check. Keeping the two failures distinguishable in the detail (and identical in status/code) is useful for logs without leaking data.

### Admin of the same tenant: 201

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/products -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{
  "sku": "ADM-001",
  "slug": "admin-product",
  "name": "Admin Product",
  "priceCents": 100,
  "currency": "USD",
  "stock": 1
}'
HTTP/1.1 201 Created
X-Request-Id: 76883c1b-e692-480b-beb0-048aa0ed458a
Location: /v1/tenants/ten_acme/products/prd_3efcdb24-840d-4967-9c81-b44fbb45ce2a
Content-Type: application/json; charset=utf-8
Content-Length: 278
Date: Thu, 29 Oct 2026 12:28:46 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_3efcdb24-840d-4967-9c81-b44fbb45ce2a","sku":"ADM-001","slug":"admin-product","name":"Admin Product","description":null,"priceCents":100,"currency":"USD","stock":1,"active":true,"version":1,"createdAt":"2026-10-29T12:28:46.118Z","updatedAt":"2026-10-29T12:28:46.118Z"}
```

### Platform admin works across tenants

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_globex/products\?limit=1 -H 'Authorization: Bearer tok_platform'
HTTP/1.1 200 OK
X-Request-Id: f9507431-7da3-4d94-ae79-7de4c9f3ada6
Content-Type: application/json; charset=utf-8
Content-Length: 403
Date: Thu, 29 Oct 2026 12:28:46 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_eu_tee","sku":"TEE-EU","slug":"eu-tee","name":"EU Classic Tee","description":"Euro edition tee.","priceCents":2199,"currency":"EUR","stock":25,"active":true,"version":1,"createdAt":"2026-01-01T14:00:00.000Z","updatedAt":"2026-10-29T12:28:43.654Z"}],"pagination":{"limit":1,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDE0OjAwOjAwLjAwMFoiLCJpZCI6InByZF9ldV90ZWUifQ"}}
```

### Unknown tenant: 403, no existence oracle

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_ghost/products -H 'Authorization: Bearer tok_platform'
HTTP/1.1 403 Forbidden
X-Request-Id: 34252706-c2bd-45cd-860b-399ca004bc35
Content-Type: application/problem+json; charset=utf-8
Content-Length: 211
Date: Thu, 29 Oct 2026 12:28:46 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/forbidden","title":"Forbidden","status":403,"detail":"This token is not allowed to access that tenant.","instance":"/v1/tenants/ten_ghost/products","code":"forbidden"}
```

An authenticated platform admin still gets the same 403 as a tenant mismatch. The API does not confirm whether `ten_ghost` exists; a 404 here would let an attacker enumerate tenant ids. The cost is a less specific error for a legitimate admin; platform tooling can list tenants through an explicit admin endpoint (out of scope) rather than by probing URLs.

Matching `.http` file: [`requests/17-auth-authorization-tenant-scoping.http`](../requests/17-auth-authorization-tenant-scoping.http). Full capture: [`transcripts/17-auth-authorization-tenant-scoping.txt`](../transcripts/17-auth-authorization-tenant-scoping.txt).

---

## 4. Bad vs good

**Bad — trusting a tenant from the body or query**

```ts
// DANGER DEMO — DO NOT SHIP
const tenantId = req.body.tenantId; // client chooses whose data to read
const products = await prisma.product.findMany({ where: { tenantId } });
```

The path/token boundary is gone; any caller can name any tenant. Tenant must come from the verified token (or platform context), never from client input.

**Bad — role from a client header**

```ts
// DANGER DEMO — DO NOT SHIP
if (req.get('x-role') === 'ADMIN') { /* allow */ }
```

Headers are client-controlled. Roles come from the authenticated principal.

**Bad — 404 for a wrong tenant**

Returning `404` when the token does not match the path hides an authorization failure as absence, which makes support and security review harder, and lets a client distinguish "wrong tenant" from "wrong id" only by guessing. Use `403` for the tenant boundary.

**Bad — cross-tenant id lookups without a filter**

```ts
const product = await prisma.product.findFirst({ where: { id } }); // any tenant
```

Always include `tenantId` (chapter 11). A 404 for the wrong tenant is correct *after* the tenant boundary has passed.

**Bad — 401 for an authorization failure**

Retrying with a fresh token cannot fix a missing role; `401` sends clients into a re-auth loop. `403` is final.

**Good — token → tenant → role → scoped query**

```ts
authenticate, tenantScope, requireRole('ADMIN'), store.findProduct(tenantId, id)
```

**Trade-offs:**

- **Opaque tokens vs JWT.** Opaque tokens require a lookup but can be revoked instantly and hide claims; JWTs are stateless and fast to verify but revocation is hard and claims can go stale. Tenants and roles in a JWT must be re-checked against current state for sensitive actions.
- **Tenant in path vs in token only.** Path makes URLs shareable, cacheable, and explicit in logs, and lets a platform admin address tenants; it also invites copy/paste mistakes. Token-only prevents URL tampering but hides the tenant from logs and breaks multi-tenant admin UIs. Path + verification is a common compromise.
- **403 vs 404 for cross-tenant ids.** `403` is honest; `404` is more privacy-preserving (does not confirm the id exists elsewhere). This API uses `403` for the tenant boundary and `404` inside it. Both are defensible if consistent; document the choice.
- **Platform admin breadth.** Exempting one role simplifies operations and concentrates risk. Require stronger authentication, audit every cross-tenant action, and consider scoped support roles instead of a global bypass.
- **Roles vs permissions.** Three coarse roles are easy to reason about; per-permission checks (or ABAC) scale better but need a policy engine and tests. Start coarse; split when a real conflict appears.
- **Existence checks on every request.** `tenantExists` is one indexed query; it prevents FK errors and confusion. Caching it risks stale grants after tenant deletion; database FKs already prevent orphan rows.
- **401 challenge details.** `WWW-Authenticate: Bearer error="invalid_token"` helps standards-aware clients; some APIs omit details to avoid oracle behavior. This project uses the standard error code but keeps messages generic.

---

## 5. In a real multi-tenant e-commerce platform

A partner integration for Acme is issued a token tied to `ten_acme`. It calls `GET /v1/tenants/ten_acme/orders/ord_123`. The path, token, and store filter all agree. A bug in the partner's code swaps the tenant segment to `ten_globex`: the tenant middleware rejects it with 403 before any order is read. Even if the middleware were bypassed, the store's `where: { tenantId, id }` would return no row.

A support agent at Acme can read customers and orders but cannot create products; the role check is per route, not per tenant. A platform engineer investigating a billing anomaly uses `tok_platform`, sees both tenants, and every such request is logged with the subject and target tenant for audit.

The ghost-tenant check matters during incident response: an attacker enumerating `/v1/tenants/ten_.../products` gets the same 403 whether a tenant exists or not, so they cannot build a customer list from error codes.

At the database, composite foreign keys (chapter 11) are the last line: even a service bug that forgets the filter cannot link an order item to another tenant's product.

---

## 6. When to use it and when NOT to

**Use this layered model when:**

- The API serves more than one organization.
- Some endpoints mutate data.
- You need auditable, explainable access decisions.

**Simplifications that are fine:**

- **Single-tenant internal API**: authentication may be mutual TLS or a service mesh identity; roles may be coarse.
- **Read-only public API**: authentication may be omitted for public catalog endpoints, but tenant scoping still matters if the URL exposes tenant paths.

**Do not** rely on hiding URLs ("security by obscurity"), on client-supplied tenant/role values, or on CORS as an authorization mechanism. CORS is a browser policy, not a server-side control.

---

## 7. Common mistakes

1. **Trusting `tenantId` from the body, query, or a custom header.**
2. **Trusting a role header** or a role embedded in a token without verifying the token signature.
3. **Checking the tenant after fetching the row.** Filter first; 404/403 after.
4. **401 vs 403 confusion.** Re-auth loops, confused support tickets.
5. **404 for the tenant boundary.** Hides authorization failures; this API uses 403.
6. **Leaking existence with different errors.** Ghost tenant vs wrong tenant must look the same.
7. **Platform admin without audit.** Cross-tenant actions must be logged with subject and tenant.
8. **Forgetting role checks on some write routes.** Centralize `requireRole` or test every mutating endpoint.
9. **Authorization in the UI only.** The server is the boundary; the UI merely reflects it.
10. **Tokens in URLs.** They end up in logs, caches, and Referer headers; use the `Authorization` header (or a secure cookie with CSRF protection for browser apps).
11. **Long-lived tokens with no revocation.** Opaque tokens with a revocation store, or short JWTs plus refresh, are safer.
12. **Logging tokens and personal data.** Redact `Authorization` and customer PII.
13. **CORS as access control.** Any non-browser client ignores it.
14. **Trusting `X-Forwarded-For` without a trusted proxy.** Matters for IP-based limits and audit, not for tenant auth.
15. **Cross-tenant reads through included relations.** Loading `order.customer` without a tenant check on the join can leak; keep the where clause on both sides.

---

## 8. Try it yourself

**Exercise.** Add a `READ_ONLY` role that may GET everything in its tenant but may not write.

1. Where do you add the role check: middleware, route, or store? Why?
2. What status and body should `POST /v1/tenants/ten_acme/products` with `tok_acme_viewer` return?
3. Should `GET /v1/tenants/ten_globex/products` with an Acme viewer token be 401, 403, or 404? Justify.
4. A platform admin calls `GET /v1/tenants/ten_ghost/products`. Keep the current 403 or change it? What does each choice reveal?
5. How would you test that every write route is protected?

**Hint.** Add `VIEWER` to the token map and include it only in read routes; writes keep `requireRole('ADMIN','PLATFORM_ADMIN')`. The create returns 403 `forbidden` with a role detail. Wrong tenant is 403 (authenticated, not allowed), not 401. Ghost tenant stays 403 to avoid an existence oracle unless you add a dedicated admin endpoint. Test by enumerating `router.stack` or with a table-driven test that calls every mutating route with a viewer token and expects 403.

---

## 9. Next

[18. Long-running operations →](18-long-running-operations.md)
