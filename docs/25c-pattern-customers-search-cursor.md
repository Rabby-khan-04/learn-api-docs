# 25c. Pattern: customers list with search, filters, and cursor pagination

> **Run order:** Prisma server, port 4010, auth on.
>
> Every request below is copied from `transcripts/25c-pattern-customers-search-cursor.txt`, captured with `curl` on 2026-10-29. The first request is setup: it bans a customer so the `status=BANNED` filter has something to find.

---

## 1. Simple explanation (like I'm 7)

You have a box of 30 customer cards. Someone asks: "show me cards with *judy* on them, only the ones marked as bad customers." You find one card and hand it over.

Then they say: "show me five cards at a time, starting where we stopped last time." You do not start from card one; you remember **the last card you gave them** and continue after it. If someone slips a new card into the box while they are reading, they still get every card exactly once.

That "remember the last card" is a **cursor**. Offset is "skip 10 cards" — which breaks when cards are added or removed. A cursor is a bookmark, and a bookmark does not care what happened before it.

---

## 2. Real name

This endpoint combines three list features on one resource:

| Feature | Parameter | Implementation |
| --- | --- | --- |
| **Search** | `q` | case-insensitive `contains` on `name` and `email` |
| **Filter** | `status=ACTIVE\|BANNED` | `bannedAt IS NULL` / `bannedAt IS NOT NULL` |
| **Sort** | `sort=createdAt\|-createdAt\|name\|-name` | allowlist, default `-createdAt` |
| **Pagination** | `limit` + `cursor` *or* `offset` | keyset by `(createdAt, id)` for cursor; `skip` for offset |
| **Total** | `includeTotal=true` | extra `COUNT`, offset mode only |

The rules that make it correct:

1. **One default sort for cursors: `-createdAt`.** A cursor encodes `(createdAt, id)`; it only makes sense with that ordering. Asking for `sort=name` *and* a cursor is rejected (`422 invalid_pagination`) instead of silently returning the wrong page.
2. **The cursor is opaque and positional.** It is base64url of `{"createdAt": "...", "id": "..."}`; clients must not construct or parse it.
3. **A cursor is not a capability.** Chapter 17's tenant check still applies, and the tenant filter is still in the query. A cursor from another tenant selects a position, not access.
4. **`limit + 1` rows are fetched** to compute `hasMore` without a second query. `total` is opt-in and only in offset mode, because counting on every page is expensive (chapter 6a).
5. **`status` is derived, not stored**: the customer DTO's `status` comes from `bannedAt` (chapter 10), but the filter runs on `bannedAt` because that is what is indexed.

---

## 3. Example

### The query contract

```ts
// src/schemas/customer.ts (excerpt)
export const customerListQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    status: z.enum(['ACTIVE', 'BANNED']).optional(),
    sort: z.enum(['createdAt', '-createdAt', 'name', '-name']).default('-createdAt'),
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

Every parameter is bounded and closed. `sort` is an enum, not a free string, so nothing can be pushed into `ORDER BY`. `.strict()` rejects `sort_by`, `pageSize`, or any other guessed parameter instead of ignoring it — a client that sends the wrong name gets an error, not silently unsorted data.

### Search and filter become one WHERE

```ts
// src/store/prisma.ts (excerpt)
private customerWhere(tenantId: string, options: CustomerListOptions): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = { tenantId };
  if (options.status === 'ACTIVE') where.bannedAt = null;
  if (options.status === 'BANNED') where.bannedAt = { not: null };
  if (options.q) {
    where.OR = [
      { name: { contains: options.q, mode: 'insensitive' } },
      { email: { contains: options.q, mode: 'insensitive' } },
    ];
  }
  return where;
}
```

`tenantId` is unconditional and first. Search and status are ANDed with it, so a banned customer in another tenant is never in scope no matter how the query is written.

### Cursor: keyset, not offset

```ts
// src/store/prisma.ts (excerpt)
if (options.cursor) {
  const cursor = decodeCursor(options.cursor);
  const at = new Date(cursor.createdAt);
  where.AND = [
    {
      OR: [
        { createdAt: { lt: at } },
        { createdAt: at, id: { lt: cursor.id } },
      ],
    },
  ];
}
```

The predicate is "strictly after the last row in the current sort order". The `id` tie-breaker is essential: two customers created in the same millisecond would otherwise be skipped or repeated at the page boundary. `decodeCursor` validates the shape with Zod and throws `422 invalid_cursor` on anything else, so a tampered cursor cannot reach SQL as a date.

The rows and page metadata:

```ts
// src/store/prisma.ts (excerpt)
const [rows, total] = await Promise.all([
  this.prisma.customer.findMany({
    where,
    orderBy,
    ...(options.offset ? { skip: options.offset } : {}),
    take: options.limit + 1,
  }),
  options.includeTotal ? this.prisma.customer.count({ where: baseWhere }) : Promise.resolve(undefined),
]);

