# 07. JSON conventions

> **Run order:** in-memory server, port 4011, auth off.
>
> Every request below is copied from `transcripts/07-json-conventions.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

Imagine every shop writes price tags in its own way:

- one writes `19.99`, another writes `"$19.99"`, another writes `1999` with a tiny note "in cents".
- one writes dates as `01/02/03`, another as `Tuesday`, another as `2026-01-01T09:00:00Z`.
- one calls the product name `name`, another `title`, another `product_name`.

If you buy from ten shops, you need ten translators.

JSON conventions are the agreement: **everyone writes the same kind of tag the same way.** Then one translator works everywhere. This chapter chooses the agreement for this API.

---

## 2. Real name

JSON (RFC 8259) defines the data format, not the meaning. API conventions fill the gap. The rules this course uses:

| Concern | Convention | Example |
|---|---|---|
| Field names | `camelCase` | `priceCents`, `createdAt` |
| Resource casing | plural lowercase path segments, kebab-case for multiword | `/webhook-endpoints` |
| Envelope | Collections: `{ data, pagination }`; single resources: bare object | `{ "data": [...], "pagination": {...} }` |
| IDs | Opaque prefixed strings | `"prd_85758322-d2d1-44b7-9239-05629cd6a4d1"` |
| Money | Integer **minor units** + ISO 4217 currency | `"priceCents": 2499, "currency": "USD"` |
| Time | ISO 8601 / RFC 3339 UTC string | `"2026-10-29T12:26:53.755Z"` |
| Durations | Not needed here; if added, integer seconds or ISO 8601 duration | — |
| Booleans | Real JSON `true`/`false`, never `"true"` | `"active": true` |
| Enums | Uppercase strings for state | `"status": "ACTIVE"` |
| Null vs absent | Null means "known to be empty"; absent means "not part of this representation" | `"description": null` |
| Extra fields | Clients must ignore unknown fields | forward compatibility |
| Content type | `application/json; charset=utf-8` | UTF-8 is the JSON default |

Three of these deserve detail.

**Money is never a float.** JSON numbers are IEEE-754 doubles. `0.1 + 0.2` is not `0.3`, and `19.99 * 3` can produce `59.97000000000001`. Money must be integer minor units (`priceCents`, `amountCents`) plus a currency code. The client formats for display; the API does exact integer arithmetic. If you ever need sub-cent precision (tax, FX), use a documented scale (for example, integer micro-units) rather than switching to floats.

**Time is a string, not a number.** JSON has no date type. Unix epoch integers are compact but opaque in logs and lose timezone context. ISO 8601 UTC (`...Z`) is human-readable, sortable lexicographically at the same precision, and unambiguous. Always UTC; convert in the client's UI, not in storage or transport.

**Null vs absent.** Both are legal JSON, and they mean different things:

- `"description": null` — the product has no description, and this representation includes the field.
- No `description` key — this representation does not carry the field (for example, a sparse fieldset, chapter 05b).

Do not use `null` to mean "unchanged" or "not loaded". That ambiguity is how PATCH bugs are born (chapter 13a).

---

## 3. Example

The DTO is the single place where records become JSON:

```ts
// src/store/types.ts (excerpt, comments added)
export function productDto(record: ProductRecord) {
  return {
    id: record.id,                 // opaque string, stable
    sku: record.sku,
    slug: record.slug,
    name: record.name,
    description: record.description, // null means "no description", not "not loaded"
    priceCents: record.priceCents,   // integer minor units
    currency: record.currency,       // ISO 4217, uppercase
    stock: record.stock,
    active: record.active,           // real boolean
    version: record.version,         // optimistic concurrency, chapter 13c
    createdAt: iso(record.createdAt),// ISO 8601 UTC string
    updatedAt: iso(record.updatedAt),
  };
}
```

```ts
// src/lib/ids.ts (excerpt, comments added)
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
```

### A canonical product

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products/prd_tee
HTTP/1.1 200 OK
X-Request-Id: 01e38d80-620f-4bd3-89c5-d1576eb8f7e4
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:26:53 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}
```

Read it as a contract:

- `priceCents` is `1999`, not `"$19.99"` and not `19.99`.
- `currency` is `"USD"`, so `1999` is 19.99 US dollars, not 1999 yen.
- `createdAt` ends in `Z` and has milliseconds. `2026-01-01T09:00:00Z` and `2026-01-01T09:00:00.000Z` are the same instant; this API always emits milliseconds for shape stability.
- `active` is a boolean; a client can use it in a conditional without parsing.
- `id` has a type prefix; a human reading a log knows it is a product, and a router can validate the shape before querying.

