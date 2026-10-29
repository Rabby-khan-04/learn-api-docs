# 23. Alternatives: GraphQL and tRPC

> **No requests in this chapter.** GraphQL and tRPC servers were not built for this course, so every GraphQL and tRPC code block below is a **sketch, not executed output**. No request was executed for this chapter either: the REST snippets are abridged from transcripts already captured in chapters 22 and 25b, with the source transcript named in each comment. The REST endpoints themselves are the real ones built in chapters 1–22.

---

## 1. Simple explanation (like I'm 7)

You have a shop with a counter. You can ask for **one thing at a time**: "one shirt please", "the price list please", "that customer please". Each request is a sentence the shop understands.

Two other kinds of shop exist.

- One shop gives you a **menu with a fill-in-the-blank order form**. You write "I want the name and price of every shirt, and for each shirt the name of its supplier" on one slip, hand it over once, and get exactly that. That is **GraphQL**.
- Another shop only serves **one specific customer**: your own app, written by the same team. You don't fill in a form; you call a **function** with typed arguments and the shop hands back a typed result, as if it were a local function call. That is **tRPC**.

All three shops sell the same goods. The question is not "which is better" but "who is walking in the door, and what do they need to ask".

---

## 2. Real name

**GraphQL** is a query language and runtime for APIs, standardized by the GraphQL specification. A client sends a **document** describing exactly the fields it wants, and the server resolves them against a **schema** of types. One endpoint (`POST /graphql`) serves everything. Features: typed schema, introspection, field selection, fragments, mutations, subscriptions, and a client-side cache (Apollo, urql, Relay) that normalizes entities by ID.

**tRPC** is a TypeScript library for building end-to-end type-safe APIs without a schema language or code generation. The server exports a router of procedures; the client imports the *type* of that router, so a call like `trpc.products.byId.query({ id })` is checked by the compiler. It is not a standard; it exists only inside a TypeScript monorepo (or a shared package), and it speaks HTTP underneath but the wire format is an implementation detail.

**REST** (chapters 1–22) exposes resources with HTTP semantics. The contract is the HTTP surface itself — methods, status codes, headers, media types — which is why any language, `curl`, a browser, and a CDN can all be first-class clients.

The three architectures optimize for different things:

| | REST (this course) | GraphQL | tRPC |
| --- | --- | --- | --- |
| Contract | HTTP + OpenAPI (ch. 21) | GraphQL schema (SDL) | TypeScript types |
| Client | any HTTP client | GraphQL client or plain `fetch` | TypeScript only |
| Fetch shape | fixed per endpoint | chosen by the client | chosen by the procedure |
| HTTP semantics | methods, status codes, caching headers | one `POST`, usually `200` | one `POST`, RPC-ish |
| Caching | HTTP caches, ETags, CDNs | client cache; HTTP caching is hard | client cache (TanStack Query etc.) |
| Versioning | `/v1`, additive change (ch. 14) | additive schema change, deprecation directives | change the type, redeploy both sides |
| Best consumer | public/partner APIs, many languages | apps with deeply nested, varying data needs | your own front-end |

---

## 3. Example

The same three operations, expressed three ways. **All code below is illustrative.** Only the REST responses exist in this repo.

### The REST way (adapted from the real chapters)

Three resources, three representations. The commands are copied from the transcripts named in each comment; the response bodies are abridged there because this chapter's point is the shape, not the output. No request was executed again for this chapter.

```console
# transcripts/22-consistency-and-review.txt
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/products/prd_tee -H 'Authorization: Bearer tok_acme_admin'
# → {"id":"prd_tee","sku":"TEE-001","slug":"classic-tee",...,"priceCents":1999,"currency":"USD",...}

# transcripts/22-consistency-and-review.txt
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/customers\?limit=2\&sort=name\&includeTotal=true -H 'Authorization: Bearer tok_acme_admin'
# → {"data":[...],"pagination":{...,"total":30}}

# transcripts/25b-pattern-order-idempotency.txt
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/orders/ord_53746936-286d-41de-affc-1edaaed6e303 -H 'Authorization: Bearer tok_acme_admin'
# → {"id":"ord_53746936-...","items":[...],"subtotalCents":4597,"totalCents":4597,...}
```

Each response is cacheable, retryable with the semantics from chapters 2–3, and described in the document from chapter 21.

### The GraphQL shape

```graphql
# Sketch only — no GraphQL server exists in this project
query OrderPage($tenantId: ID!, $orderId: ID!) {
  tenant(id: $tenantId) {
    order(id: $orderId) {
      id
      status
      totalCents
      customer { id name email }
      items { sku name quantity lineTotalCents }
    }
  }
}
```