const hasMore = rows.length > options.limit;
const items = (hasMore ? rows.slice(0, options.limit) : rows).map(toCustomer);
const last = items.at(-1);
return {
  items,
  hasMore,
  nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  ...(total !== undefined ? { total } : {}),
};
```

Note `count({ where: baseWhere })`: the total ignores the cursor, so page 3 reports the same total as page 1. And `nextCursor` is `null` on the last page — clients stop when it is null, not when `data.length < limit` (which is also true on the last page, but null is the explicit signal).

### Mixed pagination modes are rejected before the query

```ts
// src/routes/helpers.ts (excerpt)
export function assertPaginationMode(query: { cursor?: string; offset?: number; includeTotal: boolean; sort?: string }): void {
  if (query.cursor && query.offset !== undefined) {
    throw new HttpProblem(422, 'invalid_pagination', 'Use either cursor or offset, not both.', { ... });
  }
  if (query.cursor && query.includeTotal) {
    throw new HttpProblem(422, 'invalid_pagination', 'Total counts are only available with offset pagination.', { ... });
  }
  if (query.cursor && query.sort && query.sort !== '-createdAt') {
    throw new HttpProblem(422, 'invalid_pagination', 'Cursor pagination only supports sort=-createdAt.', { ... });
  }
}
```

Each rejection names the offending parameter in `errors[].pointer`, so a client can show "cursor cannot be combined with offset" without string-matching the `detail`.

### The requests (actual)

Setup — ban one customer:

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/customers/cus_acme_10/ban -H 'Authorization: Bearer tok_acme_admin' -H 'Content-Type: application/json' --data-binary '{ "reason": "Fraud ring investigation" }'
```

```http
HTTP/1.1 200 OK
X-Request-Id: a61b2e22-5945-43f3-93df-1f980d93ff4c
Content-Type: application/json; charset=utf-8
Content-Length: 287
Date: Thu, 29 Oct 2026 12:30:04 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"customer":{"id":"cus_acme_10","email":"judy.chen.10@example.com","name":"Judy Chen","status":"BANNED","bannedAt":"2026-10-29T12:30:04.902Z","banReason":"Fraud ring investigation","version":2,"createdAt":"2026-01-10T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.903Z"},"changed":true}
```

Search + filter together:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/customers\?q=judy\&status=BANNED -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 2d99ecf2-a66b-4315-9fc6-3f754e1eab5e
Content-Type: application/json; charset=utf-8
Content-Length: 330
Date: Thu, 29 Oct 2026 12:30:04 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"cus_acme_10","email":"judy.chen.10@example.com","name":"Judy Chen","status":"BANNED","bannedAt":"2026-10-29T12:30:04.902Z","banReason":"Fraud ring investigation","version":2,"createdAt":"2026-01-10T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.903Z"}],"pagination":{"limit":20,"hasMore":false,"nextCursor":null}}
```

The single match carries the same DTO as a direct `GET /customers/{id}`. `hasMore: false` and `nextCursor: null` make the end of the result explicit.

A page with a custom sort:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/customers\?limit=5\&sort=name -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 200 OK
X-Request-Id: b4348f00-39ba-482c-84fe-8243807a9b44
Content-Type: application/json; charset=utf-8
Content-Length: 1238
Date: Thu, 29 Oct 2026 12:30:04 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"cus_acme_27","email":"alice.cooper.27@example.com","name":"Alice Cooper","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-27T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"},{"id":"cus_acme_01","email":"alice.johnson.1@example.com","name":"Alice Johnson","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"},{"id":"cus_acme_28","email":"bob.dylan.28@example.com","name":"Bob Dylan","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-28T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"},{"id":"cus_acme_02","email":"bob.smith.2@example.com","name":"Bob Smith","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-02T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"},{"id":"cus_acme_03","email":"carol.diaz.3@example.com","name":"Carol Diaz","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-03T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"}],"pagination":{"limit":5,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAzVDA5OjAwOjAwLjAwMFoiLCJpZCI6ImN1c19hY21lXzAzIn0"}}
```