### Create — defaults become explicit in the response

```console
$ curl -sS -i --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Content-Type: application/json' --data-binary '{
  "sku": "BTL-001",
  "slug": "water-bottle",
  "name": "Water Bottle",
  "priceCents": 2499,
  "currency": "USD",
  "stock": 25,
  "active": true
}'
HTTP/1.1 201 Created
X-Request-Id: cfa04756-9505-4c7b-a1e8-65a9b9088272
Location: /api/tenants/ten_acme/products/prd_85758322-d2d1-44b7-9239-05629cd6a4d1
Content-Type: application/json; charset=utf-8
Content-Length: 278
Date: Thu, 29 Oct 2026 12:26:53 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_85758322-d2d1-44b7-9239-05629cd6a4d1","sku":"BTL-001","slug":"water-bottle","name":"Water Bottle","description":null,"priceCents":2499,"currency":"USD","stock":25,"active":true,"version":1,"createdAt":"2026-10-29T12:26:53.755Z","updatedAt":"2026-10-29T12:26:53.755Z"}
```

The request omitted `description`; the schema defaulted it to `null`, and the response shows it. Clients never have to guess whether an absent write field means "unset" or "unchanged" on create.

### A customer uses the same conventions

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/customers/cus_acme_01
HTTP/1.1 200 OK
X-Request-Id: 032e2f0d-cd53-4e1e-af43-ade0eb1eba27
Content-Type: application/json; charset=utf-8
Content-Length: 222
Date: Thu, 29 Oct 2026 12:26:53 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"cus_acme_01","email":"alice.johnson.1@example.com","name":"Alice Johnson","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}
```

`status` is derived (`bannedAt ? 'BANNED' : 'ACTIVE'`), and both `bannedAt` and `banReason` are `null` for an active customer. The client can branch on `status` without inferring it from timestamps.

### The collection envelope

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=1
HTTP/1.1 200 OK
X-Request-Id: 3026c8c2-f32c-4529-8671-f0413d799d76
Content-Type: application/json; charset=utf-8
Content-Length: 463
Date: Thu, 29 Oct 2026 12:26:53 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_85758322-d2d1-44b7-9239-05629cd6a4d1","sku":"BTL-001","slug":"water-bottle","name":"Water Bottle","description":null,"priceCents":2499,"currency":"USD","stock":25,"active":true,"version":1,"createdAt":"2026-10-29T12:26:53.755Z","updatedAt":"2026-10-29T12:26:53.755Z"}],"pagination":{"limit":1,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTEwLTI5VDEyOjI2OjUzLjc1NVoiLCJpZCI6InByZF84NTc1ODMyMi1kMmQxLTQ0YjctOTIzOS0wNTYyOWNkNmE0ZDEifQ"}}
```

A collection is never a bare array. The envelope leaves room for pagination today and facets/aggregations tomorrow without a breaking change.

Matching `.http` file: [`requests/07-json-conventions.http`](../requests/07-json-conventions.http). Full capture: [`transcripts/07-json-conventions.txt`](../transcripts/07-json-conventions.txt).

---

## 4. Bad vs good

**Bad — vendor-specific shapes**

```json
{
  "id": 42,
  "ProductName": "Tee",
  "price": "19.99 USD",
  "created": "01/02/2026 9:00 AM",
  "is_active": "true",
  "meta": { "internal_cost": 7.1, "tenant": 3 }
}
```

Problems:

- `id: 42` leaks volume and invites enumeration; `internal_cost` leaks margin.
- `Price` and `created` have no machine-readable type; every client writes a parser.
- `"19.99 USD"` cannot be summed or compared without splitting strings.
- Local time without an offset is ambiguous twice a year (DST) and wrong for remote clients.
- `"true"` as a string is truthy in JavaScript even when it means false; classic bug.
- Mixed casing (`ProductName`, `is_active`) makes generated clients ugly and field lookup error-prone.

**Good — one convention everywhere**

```json
{
  "id": "prd_85758322-d2d1-44b7-9239-05629cd6a4d1",
  "name": "Water Bottle",
  "priceCents": 2499,
  "currency": "USD",
  "active": true,
  "createdAt": "2026-10-29T12:26:53.755Z"
}
```

**Trade-offs:**