The client asks for exactly those fields in one round trip. On the server, `tenant` resolves the tenant, `order` resolves from the order store, `customer` and `items` resolve per field. A naive resolver that queries the database per order item is the classic **N+1** problem — the fix is a batching layer (DataLoader) that collects IDs within a tick and issues one query.

What GraphQL would change in *this* project:

- **Tenant scoping moves into resolvers.** Today `tenantScope` checks path vs token once per request (chapter 17). In GraphQL there is no path; the tenant must come from the auth context, and every resolver must read it from context — a much larger surface for the mistake in chapter 22's mistake #5.
- **Status codes disappear.** A GraphQL response is `200` with an `errors[]` array for partial failures. Idempotency-key conflicts (`409` in chapter 12) become error payloads that a client must inspect; HTTP-level tooling (retries by status, `Retry-After`, 429 handling from chapter 16) stops applying directly.
- **Rate limiting becomes query-cost limiting.** `limit` per window (chapter 16) is easy; a single query that fans out to 10,000 rows is not. You need depth limits, complexity scoring, and pagination enforced by the schema.
- **HTTP caching of individual resources is lost.** `ETag`/`If-None-Match` on `GET /products/{id}` (chapter 15) does not map onto `POST /graphql`. You get a client-side normalized cache instead, and would need persisted queries plus a CDN keyed by query hash to approximate the HTTP version.

### The tRPC shape

```ts
// Sketch only — no tRPC server exists in this project
export const appRouter = router({
  products: router({
    byId: procedure
      .input(z.object({ id: z.string() }))
      .query(({ ctx, input }) => store.findProduct(ctx.tenantId, input.id)),
  }),
});

// client (same monorepo, type imported from server)
const product = await trpc.products.byId.query({ id: 'prd_tee' });
```

The appeal is real: the Zod schema is already the input validator (chapter 9), the generated client type is derived from it, and there is no OpenAPI document to keep in sync. The costs are equally real:

- **No non-TypeScript consumer.** A mobile app in Swift, a partner in Java, or a `curl` example cannot call it without a translation layer.
- **No HTTP semantics to lean on.** No `201` + `Location` (chapter 3), no `If-Match` (13c), no `304` (15). These become procedure conventions that every team re-invents.
- **Coupling.** Any breaking change is a simultaneous deploy of server and every client. That is fine for one product team, fatal for a partner ecosystem.

---

## 4. Bad vs good

**Bad:** choosing GraphQL because "one endpoint is simpler" for a public commerce API.

```graphql
# Bad: a public API with no HTTP contract
POST /graphql
# 200 {"errors":[{"message":"Insufficient stock", "path":["createOrder"]}]}
```

A partner integrating from Java now needs a GraphQL client, cannot see `409` vs `422` in their HTTP logs, cannot use a CDN for product reads, and cannot use the `Idempotency-Key` conventions their HTTP stack already understands. "Simpler" was true only for the team that wrote the query.

**Good:** choose the interface per audience.

| Audience | Interface |
| --- | --- |
| Partner integrations, any language | REST + OpenAPI (chapters 1–22) |
| First-party web/mobile app with deep screens | GraphQL gateway *in front of* the REST API, or tRPC inside the monorepo |
| Internal admin tooling written by the same team | tRPC or plain REST — whichever the team already operates |
| Machine-to-machine events | Webhooks (chapter 20) |

**Also bad:** a GraphQL gateway that re-implements business rules instead of calling the REST API. Then stock checks, idempotency, and coupon rules exist twice and disagree.

**Also good:** the gateway does auth, tenant context, cost limits, and field mapping, and calls the same REST endpoints (or the same services) — so one implementation of the rules from chapters 12, 13b, and 25e remains authoritative.

**Also bad:** adopting GraphQL for a mobile app and discovering that every screen fetch is now uncacheable at the HTTP layer while the client cache thrashes. Measure before migrating: normalize by ID, set `fetchPolicy`, and use persisted queries before blaming the transport.

---

## 5. In a real multi-tenant e-commerce platform

A realistic split after this course:

- **Public API:** REST `/v1/tenants/{tenantId}/...` with OpenAPI, versioning, caching, and signed webhooks. This is what partners see, what the docs site documents, and what the SDKs are generated from.
- **Storefront app:** may add a GraphQL or tRPC BFF (backend-for-frontend) that calls the public REST API server-side. The BFF owns the screen-shaped queries; the public API owns the contract, tenancy, and business rules.
- **Fraud console:** almost always plain REST with the ban/unban endpoints from chapters 17/25d; the screens are simple and the audit trail matters more than query flexibility.