Sorted by name; `nextCursor` points at the last row (`cus_acme_03`). But that cursor was built for `createdAt` ordering — using it with `sort=name` would be meaningless, so:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/customers\?limit=5\&sort=name\&cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAzVDA5OjAwOjAwLjAwMFoiLCJpZCI6ImN1c19hY21lXzAzIn0 -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: b5247d70-4f66-4494-bbab-a0292b2b0aad
Content-Type: application/problem+json; charset=utf-8
Content-Length: 458
Date: Thu, 29 Oct 2026 12:30:04 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_pagination","title":"Validation Failed","status":422,"detail":"Cursor pagination only supports sort=-createdAt.","instance":"/v1/tenants/ten_acme/customers?limit=5&sort=name&cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAzVDA5OjAwOjAwLjAwMFoiLCJpZCI6ImN1c19hY21lXzAzIn0","code":"invalid_pagination","errors":[{"pointer":"/sort","code":"unsupported_with_cursor","message":"Use offset pagination for custom sorts."}]}
```

This is a deliberate rejection. Returning page 2 of the name-sorted list using a createdAt cursor would produce rows that *look* plausible and are wrong — the worst kind of bug. The message tells the client what to do instead.

Offset mode with a total:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/customers\?limit=5\&offset=0\&includeTotal=true -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 200 OK
X-Request-Id: c81d1336-e9c6-4cc0-9b11-6b40ed7fbd5e
Content-Type: application/json; charset=utf-8
Content-Length: 1257
Date: Thu, 29 Oct 2026 12:30:04 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"cus_acme_30","email":"diana.ross.30@example.com","name":"Diana Ross","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-30T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"},{"id":"cus_acme_29","email":"carol.king.29@example.com","name":"Carol King","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-29T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"},{"id":"cus_acme_28","email":"bob.dylan.28@example.com","name":"Bob Dylan","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-28T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"},{"id":"cus_acme_27","email":"alice.cooper.27@example.com","name":"Alice Cooper","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-27T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"},{"id":"cus_acme_26","email":"zane.grey.26@example.com","name":"Zane Grey","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-26T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"}],"pagination":{"limit":5,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTI2VDA5OjAwOjAwLjAwMFoiLCJpZCI6ImN1c19hY21lXzI2In0","offset":0,"total":30}}
```

Default sort (`-createdAt`) puts the newest first, `total: 30` appears because it was requested, and `nextCursor` is still present — a client may switch modes later, but not combine them in one request.

