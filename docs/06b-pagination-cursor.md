# 06b. Pagination: cursor

> **Run order:** in-memory server, port 4011, auth off.
>
> Every request below is copied from `transcripts/06b-pagination-cursor.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

Imagine you are reading a long list of names on a paper roll, and someone keeps sticking new names at the top.

If you remember "I stopped at line 4", the next time you look, line 4 is a different name. You might read the same name twice, or skip one.

Instead, you write down the **name you stopped at**, and say: "continue after *Maya*." Even if the roll changed, you continue from a real place, not from a count.

That bookmark is a **cursor**. It remembers where you were, not how many you counted.

---

## 2. Real name

**Cursor pagination** (also **keyset pagination**, **seek pagination**) encodes the position in the result set as an opaque token derived from the last row's sort key(s), rather than an integer offset.

```
GET /products?limit=2
  -> { data: [...], pagination: { nextCursor: "eyJjcmVhdGVkQXQiOi..." } }

GET /products?limit=2&cursor=eyJjcmVhdGVkQXQiOi...
  -> { data: [...], pagination: { nextCursor: null } }
```

This implementation's cursor is base64url of `{"createdAt": "...", "id": "..."}`:

```ts
// src/http/pagination.ts (excerpt)
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const result = z.object({ createdAt: z.iso.datetime(), id: z.string().min(1) })
      .strict().safeParse(parsed);
    if (!result.success) throw new Error('bad shape');
    return result.data;
  } catch {
    throw new HttpProblem(422, 'invalid_cursor', 'The cursor is malformed. Use nextCursor from the previous page.', { ... });
  }
}
```

Properties:

- **Opaque to clients.** They must treat it as a token. If you expose "sort key = 2026-01-01T11:00:00Z", clients will build cursors themselves and you can never change the encoding.
- **Total order required.** `createdAt` alone is not unique; the cursor carries `createdAt` **and** `id`, and the query uses `(createdAt, id) < (lastCreatedAt, lastId)` in the same order.
- **No page numbers, no cheap total.** You cannot "jump to page 7" and `COUNT(*)` is not implied.
- **Stable under inserts.** A row inserted at the top does not shift the pages you have not read yet.
- **Sort must be fixed.** This implementation only supports `sort=-createdAt` in cursor mode; a cursor built for one order cannot be replayed under another. The API rejects the combination explicitly.

"Cursor" here is *not* a database cursor (server-side iterator requiring a held connection). It is a client-held position token, which is stateless and fits the REST constraint from chapter 01.

---

## 3. Example

```ts
// src/store/memory.ts (excerpt, comments added)
if (options.cursor) {
  // Cursor mode is only supported for the default newest-first order.
  const cursor = decodeCursor(options.cursor);
  rows = rows.filter(
    (row) =>
      row.createdAt.toISOString() < cursor.createdAt ||
      (row.createdAt.toISOString() === cursor.createdAt && row.id < cursor.id),
  );
}
```

```ts
// src/routes/helpers.ts (excerpt)
if (query.cursor && query.offset !== undefined) {
  throw new HttpProblem(422, 'invalid_pagination', 'Use either cursor or offset, not both.', { ... });
}
if (query.cursor && query.includeTotal) {
  throw new HttpProblem(422, 'invalid_pagination', 'Total counts are only available with offset pagination.', { ... });
}
if (query.cursor && query.sort && query.sort !== '-createdAt') {
  throw new HttpProblem(422, 'invalid_pagination', 'Cursor pagination only supports sort=-createdAt.', { ... });
}
```

### First page

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=2
HTTP/1.1 200 OK
X-Request-Id: cbbbe0e2-caab-4289-b7ff-ab7c43a966ec
Content-Type: application/json; charset=utf-8
Content-Length: 668
Date: Thu, 29 Oct 2026 12:26:12 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_cap","sku":"CAP-001","slug":"running-cap","name":"Running Cap","description":"Lightweight cap.","priceCents":2499,"currency":"USD","stock":0,"active":false,"version":1,"createdAt":"2026-01-01T12:00:00.000Z","updatedAt":"2026-01-01T12:00:00.000Z"},{"id":"prd_hoodie","sku":"HOO-001","slug":"trail-hoodie","name":"Trail Hoodie","description":"Fleece-lined hoodie.","priceCents":4999,"currency":"USD","stock":8,"active":true,"version":1,"createdAt":"2026-01-01T11:00:00.000Z","updatedAt":"2026-01-01T11:00:00.000Z"}],"pagination":{"limit":2,"hasMore":true,"nextCursor":"eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDExOjAwOjAwLjAwMFoiLCJpZCI6InByZF9ob29kaWUifQ"}}
```

