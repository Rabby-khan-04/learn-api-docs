# 16. Rate limiting

> **Run order:** Prisma server, port **4012**, auth off, cache off, `RATE_LIMIT_ENABLED=on RATE_LIMIT_MAX=2 RATE_LIMIT_WINDOW_SECONDS=60`.
>
> Every request below is copied from `transcripts/16-rate-limiting.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

The class has one ball. Everyone wants to play, and one child wants to hold it all day. The teacher says: "Each child may ask for the ball **twice per minute**. After that, wait until the minute is over."

When you ask for a third time, the teacher does not pretend the ball does not exist. She says: "Not now. Try again in 37 seconds." That is a **429** with **Retry-After**.

And the limit is per child, not for the whole class: one noisy child does not stop the others from playing.

---

## 2. Real name

**Rate limiting** caps how many requests a client may make in a time window. It protects availability, enforces fair use, and contains abuse and bugs (a retry loop, a runaway integration).

The essentials:

| Piece | Choice in this project |
| --- | --- |
| What is limited | Per **tenant**, not per IP or per user |
| Algorithm | **Fixed window** (counter resets every 60 s) |
| Limit | 2 requests per 60 s (tutorial value) |
| Rejection | `429 Too Many Requests` + `Retry-After` |
| Observability | `RateLimit-Policy` and `RateLimit` headers |
| Where | After authentication, so the tenant is known |

Status semantics: `429` is defined by RFC 6585. `Retry-After` (RFC 9110) tells the client how many seconds (or an HTTP-date) to wait. The `RateLimit-Policy`/`RateLimit` headers come from the IETF `ratelimit-headers` draft; they are not yet a final standard, so treat them as informative and keep `Retry-After` as the contract.

**Partitioning matters more than the algorithm.** A per-IP limit punishes offices behind one NAT and misses a distributed attacker. A per-tenant limit matches who pays and who can be contacted. A per-API-key limit is finer; per-user is finer still. Many systems combine several (tenant + route class).

Algorithms, briefly:

- **Fixed window** (this project): simple, cheap, but allows a burst of 2× the limit across the window boundary (2 at 12:00:59, 2 at 12:01:00).
- **Sliding window / log**: smooth, needs per-request timestamps or a weighted counter.
- **Token bucket**: allows short bursts up to a bucket size while enforcing an average rate; common in gateways.
- **Leaky bucket**: smooths output; good for protecting a downstream service.

---

## 3. Example

### The limiter

```ts
// src/http/rate-limit.ts (excerpt, comments added)
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>(); // in-memory: one process only

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  if (!config.rateLimitEnabled) { next(); return; }

  const partition = req.tenantId ?? req.ip ?? 'unknown'; // tenant first, IP fallback
  const now = Date.now();
  const windowMs = config.rateLimitWindowSeconds * 1000;
  let bucket = buckets.get(partition);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(partition, bucket);
  }

  const remainingBefore = Math.max(0, config.rateLimitMax - bucket.count);
  const resetSeconds = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));
  res.set('RateLimit-Policy', `"standard";q=${config.rateLimitMax};w=${config.rateLimitWindowSeconds}`);
  res.set('RateLimit', `"standard";r=${remainingBefore};t=${resetSeconds}`);

  if (bucket.count >= config.rateLimitMax) {
    res.set('Retry-After', String(resetSeconds));
    throw new HttpProblem(429, 'rate_limited', 'Too many requests for this tenant. Retry later.', {
      extensions: { retryAfterSeconds: resetSeconds },
    });
  }

  bucket.count += 1;
  res.set('RateLimit', `"standard";r=${Math.max(0, config.rateLimitMax - bucket.count)};t=${resetSeconds}`);
  next();
}
```

It is mounted after `authenticate` and `tenantScope`, which is why `req.tenantId` exists:

```ts
// src/app.ts (excerpt)
v1.use(
  '/tenants/:tenantId',
  authenticate,
  tenantScope((id) => store.tenantExists(id)),
  rateLimit,          // tenant is known here
  tenantRouter(store, prisma),
);
```

If the limiter ran before authentication, it could only partition by IP and an unauthenticated flood could exhaust a tenant's bucket or bypass it by rotating IPs.

### Requests 1 and 2: allowed, remaining decreases

```console
$ curl -sS -i --request GET http://localhost:4012/v1/tenants/ten_globex/products\?limit=1
HTTP/1.1 200 OK
X-Request-Id: a45ae624-57b6-45a6-8ef2-26789e11b652
RateLimit-Policy: "standard";q=2;w=60
RateLimit: "standard";r=1;t=60
Content-Type: application/json; charset=utf-8
Content-Length: 403
Date: Thu, 29 Oct 2026 12:27:38 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_eu_tee","sku":"TEE-EU","slug":"eu-tee","name":"EU Classic Tee","description":"Euro edition tee.","priceCents":2199,"currency":"EUR","stock":25,"active":true,"version":1,"createdAt":"2026-01-01T14:00:00.000Z","updatedAt":"2026-10-29T12:27:24.625Z"}],"pagination":{"limit":1,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDE0OjAwOjAwLjAwMFoiLCJpZCI6InByZF9ldV90ZWUifQ"}}
```

```console
$ curl -sS -i --request GET http://localhost:4012/v1/tenants/ten_globex/products\?limit=1
HTTP/1.1 200 OK
X-Request-Id: 1db6249f-8020-4a1f-a335-72d4f78087ad
RateLimit-Policy: "standard";q=2;w=60
RateLimit: "standard";r=0;t=60
Content-Type: application/json; charset=utf-8
Content-Length: 403
Date: Thu, 29 Oct 2026 12:27:38 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_eu_tee","sku":"TEE-EU","slug":"eu-tee","name":"EU Classic Tee","description":"Euro edition tee.","priceCents":2199,"currency":"EUR","stock":25,"active":true,"version":1,"createdAt":"2026-01-01T14:00:00.000Z","updatedAt":"2026-10-29T12:27:24.625Z"}],"pagination":{"limit":1,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDE0OjAwOjAwLjAwMFoiLCJpZCI6InByZF9ldV90ZWUifQ"}}
```

`q=2;w=60` is the quota policy: 2 requests per 60 seconds. `r=1` then `r=0` is the remaining quota after this request; `t=60` is seconds until reset.

### Request 3: 429 with Retry-After

```console
$ curl -sS -i --request GET http://localhost:4012/v1/tenants/ten_globex/products\?limit=1
HTTP/1.1 429 Too Many Requests
X-Request-Id: d0a1a9e4-8373-4868-b2be-95b05a457413
RateLimit-Policy: "standard";q=2;w=60
RateLimit: "standard";r=0;t=60
Retry-After: 60
Content-Type: application/problem+json; charset=utf-8
Content-Length: 256
Date: Thu, 29 Oct 2026 12:27:38 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/rate_limited","title":"Too Many Requests","status":429,"detail":"Too many requests for this tenant. Retry later.","instance":"/v1/tenants/ten_globex/products?limit=1","code":"rate_limited","retryAfterSeconds":60}
```

The rejected request did not reach the route. The body is an RFC 9457 problem (chapter 08a) with a stable `code` and a numeric `retryAfterSeconds` mirroring the header, so JSON-only clients do not have to parse headers.

### Another tenant still has its own quota

```console
$ curl -sS -i --request GET http://localhost:4012/v1/tenants/ten_acme/products\?limit=1
HTTP/1.1 200 OK
X-Request-Id: bbafa7f4-c407-4237-9a88-cfe4af8100f8
RateLimit-Policy: "standard";q=2;w=60
RateLimit: "standard";r=1;t=60
Content-Type: application/json; charset=utf-8
Content-Length: 398
Date: Thu, 29 Oct 2026 12:27:38 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","sku":"CAP-001","slug":"running-cap","name":"Running Cap","description":"Lightweight cap.","priceCents":2499,"currency":"USD","stock":0,"active":false,"version":1,"createdAt":"2026-01-01T12:00:00.000Z","updatedAt":"2026-10-29T12:27:24.625Z"}],"pagination":{"limit":1,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDEyOjAwOjAwLjAwMFoiLCJpZCI6InByZF9jYXAifQ"}}
```

Globex being throttled does not affect Acme. This is the fairness property of per-tenant partitioning.

Matching `.http` file: [`requests/16-rate-limiting.http`](../requests/16-rate-limiting.http). Full capture: [`transcripts/16-rate-limiting.txt`](../transcripts/16-rate-limiting.txt).

---

## 4. Bad vs good

**Bad — no limit at all**

One integration with a retry bug can take the service down for every tenant. Rate limiting is not only abuse defense; it is blast-radius control.

**Bad — limiting per IP only**

```ts
const key = req.ip; // DANGER: one office NAT, one noisy customer
```

An office of 200 agents shares one IP and hits the limit; an attacker rotates IPs and never does. Tenant-aware limits match the business unit that can be contacted, billed, or suspended.

**Bad — `429` without `Retry-After`**

A client that respects the status but has no wait hint retries immediately, making the overload worse. Include `Retry-After` on every 429.

**Bad — counting requests before authentication**

An unauthenticated flood consumes the bucket of the tenant it claims to be, which is a cheap denial-of-service against that tenant. Authenticate first (or use a separate, stricter unauthenticated limit).

**Bad — a single global in-memory Map in a multi-process deployment**

```ts
// DANGER DEMO — DO NOT SHIP (in production)
const buckets = new Map(); // each replica has its own counters
```

With 10 replicas, the effective limit is 10× the configured value, and a user can bounce between replicas. Use a shared store (Redis, a gateway, or the database) with atomic increments, or enforce limits at the edge.

**Good — tenant-partitioned, observable, retry-friendly**

```ts
const partition = req.tenantId ?? req.ip ?? 'unknown';
// ... atomic-ish counter, headers, 429 + Retry-After ...
```

**Trade-offs:**

- **Fixed vs sliding window.** Fixed is trivial and lets a 2× burst at boundaries; sliding is fairer but costs more state. For most APIs a token bucket gives burst control with less boundary artifact. Document the choice.
- **Reject vs queue (429 vs 503).** `429` means "you are over your quota"; `503` means "the service is unavailable". Do not use 503 for quotas; clients and retry systems react differently.
- **Per-tenant vs per-key vs per-endpoint.** A single tenant quota is simple and fair between tenants; a heavy tenant can still starve its own users. Add per-endpoint classes (`write` vs `read`) or per-API-key limits when needed. Do not multiply dimensions without a clear owner.
- **Count all requests vs weighted costs.** A bulk write costs more than a GET. Weighted quotas need a documented cost model; a simple request count is easier to explain.
- **Headers from a draft.** `RateLimit-*` is not finalized; sending them is fine, but clients should not fail if they disappear. `Retry-After` is stable.
- **In-memory vs Redis.** In-memory is perfect for a tutorial and a single process; it is wrong behind a load balancer. The move to Redis is a dependency and a failure mode (what if Redis is down? fail open or closed?). Decide explicitly.
- **Fail open vs closed.** If the limiter store is unavailable, failing closed (deny) protects the backend but takes the API down; failing open (allow) keeps serving but loses protection. Most consumer APIs fail open with a metric and an alert.
- **Whitelisting.** Internal batch jobs may need higher quotas. Use a separate, authenticated partition rather than disabling the limiter for everyone with a header.

---

## 5. In a real multi-tenant e-commerce platform

Globex runs an inventory sync that polls every second. Without limits it would consume 86,400 requests per day and slow every other tenant. With a per-tenant quota, it gets 429s and `Retry-After`, its client backs off, and Acme's storefront stays fast. Globex's integration team sees the headers in logs and tunes its polling.

The limit runs after authentication and tenant scoping, so a request with a forged tenant path but a Globex token is rejected at the authorization boundary before it can spend Acme's quota. The 429 body uses the same problem format as every other error, so the partner's error handler sees `code: "rate_limited"` and schedules a retry instead of alerting on an unknown shape.

At the edge, the platform also runs a coarse per-IP limit on unauthenticated traffic to absorb floods. That limit is deliberately separate from the tenant quota: it protects the auth layer, while the tenant quota protects the business.

---

## 6. When to use it and when NOT to

**Use rate limiting when:**

- The API is public or partner-facing.
- A single client can affect others (shared database, shared downstream).
- Operations are expensive (exports, search, order creation).
- You need a contractual usage tier.

**When not to:**

- **Internal service-to-service calls** inside a trusted network with their own backpressure. Even then, a circuit breaker may be the better tool.
- **One-off admin scripts** — but they should still be authenticated.

**Do not** rate limit by IP alone for authenticated APIs, and do not return 429 for business-rule failures (stock, coupons); those are 409/422 (chapters 08a, 25e).

---

## 7. Common mistakes

1. **Unbounded in-memory counters.** Memory grows with the number of keys; add expiry and cap the map.
2. **Per-IP limits behind a proxy without `trust proxy`.** Every request looks like it comes from the load balancer, so one bucket is shared by all. Configure trusted proxies correctly.
3. **Limiting before auth.** Claimed tenants can be denied service by anyone.
4. **No `Retry-After`.** Immediate retries amplify the problem.
5. **`Retry-After` as an ISO date in one place, seconds in another.** Pick one (seconds is simplest) and be consistent; RFC allows both.
6. **Counting only successes.** Failed auth attempts and 4xx should usually count too; otherwise a brute-force loop is free.
7. **Forgetting health checks and docs.** Monitoring endpoints must not consume the quota, or alerts will fire during incidents.
8. **429 with a body that changes shape.** Keep it an RFC 9457 problem with a stable code.
9. **Limits that differ per replica.** Use a shared store or edge enforcement.
10. **Hidden limits.** Document quotas, windows, and burst behavior; otherwise partners discover them in production.
11. **Overly strict limits for normal traffic.** A limit of 1/minute breaks pagination; size limits from real traffic data.
12. **Not differentiating read vs write.** A write-heavy import can starve reads; consider separate buckets.
13. **Leaking counters across tenants.** The partition key must include the tenant; a global counter is a fairness bug.

---

## 8. Try it yourself

**Exercise.** The partner API needs 600 requests/minute per tenant, with short bursts allowed.

1. Choose an algorithm (fixed, sliding, or token bucket) and justify it in two sentences.
2. Where does the limiter go relative to authentication and tenant scoping, and why?
3. Design the 429 response: status, headers, body.
4. Your service runs 8 replicas. What changes in the implementation, and what happens if the shared store is down?
5. How would you exempt a trusted internal sync job without weakening limits for everyone?

**Hint.** A token bucket (capacity ~60, refill 10/s) allows bursts while enforcing the average, without fixed-window boundary bursts. Place it after auth so the tenant is trusted. 429 + `Retry-After` + `RateLimit` headers + problem body with `rate_limited`. Replicas need a shared atomic store (Redis `INCR` with expiry, or a token-bucket script); decide fail-open with alerting or fail-closed. Exempt a named, authenticated service identity into a separate high-quota partition, not by a spoofable header.

---

## 9. Next

[17. Authentication, authorization, and tenant scoping →](17-auth-authorization-tenant-scoping.md)