- **Integer minor units** are exact but require every client to divide by 100 (or by the currency's exponent; JPY has zero decimals, KWD has three). Document the exponent rule or expose a formatter endpoint. The alternative — decimal strings like `"19.99"` — is exact too but needs a decimal parser everywhere and is easy to accidentally turn into a float.
- **ISO strings** are verbose. Epoch millis are smaller, but logs and debugging suffer. Pick one and document it; this course picks ISO UTC.
- **camelCase** is idiomatic for JavaScript clients and TypeScript code, but Python and Go shops often prefer snake_case. Consistency matters more than the choice. The database uses snake_case (`price_cents`); the DTO translates at the boundary (chapter 10).

---

## 5. In a real multi-tenant e-commerce platform

A checkout service receives an order total as `totalCents: 5297` and `currency: "USD"`. It never does `5297 / 100` until it renders a receipt. Tax and discount calculations stay in integers, and rounding is explicit (chapter 25e: 10% of 4999 is 499.9, rounded to 500).

A dashboard shows `createdAt` in the viewer's timezone. The API sent UTC; the browser formats local. No server-side timezone bugs, no ambiguous "yesterday" at midnight.

A partner stores `id` as an opaque string. It never parses the UUID, never assumes monotonicity, and never builds a URL from an integer. When the platform needs to change ID generation, partners are unaffected — as long as the prefix and opacity contract holds.

When Acme and Globex both have a product with SKU `MUG-001`, the IDs differ (`prd_...` UUIDs) and the tenant segment disambiguates the URL. Human-readable uniqueness (SKU, slug) is scoped by tenant, not global (chapter 25a).

---

## 6. When to use it and when NOT to

**Use these conventions when:**

- Multiple clients and languages consume the API.
- Money, time, or identity cross a boundary.
- The API is long-lived and public.

**When to deviate:**

- **Internal RPC between services you own**, where all parties share types: tRPC or protobuf may avoid JSON conventions entirely (chapter 23).
- **Analytics/export endpoints**: CSV or NDJSON may be better than JSON; integers and ISO strings still apply (chapter 18 exports CSV with `priceCents`).
- **Very large numeric IDs from an external system** (snowflake IDs > 2^53): send them as strings even if they look numeric, to avoid JavaScript precision loss. Document it.
- **Currencies with unusual exponents**: do not assume 2 decimals. Store minor units and publish the exponent, or store decimal strings with an explicit scale.

**Do not deviate on a whim.** A single endpoint that returns snake_case or float prices forces every client to special-case it. Chapter 22 turns this into a consistency review rule.

---

## 7. Common mistakes

1. **Float money.** `19.99` looks fine until multiplication and summation. Use integer minor units.
2. **Money without currency.** `price: 1999` is meaningless across shops. Always pair the amount with an ISO 4217 code.
3. **Local-time timestamps or non-ISO formats.** Ambiguous, unsortable across formats, painful in logs.
4. **Integer IDs for public resources.** Enumeration, volume leaks, coupling to the database.
5. **`"true"` as a string.** JavaScript truthiness turns `"false"` into true.
6. **Bare arrays for collections.** No room for pagination or metadata without breaking clients.
7. **Using `null` for "unchanged" in PATCH.** Ambiguous semantics; chapter 13a shows the damage.
8. **Exposing database column names.** `price_cents`, `tenant_id`, `internal_cost`; use DTOs (chapter 10).
9. **Changing casing mid-course.** `createdAt` on products, `created_at` on orders; clients cannot share mappers.
10. **Assuming all currencies have 2 decimals.** JPY and KWD disagree; publish the exponent.

---

## 8. Try it yourself

**Exercise.** A teammate proposes this order JSON. List at least six convention violations and rewrite it:

```json
{
  "Order_ID": 1001,
  "customer": { "id": 7 },
  "Total": "52.97$",
  "created": "29/10/2026 12:27",
  "is_paid": "false",
  "items": [
    { "product_id": 3, "qty": 2, "unit_price": 19.99 }
  ]
}
```

**Hint.** Check the roadmap's convention table: IDs opaque strings, camelCase, integer minor units + currency, ISO 8601 UTC, booleans as booleans, items as DTOs with money in minor units, and no nested `customer.id` integer. Also consider whether the status should be a `PAID`/`PENDING` enum rather than a boolean; chapter 25b shows the status field. Rewrite the amount as `subtotalCents`, `discountCents`, `totalCents`, and `currency`, and keep item prices as `unitPriceCents`.

---

## 9. Next

[08a. Error design: RFC 9457 Problem Details →](08a-error-problem-details.md)