Decoded, the cursor is:

```json
{"createdAt":"2026-01-01T11:00:00.000Z","id":"prd_hoodie"}
```

It points at the last row of the page. Do not show this to clients as a documented format; show it only to explain the mechanism in this course.

### Second page

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=2\&cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDExOjAwOjAwLjAwMFoiLCJpZCI6InByZF9ob29kaWUifQ
HTTP/1.1 200 OK
X-Request-Id: 123d7bb9-01e2-42be-8cf8-e32a804a6627
Content-Type: application/json; charset=utf-8
Content-Length: 594
Date: Thu, 29 Oct 2026 12:26:12 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_mug","sku":"MUG-001","slug":"camp-mug","name":"Camp Mug","description":"Enamel mug, 350 ml.","priceCents":1299,"currency":"USD","stock":120,"active":true,"version":1,"createdAt":"2026-01-01T10:00:00.000Z","updatedAt":"2026-01-01T10:00:00.000Z"},{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-01-01T09:00:00.000Z"}],"pagination":{"limit":2,"hasMore":false,"nextCursor":null}}
```

The page contains rows strictly older than the cursor, in the same order. `nextCursor: null` means stop.

### Cursor plus offset → `422`

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=2\&cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDExOjAwOjAwLjAwMFoiLCJpZCI6InByZF9ob29kaWUifQ\&offset=2
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: fabcc7fb-7f31-433b-8db8-084ad7460dc7
Content-Type: application/problem+json; charset=utf-8
Content-Length: 441
Date: Thu, 29 Oct 2026 12:26:12 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_pagination","title":"Validation Failed","status":422,"detail":"Use either cursor or offset, not both.","instance":"/api/tenants/ten_acme/products?limit=2&cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDExOjAwOjAwLjAwMFoiLCJpZCI6InByZF9ob29kaWUifQ&offset=2","code":"invalid_pagination","errors":[{"pointer":"/cursor","code":"mutually_exclusive","message":"cursor and offset cannot be combined."}]}
```

Why reject instead of picking one? Because any choice is surprising. If offset wins, the cursor silently does nothing; if cursor wins, the offset silently does nothing. Explicit failure keeps client bugs visible.

### Cursor plus `includeTotal` → `422`

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=2\&cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDExOjAwOjAwLjAwMFoiLCJpZCI6InByZF9ob29kaWUifQ\&includeTotal=true
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: c60be91f-6565-46ce-a30b-13e94e2859e7
Content-Type: application/problem+json; charset=utf-8
Content-Length: 475
Date: Thu, 29 Oct 2026 12:26:12 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_pagination","title":"Validation Failed","status":422,"detail":"Total counts are only available with offset pagination.","instance":"/api/tenants/ten_acme/products?limit=2&cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDExOjAwOjAwLjAwMFoiLCJpZCI6InByZF9ob29kaWUifQ&includeTotal=true","code":"invalid_pagination","errors":[{"pointer":"/includeTotal","code":"unsupported_with_cursor","message":"Remove includeTotal or use offset."}]}
```

### Malformed cursor → `422`

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?limit=2\&cursor=not-a-real-cursor
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 9b629ccf-608f-441b-a49b-106dea92f7d9
Content-Type: application/problem+json; charset=utf-8
Content-Length: 367
Date: Thu, 29 Oct 2026 12:26:12 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/invalid_cursor","title":"Validation Failed","status":422,"detail":"The cursor is malformed. Use nextCursor from the previous page.","instance":"/api/tenants/ten_acme/products?limit=2&cursor=not-a-real-cursor","code":"invalid_cursor","errors":[{"pointer":"/cursor","code":"invalid_cursor","message":"Cursor is not valid."}]}
```

`invalid_cursor` is a distinct code, so clients can show "your page expired, refresh the list" instead of a generic validation error.

Matching `.http` file: [`requests/06b-pagination-cursor.http`](../requests/06b-pagination-cursor.http). Full capture: [`transcripts/06b-pagination-cursor.txt`](../transcripts/06b-pagination-cursor.txt).

---

## 4. Bad vs good

**Bad — base64 cursor that is not a real position**

```ts
// DANGER DEMO — DO NOT SHIP
const start = Number(Buffer.from(String(req.query.cursor), 'base64').toString());
const rows = allRows.slice(start, start + limit); // still offset in disguise
```

Problems:

- A cursor that decodes to an offset has all the instability of offset, with none of the transparency.
- No integrity check: `cursor=0` can be forged to page from anywhere, and `NaN` crashes.
- If rows are deleted, the offset points somewhere else.

