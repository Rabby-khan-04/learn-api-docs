# 14. Versioning and deprecation

> **Run order:** Prisma server, port 4010, auth off, cache off, **deprecation headers on**.
>
> Every request below is copied from `transcripts/14-versioning-deprecation.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

Your class writes a list of rules on the door. Other classes copy the list. One day you change rule 3: "Walk" becomes "Walk on the left". If everyone keeps using the same door, children who learned the old rule get confused.

So the teacher puts a **number on the door**: "Rules, version 1". New rules get "version 2" next to them. Old rules still work for a while, and the door says: "Version 1 will be removed on 31 December. Please start using version 2."

Nobody's class breaks overnight, and everyone knows the end date.

---

## 2. Real name

**API versioning** is the practice of publishing a changed contract under a new identifier while the old one keeps working for a known period. **Deprecation** is announcing that an old identifier will be removed, with a date and a migration path.

What counts as a **breaking change** (needs a new major version):

- Removing or renaming a field, endpoint, or parameter.
- Changing a field's type (`1979` → `"1979"`), format, or meaning.
- Making an optional request field required.
- Changing status codes clients branch on, or error `code` values.
- Tightening validation so previously valid requests now fail.
- Changing default behavior (default sort, default page size, pagination semantics).

What is **additive** (no new version):

- Adding a new optional request field.
- Adding a new response field (clients must ignore unknown fields — see chapter 22).
- Adding a new endpoint, status code branch, or error code that old clients will never receive.
- Loosening validation.

Sources disagree on *where* the version lives:

| Style | Example | Used by |
| --- | --- | --- |
| Path prefix | `/v1/tenants/...` | This course, Stripe-like clarity, many public APIs |
| Date-based path or header | `Stripe-Version: 2026-10-29` | Stripe (per-request dated versions) |
| Query parameter | `?api-version=2026-10-01` | Microsoft Azure guidelines |
| Custom header | `X-GitHub-Api-Version: 2026-03-10` | GitHub |
| Media type | `Accept: application/vnd.acme.v2+json` | Some enterprise APIs |

This course uses a **path prefix** (`/v1`). It is visible in logs, caches, curl commands, and OpenAPI server URLs, and it cannot be forgotten by a client library. Its cost: every route is duplicated in the URL, and resource identity ("same product") appears under two paths.

**Deprecation signals** (modern, machine-readable):

- `Deprecation` header (RFC 9745): `@<unix-seconds>` (previously a date; the `@` form is current).
- `Sunset` header (RFC 8594): HTTP-date when the resource will stop being served.
- `Link` with `rel="deprecation"` pointing at documentation or a migration guide.
- A changelog and OpenAPI `deprecated: true` markers.

The old `/api` alias in this project is exactly that: the same handlers under a legacy prefix, marked with all three headers.

---

## 3. Example

### One router, two mount points

```ts
// src/app.ts (excerpt)
const v1 = Router();
v1.use(
  '/tenants/:tenantId',
  authenticate,
  tenantScope((id) => store.tenantExists(id)),
  rateLimit,
  tenantRouter(store, prisma),
);

app.use('/v1', v1);                          // current, supported
app.use('/api', legacyDeprecation, v1);      // deprecated alias, same handlers
```

Both prefixes reach identical code. There is no second implementation to drift; the alias is a routing decision plus headers.

### The deprecation middleware

```ts
// src/app.ts (excerpt)
function legacyDeprecation(_req, res, next): void {
  if (!config.legacyDeprecationHeaders) {
    next();
    return;
  }
  res.set({
    Deprecation: '@1798761599',                       // RFC 9745: Unix seconds
    Sunset: 'Thu, 31 Dec 2026 23:59:59 GMT',          // RFC 8594: HTTP-date
    Link: '<http://localhost:4010/openapi.json>; rel="deprecation"; type="application/json"',
  });
  next();
}
```

`1798761599` is `2026-12-31T23:59:59Z`; the `Sunset` header is the authoritative human date. The `Link` points at a machine-readable description (here, the OpenAPI document) — in production it should point at the migration guide.

### Deprecated path: works, with three headers

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_acme/products/prd_tee
HTTP/1.1 200 OK
X-Request-Id: 579e4aa5-7beb-443b-a900-a336cf5f9dcb
Deprecation: @1798761599
Sunset: Thu, 31 Dec 2026 23:59:59 GMT
Link: <http://localhost:4010/openapi.json>; rel="deprecation"; type="application/json"
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:27:32 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":2199,"currency":"USD","stock":45,"active":true,"version":3,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:25.073Z"}
```