The multi-tenant decision is the important one. In REST, the tenant is a path segment verified against the token — one check, one place (chapter 17). In GraphQL, the tenant lives in the context and every resolver must honor it; in tRPC, in `ctx.tenantId` with the same obligation. Neither architecture removes the requirement, and both make it easier to forget in a new resolver than in a route that visibly contains `{tenantId}`. Whichever you choose, the tenant-scope test from chapter 17 ("a token for tenant A cannot read tenant B") must exist for every new field, not just every new route.

---

## 6. When to use it and when NOT

**Choose REST (this course's default) when:**

- Consumers are external, multiple languages, or unknown.
- You need HTTP caching, status-code-based retries, and CDN behavior.
- The domain is naturally resource-shaped: products, customers, orders.
- You want a durable contract that outlives a front-end rewrite.

**Choose GraphQL when:**

- One client needs deeply nested, varied selections and over-fetching is a measured problem.
- You have (or will build) the operational pieces: persisted queries, depth/cost limits, DataLoader-style batching, and an authorization story per field.
- Multiple front-ends want one schema with different selections.
- You can accept that HTTP status codes and per-resource caching are no longer your contract.

**Choose tRPC when:**

- Server and client are TypeScript in one repo (or one published types package).
- Consumers are internal and redeploy together.
- You want maximum type safety with minimum ceremony.
- You do **not** need a public, language-agnostic contract.

**Do not:**

- Migrate to GraphQL to fix N+1 — fix the N+1 (chapter 24 shows the pattern).
- Use tRPC for a partner API.
- Run REST, GraphQL, and tRPC against three separate implementations of order creation.
- Assume GraphQL removes versioning. Additive schema changes are easier, but removing a field is still breaking; `@deprecated` plus a migration window is the equivalent of chapter 14.

---

## 7. Common mistakes

1. **"GraphQL solves over-fetching, so it is faster."** It solves over-fetching for one client at the cost of server-side complexity; a REST endpoint with a `fields=` parameter (chapter 5b) solves the common case with none of it.
2. **Ignoring the N+1 under resolvers.** One query per item looks fine in development with three rows and melts at 300. Batch, and measure.
3. **No query cost limits.** A GraphQL endpoint without depth or complexity limits is a denial-of-service surface; chapter 16's per-tenant bucket counts requests, not work.
4. **Losing idempotency.** GraphQL mutations need the same `Idempotency-Key` discipline as chapter 12, carried in variables or headers; otherwise retries double-charge.
5. **Auth per field forgotten.** REST checks a route; GraphQL must check every field that can reach another tenant's data, including nested ones. Centralize it in the context and forbid resolvers from querying without a tenant.
6. **tRPC for external consumers.** It works until the first non-TypeScript client, then you build an HTTP layer anyway — usually worse than the one you would have designed first.
7. **Three sources of truth.** A GraphQL schema, an OpenAPI document, and tRPC types that disagree. Pick one authoritative service layer and generate or wrap the others.
8. **Assuming introspection is harmless.** Public GraphQL introspection exposes the whole schema, including fields you meant to keep internal. Disable or restrict it in production if that matters.
9. **Forgetting uploads and webhooks.** Multipart (chapter 19) and outbound webhooks (chapter 20) are HTTP-native; GraphQL needs a separate upload spec and webhooks stay REST regardless.
10. **Rewriting a working API for fashion.** A migration has a cost measured in partner integrations and support tickets; require a measured problem before paying it.

---

## 8. Try it yourself

Write a two-page decision record for this commerce platform, choosing the interface for **three** consumers:

1. A partner warehouse system that pushes stock updates and reads orders (Java, nightly batches).
2. Your own React storefront that renders product lists, product pages, and checkout in one session.
3. A fraud analyst console used by five internal people.

For each: name the interface (REST, GraphQL gateway, tRPC), the contract artifact (OpenAPI, SDL, TS types), how tenant scoping is enforced, and one thing you give up. End with a sentence on whether a second interface is worth operating.

**Hint:** the warehouse is the easy one — it needs a stable, language-agnostic contract, idempotent writes, and webhooks for order events, which is exactly chapters 12, 14, 20, and 21. For the storefront, ask whether the screens truly need query-shaped fetching or whether two or three REST calls with `fields=` and a client cache would do; a BFF can be added later without changing the public contract. For the console, the ban/unban endpoints already exist, and the audit trail matters more than flexibility — REST wins on operational simplicity. The "thing you give up" column is where the honest reasoning lives.

---

## 9. Next

Chapter 24 collects the mistakes this API was built to avoid — and reproduces several of them live on a deliberately bad server, so you can see the failure modes instead of only reading about them.

Next: [24. Common mistakes](24-common-mistakes.md)