Tenant isolation on the list:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_globex/customers\?limit=2 -H 'Authorization: Bearer tok_globex_admin'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 102499e4-3753-4c49-8f7d-c47dbe86804f
Content-Type: application/json; charset=utf-8
Content-Length: 584
Date: Thu, 29 Oct 2026 12:30:04 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"cus_globex_03","email":"carol.diaz.3@example.com","name":"Carol Diaz","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-03T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"},{"id":"cus_globex_02","email":"bob.smith.2@example.com","name":"Bob Smith","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-02T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"}],"pagination":{"limit":2,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAyVDA5OjAwOjAwLjAwMFoiLCJpZCI6ImN1c19nbG9iZXhfMDIifQ"}}
```

Only `cus_globex_*` rows, even though the emails collide with Acme's customers (`carol.diaz.3@example.com` exists in both tenants). This is why `email` is unique per tenant, not globally (chapter 11).

An Acme cursor used on Globex:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_globex/customers\?limit=2\&cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAzVDA5OjAwOjAwLjAwMFoiLCJpZCI6ImN1c19hY21lXzAzIn0 -H 'Authorization: Bearer tok_globex_admin'
```

```http
HTTP/1.1 200 OK
X-Request-Id: 8b75a5f9-3ab6-4e7a-b632-7d92e83bf40f
Content-Type: application/json; charset=utf-8
Content-Length: 511
Date: Thu, 29 Oct 2026 12:30:04 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"cus_globex_02","email":"bob.smith.2@example.com","name":"Bob Smith","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-02T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"},{"id":"cus_globex_01","email":"alice.johnson.1@example.com","name":"Alice Johnson","status":"ACTIVE","bannedAt":null,"banReason":null,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:30:04.741Z"}],"pagination":{"limit":2,"hasMore":false,"nextCursor":null}}
```

`200`, with Globex rows only. Nothing leaks — the tenant filter applies first, and the cursor merely selects a position by `(createdAt, id)` inside Globex's data. The request "worked" because the cursor is a position, not a key into a specific tenant's rows.

Do not over-read this: it is *not* permission to accept cursors across tenants. It shows that the cursor carries no authority; the token plus the tenant filter do. A client that accidentally mixes tenants gets a confusing page rather than a breach, which is the right failure mode.

A malformed cursor:

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/customers\?cursor=abc -H 'Authorization: Bearer tok_acme_admin'
```

```http
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 69afc4b3-a856-4183-9e04-639928bb7a61
Content-Type: application/problem+json; charset=utf-8
Content-Length: 345
Date: Thu, 29 Oct 2026 12:30:04 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_cursor","title":"Validation Failed","status":422,"detail":"The cursor is malformed. Use nextCursor from the previous page.","instance":"/v1/tenants/ten_acme/customers?cursor=abc","code":"invalid_cursor","errors":[{"pointer":"/cursor","code":"invalid_cursor","message":"Cursor is not valid."}]}
```

The message tells the client exactly what to do: use `nextCursor` from the previous page, do not build cursors by hand.

---

## 4. Bad vs good

**Bad:** page numbers over a changing list.

```ts
// Bad: skips and duplicates rows while customers are inserted
const rows = await prisma.customer.findMany({ skip: page * 20, take: 20, orderBy: { createdAt: 'desc' } });
```

A new customer arrives between page 1 and page 2: everything shifts by one, one row is shown twice, and one is never shown. Under concurrent writes (every live store), this is the normal case, not the edge case.

**Good:** a keyset cursor.

```ts
// Good
where.AND = [{ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] }];
take: options.limit + 1
```

No `skip`, no dependence on how many rows exist before the bookmark.

**Bad:** a free-form `sort` passed to `orderBy`.

```ts
// Bad: injection surface and unstable pages
orderBy: { [req.query.sort]: req.query.dir }
```

At best it errors on an unknown column; at worst it orders by a private column you did not intend to expose, and ties make pagination non-deterministic.

**Good:** an allowlist plus a tie-breaker.

```ts
// Good: sort is a Zod enum; every ordering ends with id
orderBy: field === 'name' ? [{ name: direction }, { id: direction }] : [{ createdAt: direction }, { id: direction }]
```

**Bad:** a cursor combined with an incompatible sort "just works".

```ts
// Bad: returns plausible but wrong rows
GET /customers?sort=name&cursor=<createdAt-cursor>
```

**Good:** reject with a named parameter and a suggested alternative (`422 invalid_pagination`, pointer `/sort`).

**Bad:** `total` on every request. A `COUNT` over a search-heavy filter at 30 rows is nothing; at 30 million it is a second full scan on every page load. **Good:** `includeTotal=true` opt-in, offset mode only.

---

## 5. In a real multi-tenant e-commerce platform

Support opens the customer list and types "judy". The first page arrives in one query. They page forward five customers at a time while the fraud team bans customers in another tab. Because the cursor is a bookmark, support never sees the same customer twice and never skips one — even though `bannedAt` changed on rows behind them.

With `status=BANNED`, the filter is `bannedAt IS NOT NULL`; the list is the fraud team's working set. Combining `q` with `status` is how they find "this banned customer I remember by name" without exporting anything.

Globex's support agent does the same against `ten_globex` and sees only Globex customers, even though some emails are identical to Acme's. The tenant filter is in the query, so the shared email does not become a shared customer.

The index that makes this fast is `(tenant_id, banned_at)` plus the `created_at, id` ordering used by the cursor; chapter 6b covers the keyset indexes, chapter 11 the schema. Without those indexes, the pattern is correct and slow.

---

## 6. When to use it and when NOT

**Use cursor pagination when:**

- The list is long, changes while it is being read, or is paged by a machine (sync jobs, exports, infinite scroll).
- The default ordering is stable and indexed (`-createdAt` here).
- You can live without "jump to page 7".

**Use offset + total when:**

- Humans need page numbers and a total ("1–20 of 340").
- The dataset is small or the query is already aggregated for admin reporting.
- Random access matters more than stability.

**Do not:**

- **Offer both modes simultaneously on one request.** The transcript's `422` is the rule.
- **Use a cursor with an arbitrary sort** unless the cursor encodes the sort key(s) it was built for. This chapter's cursor encodes `(createdAt, id)` and refuses other sorts.
- **Treat a cursor as authorization.** The tenant comes from the token; the cursor is a hint about position.
- **Expose the cursor payload to users as data.** It is opaque; changing its internal encoding must not break clients.
- **Count on every page by default.** Make it opt-in, and consider caching the total if dashboards need it constantly.

---

## 7. Common mistakes

1. **Cursor without a tie-breaker.** `createdAt` alone skips or duplicates rows created in the same millisecond; always add `id`.
2. **Cursor predicate with `lte` instead of `lt`,** or `gt` against a `-createdAt` sort. The page repeats its first row or starts after the second. Test the boundary explicitly.
3. **`skip` + `cursor` together.** Produces a page that starts in the wrong place; reject it.
4. **Sorting by an unindexed column with a cursor.** Correct results, terrible latency; the cursor fix does nothing for performance by itself.
5. **Building the cursor from user input** instead of `nextCursor`. A crafted cursor is an injection or an oracle; validate the decoded shape (chapter 6b).
6. **Returning the raw cursor payload** (`{"createdAt":...,"id":...}`) as if it were API data. Clients start depending on it, and you can never change the encoding.
7. **`total` computed after the cursor filter**, so page 2 reports fewer rows than page 1.
8. **`hasMore` computed by `rows.length === limit`.** It is wrong on an exactly-full last page; fetch `limit + 1`.
9. **Search with `%` or `_` unescaped** (in raw SQL) or with a leading-wildcard `LIKE` on a huge table. Prisma's `contains` is safe here; raw SQL is not automatically safe.
10. **Tenant filter added after pagination.** The page is cut from all tenants, then filtered, and comes back short — or contains foreign rows if the filter is only applied to the response.

---

## 8. Try it yourself

Add `sort=email` and `sort=-email` **with cursor support**, without breaking the existing `-createdAt` cursor.

Requirements:

1. The cursor must carry which sort it belongs to, and a cursor presented with a different sort must be rejected with `422 invalid_pagination` and a pointer at `/sort`.
2. The keyset predicate must use `(email, id)` for email sorts and `(createdAt, id)` for the default, with the correct comparison direction.
3. `nextCursor` must encode the value of the sort key from the last row, plus `id`.
4. The existing request with `sort=name` + cursor must still fail; `sort=email` + cursor must now succeed and page without duplicates.

**Hint:** extend the cursor payload to `{ sort, createdAt?, email?, id }` and validate the whole object with Zod in `decodeCursor`. For ascending email, the predicate is `email > last.email OR (email = last.email AND id > last.id)`; for descending, flip both comparisons. Keep `take: limit + 1` and `nextCursor: null` on the last page. The subtle part is that `sort=name` (a display name) is *not* the same as `email`; decide whether to support it the same way or keep rejecting it, and write down the reason — that decision is the exercise.

---

## 9. Next

Bans are state transitions with an audit trail, and they must be safe to repeat. The next pattern takes the same idempotent-action thinking from 25b and applies it to fraud enforcement.

Next: [25d. Pattern: fraud ban/unban](25d-pattern-fraud-ban-unban.md)