The response body is identical to the `/v1` version; only the metadata differs.

### Current path: no deprecation headers

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/products/prd_tee
HTTP/1.1 200 OK
X-Request-Id: 30c3f4f2-968f-447c-9f99-9084369bcfe3
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:27:32 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":2199,"currency":"USD","stock":45,"active":true,"version":3,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:25.073Z"}
```

### Deprecation applies to collections too

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_acme/products\?limit=1\&fields=id,name
HTTP/1.1 200 OK
X-Request-Id: d8b15fc0-e54f-4eee-902d-5e4a84875a3b
Deprecation: @1798761599
Sunset: Thu, 31 Dec 2026 23:59:59 GMT
Link: <http://localhost:4010/openapi.json>; rel="deprecation"; type="application/json"
Content-Type: application/json; charset=utf-8
Content-Length: 178
Date: Thu, 29 Oct 2026 12:27:32 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","name":"Running Cap"}],"pagination":{"limit":1,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDEyOjAwOjAwLjAwMFoiLCJpZCI6InByZF9jYXAifQ"}}
```

The middleware mounted on `/api` runs for every method and path under the prefix, so nothing is forgotten.

### A version that does not exist is a 404

```console
$ curl -sS -i --request GET http://localhost:4010/v2/tenants/ten_acme/products
HTTP/1.1 404 Not Found
X-Request-Id: 4874e8f8-edcb-4172-8a5b-31731394f420
Content-Type: application/problem+json; charset=utf-8
Content-Length: 213
Date: Thu, 29 Oct 2026 12:27:32 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/not_found","title":"Not Found","status":404,"detail":"No route matches GET /v2/tenants/ten_acme/products.","instance":"/v2/tenants/ten_acme/products","code":"not_found"}
```

`404` because there is no such resource. Do not return `410 Gone` for a version that never existed; `410` is for a version that existed and was retired. A retired version should return `410` with a problem document that names the replacement and the sunset date (some APIs keep returning `404` for impersonation/security reasons, but for versioning honesty is better).

Matching `.http` file: [`requests/14-versioning-deprecation.http`](../requests/14-versioning-deprecation.http). Full capture: [`transcripts/14-versioning-deprecation.txt`](../transcripts/14-versioning-deprecation.txt).

---

## 4. Bad vs good

**Bad — silently breaking `/v1`**

```ts
// DANGER DEMO — DO NOT SHIP
res.json({ ...orderDto(order), total: order.totalCents / 100 }); // was totalCents: 5297
```

Old clients read `totalCents` and get `undefined`; dashboards show NaN; orders are not charged. A rename or unit change without a version is the most expensive kind of API change.

**Bad — `X-Api-Version: 2` on the same path, undocumented**

The version exists only in a header, is not in logs by default, is easy for proxies to strip, and is not visible in a pasted URL. It can work (Stripe, GitHub), but only with excellent docs and validation.

**Bad — deprecation by email only**

Emails get lost; new integrators never saw them. Machine-readable headers plus a changelog plus `deprecated: true` in OpenAPI reach all clients.

**Bad — removing the old path the day after announcing**

Clients deploy on their own schedule — often quarterly. A sunset date is a promise; honor it or extend it.

**Good — additive change first**

Add `totalFormatted` alongside `totalCents`, announce it, let clients migrate. No version bump, no break.

**Good — new major path, old path with headers, sunset date**

`/v2` serves the new shape; `/v1` keeps serving the old shape and carries `Deprecation`, `Sunset`, and `Link`. Shared handlers where semantics are unchanged, separate DTOs only where they differ.

**Trade-offs:**

- **Path versioning vs media-type versioning.** Path is visible and cache-friendly but versions the whole surface; a client that needs one changed field gets a whole new tree. Media types (`Accept: application/vnd.acme.v2+json`) are precise and REST-purist, but hard to type into a browser and often mishandled by proxies. Stripe's dated header versions are precise per request but require an extremely stable core and strong tooling.
- **Major-only vs date-based.** `v1/v2` is understandable; dates (Stripe) communicate "these are the rules as of this date" and avoid arbitrary numbering, at the cost of huge compatibility matrices.
- **URL `/v1` vs no version until needed.** Versionless APIs can evolve additively for years; adding `/v1` later is itself a change. Starting with `/v1` is cheap insurance.
- **Global version vs per-resource version.** One version for the whole API is simple for clients and painful for teams; per-resource versions limit blast radius but make a "version" ambiguous. Most public APIs choose global.
- **Keeping old fields forever vs a sunset.** Forever avoids breakage but accumulates debt and confuses new users; a published sunset is honest. Keep a compatibility window long enough for real integration cycles (6–12 months is common; 24+ for enterprise).
- **`410 Gone` vs `404` after sunset.** `410` is semantically precise and searchable; `404` hides the fact that the endpoint existed. This course recommends `410` with a problem document after a version is retired.