**Bad — client-parsed cursor**

```json
{ "nextCursor": { "createdAt": "2026-01-01T11:00:00Z", "id": "prd_hoodie" } }
```

Clients will sort and filter on those fields, build their own cursors, and pin your schema forever. Keep it a string.

**Good — opaque, validated, tied to the sort**

```ts
const cursor = decodeCursor(query.cursor); // 422 invalid_cursor on any tampering
rows = rows.filter((row) => row.createdAt < cursor.createdAt
  || (row.createdAt === cursor.createdAt && row.id < cursor.id));
```

**Trade-offs:**

- **No total.** `includeTotal` is rejected because counting all rows defeats the performance reason for keyset. If a client needs totals, it uses offset mode or a stats endpoint.
- **One sort only.** Supporting cursors for arbitrary sorts means encoding the sort in the cursor and validating that the query's sort matches; doable, but more surface. This API restricts cursor mode to `-createdAt` and documents it.
- **Cursor size grows with sort columns.** Two columns here; with a five-column sort the token gets long. Alternative: store the sort tuple server-side and hand out a random ID. That adds state and expiry.

---

## 5. In a real multi-tenant e-commerce platform

The storefront's "load more" button uses cursor pagination. A shopper scrolls while the merchandiser adds new products at the top:

1. Page 1 returns the 20 newest products and a cursor pointing at the 20th.
2. Ten new products are inserted.
3. Page 2 asks "continue after product X"; it gets products strictly older than X, even though their absolute positions shifted.

No duplicates, no skips. The shopper does not see the new products until they refresh, which is the correct trade: consistency of the read session beats real-time freshness in a paging sequence.

Orders have the same property. An order list sorted newest-first uses a cursor; a new order arriving mid-scroll does not disturb the pages already promised.

Exports and admin tables use offset (chapter 06a) because they need page numbers and totals and run over stable snapshots.

---

## 6. When to use it and when NOT to

**Use cursor when:**

- Infinite scroll, "load more", or API sync loops.
- Data is append-heavy and read newest-first.
- Rows are inserted/deleted while clients page.
- Deep pagination is expected; keyset stays fast with a composite index.

**Do not use cursor when:**

- Users need page numbers or random access.
- The UI requires a total ("showing 1–20 of 4,312").
- The sort is user-selectable across many fields; each sort needs its own cursor semantics.
- The dataset is small and static; offset is simpler for everyone.

**Do not mix them** unless you have a very clear rule. This API rejects mixed parameters, which turns a silent bug into a `422`.

---

## 7. Common mistakes

1. **Cursor that encodes an offset.** It looks opaque but behaves like offset, so the stability benefit is lost.
2. **Sorting by a non-unique column without a tie-breaker.** Ties drift between pages; include `id`.
3. **Changing sort or filters between pages.** The cursor is only valid for the same predicate and order. Document it; consider encoding a filter hash and rejecting mismatches.
4. **Not validating the cursor.** A forged or truncated token must be a `422`, never a `500` or a silent reset to page 1.
5. **Exposing the cursor's JSON shape in docs.** Clients will depend on it. Keep it opaque.
6. **Trying to support `includeTotal` with a cursor.** Either drop the total or use offset; do not scan the whole table on every page.
7. **Using `>` vs `<=` inconsistently.** Off-by-one at page boundaries; the cursor row itself must be excluded.
8. **Cursors that never expire and encode mutable fields.** If a row's `createdAt` changes, the position becomes meaningless. Use immutable sort keys.
9. **Treating the second page's empty result as an error.** `200` with `data: []` and `nextCursor: null` is a valid end.

---

## 8. Try it yourself

**Exercise.** Sort products by `name` and implement cursor pagination for that order. The cursor should carry `name` and `id`. Answer first:

1. Why can't you reuse the existing `{createdAt, id}` cursor for a name sort?
2. How does the filter predicate change for ascending name?
3. What should happen if a client sends a `createdAt` cursor with `sort=name`?

**Hint.** For ascending name, continue after rows where `name > cursor.name`, or `name = cursor.name && id > cursor.id`. The existing cursor has no `name`, so it cannot place you in that order — a `422 invalid_cursor` (or a versioned cursor format) is honest. Decide whether the cursor token should include the sort mode itself so mismatches are detectable. Then update `assertPaginationMode`, `encodeCursor`, and both stores, and re-run `npm run typecheck` and the requests.

---

## 9. Next

[07. JSON conventions →](07-json-conventions.md)