---

## 5. In a real multi-tenant e-commerce platform

Acme runs a custom storefront, Globex uses a partner integration, and both rely on the platform API. When orders gain a `taxCents` breakdown, the platform adds the field to `/v1` responses (additive, no break). When the pagination envelope changes from `nextCursor` to `links.next`, that is breaking: `/v2` is introduced, `/v1` keeps the old envelope, and both are documented.

`/v1` starts sending `Deprecation`, `Sunset`, and `Link` headers 12 months before removal. The partner's monitoring watches for those headers and files a migration ticket automatically — that is the point of machine-readable deprecation. The OpenAPI document marks the old operation `deprecated: true`; generated SDKs warn at compile time.

When the sunset arrives, `/v1` returns `410 Gone` with `{ "code": "version_retired", "detail": "Use /v2.", ... }`. Support sees a clear error, not a generic 404. Tenant isolation is unchanged: both versions scope by `tenantId` before anything else.

---

## 6. When to use it and when NOT to

**Create a new major version when:**

- You must break the shape or semantics old clients rely on.
- You cannot express the change additively with a deprecation window.
- The cost of maintaining two versions is lower than the cost of breaking clients.

**Prefer additive change (no new version) when:**

- Adding optional fields, endpoints, or new error codes.
- Relaxing validation.
- Changing internal implementation only.

**When not to version:**

- **Internal-only APIs with lockstep deploys.** Coordinate and change; a version adds ceremony with no client to protect. Even then, keep a changelog.
- **A bug fix that restores documented behavior.** Fix it; do not version a bug.
- **Cosmetic documentation changes.** No code impact.

**Do not** create `/v2` for a field addition just to "be safe": every version doubles the test matrix and support surface, and clients learn to ignore version numbers.

---

## 7. Common mistakes

1. **Breaking changes without a version.** Renames, type changes, new required fields.
2. **Version in the body or a custom header only, undocumented.** Invisible in logs and URLs.
3. **Deprecating without a date or replacement.** "This is deprecated" with no `Sunset` and no `Link` is not actionable.
4. **Sunset date in the past at announcement.** Check the clock; a date that already passed is ignored.
5. **Removing old fields before the sunset.** Violates the promise and breaks clients that planned for the announced date.
6. **Two versions with divergent business logic.** Fixes must land in both until one retires; otherwise old clients get different bug behavior.
7. **Changing error codes silently.** Clients branch on `code`; renaming it is breaking.
8. **Changing default pagination or sort.** Implicit behavior changes break clients without a schema change.
9. **Not marking `deprecated: true` in OpenAPI.** Generated SDKs and docs then hide the migration.
10. **Using `Deprecation: true` with RFC 9745 semantics.** Current RFC form is a date or `@`-prefixed Unix timestamp; `true` is from the earlier draft and no longer correct.
11. **Forgetting CORS/proxy exposure.** Browsers cannot read `Deprecation`/`Sunset` unless they are in `Access-Control-Expose-Headers`.
12. **No changelog.** Headers announce the fact; the changelog explains what to do.
13. **Versioning `/v1` on every unrelated endpoint.** A global prefix is a commitment; splitting the whole API for one resource's change multiplies work.

---

## 8. Try it yourself

**Exercise.** You are about to make `POST /v1/.../orders` return `201` with an order whose `items` array changes from objects to `{ line: {...}, productRef: {...} }`.

1. Classify the change: additive or breaking? Why?
2. Design the rollout: what goes into `/v1`, what goes into `/v2`, and what headers does `/v1` send for how long?
3. Write the `curl -i` you expect 30 days before sunset and the one you expect 30 days after.
4. What does `/v2` return for `GET /v2/.../orders/{id}` created under `/v1`? Think about resource identity across versions.

**Hint.** Breaking: clients iterate `items` and read `productId`, `sku`, `name` directly. `/v1` keeps the old shape and gets `Deprecation`, `Sunset`, `Link`; `/v2` serves the new shape. Before sunset: `200` plus the three headers; after: `410 Gone` with `code: version_retired` and a link to `/v2` docs. Resource identity: an order is the same order; `/v2` should return the same id with the new representation, not a copy or a 404.

---

## 9. Next

[15. Caching and conditional requests →](15-caching-conditional-requests.md)
