# 18. Long-running operations

> **Run order:** Prisma server, port 4010, auth on, cache off, deprecation headers off.
>
> Every request below is copied from `transcripts/18-long-running-operations.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

You ask the baker for 500 cookies. The baker cannot hand them over while you stand there for an hour; other customers are waiting.

So the baker writes you a **ticket**: "Order #42, baking." You can look at the ticket whenever you want: still baking, still baking, done! Then you take the ticket to the counter and pick up the cookies.

The ticket is the **operation**. "Baking" is `RUNNING`. "Done" is `SUCCEEDED`. If the oven breaks, the ticket says `FAILED` with a reason. You never block the counter.

---

## 2. Real name

A **long-running operation** is work that should not be done inside the request/response cycle: exports, imports, bulk reindexing, report generation, video transcoding, external batch jobs.

The 202 pattern (RFC 9110 §15.2.3):

1. `POST` starts the work.
2. The server responds `202 Accepted` — "I received it; I have not finished".
3. The response has a `Location` pointing at an **operation resource**.
4. The client polls that resource (`GET`) or receives a webhook (chapter 20).
5. When the operation succeeds, its `resultUrl` points at the produced resource.
6. Before completion, asking for the result is `409 operation_not_complete` (or `404` if you model results as nonexistent until ready; 409 is clearer here).
7. The client may use `Retry-After` to pace polling.

Why not just do the work synchronously?

- Proxies and clients time out (often 30–60 s), leaving the client unsure whether work started.
- A long request holds a connection and, worse, a database transaction.
- The server cannot report progress or partial failure.
- Retrying a timed-out POST may duplicate the work unless you add idempotency (chapter 12).

The operation is itself a REST resource with a state machine:

```
QUEUED → RUNNING → SUCCEEDED
                 ↘ FAILED
```

Statuses and HTTP:

| State | Operation GET | Result GET |
| --- | --- | --- |
| `QUEUED` | `200`, `Retry-After: 1` | `409 operation_not_complete` |
| `RUNNING` | `200` | `409 operation_not_complete` |
| `SUCCEEDED` | `200` with `resultUrl` | `200` with the result |
| `FAILED` | `200` with `error` | `409` (or `410` if you chose to keep failures terminal) |

---

## 3. Example

### Start: 202, Location, Retry-After

```ts
// src/routes/exports.ts (excerpt)
router.post('/', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
  const tenantId = tenantIdOf(req);
  const operation = await prisma.operation.create({
    data: { id: newId('op'), tenantId, type: 'products_csv', status: 'QUEUED' },
  });

  // A job queue would do this. Keeping it in-process makes the 202 flow
  // observable in a single tutorial server.
  setTimeout(() => {
    void runExport(prisma, store, tenantId, operation.id).catch((error) => {
      console.error('export failed', error);
    });
  }, EXPORT_DELAY_MS); // 1200 ms

  res.set({ 'Cache-Control': 'no-store', 'Retry-After': '1' });
  res.status(202).location(`/v1/tenants/${tenantId}/exports/${operation.id}`).json({
    operation: operationDto(operation),
    links: { self: `/v1/tenants/${tenantId}/exports/${operation.id}` },
  });
});
```

`Location` on 202 points at the operation, not at the eventual result. `Retry-After: 1` is a hint for the first poll. `no-store`: an operation changes state every second; caching it is always wrong.

### Poll: operation status

```ts
// src/routes/exports.ts (excerpt)
router.get('/:operationId', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const operation = await prisma.operation.findFirst({
    where: { id: pathParam(req, 'operationId'), tenantId }, // tenant-scoped
  });
  if (!operation) throw notFound('Operation not found.');
  res.set({ 'Cache-Control': 'no-store', ...(operation.status === 'QUEUED' ? { 'Retry-After': '1' } : {}) });
  res.status(200).json(operationDto(operation));
});
```

`Retry-After` is sent only while queued; once running or finished, the client should poll faster or stop.

### Result: 409 until it is ready

```ts
// src/routes/exports.ts (excerpt)
if (operation.status !== 'SUCCEEDED' || !operation.resultUrl) {
  throw new HttpProblem(
    409,
    'operation_not_complete',
    `The export is ${operation.status.toLowerCase()}. Poll the operation until it succeeds.`,
    { extensions: { operationStatus: operation.status } },
  );
}
const file = await readFile(join(config.uploadDir, 'exports', tenantId, `${operation.id}.csv`), 'utf8');
res.set({
  'Content-Type': 'text/csv; charset=utf-8',
  'Content-Disposition': `attachment; filename="products-${operation.id}.csv"`,
  'Cache-Control': 'private, no-store',
});
res.status(200).send(file);
```

The `operationStatus` extension mirrors the sub-resource status so a client that jumped straight to `/result` still learns the state.

### The worker

```ts
// src/routes/exports.ts (excerpt)
await prisma.operation.update({ where: { id: operationId }, data: { status: 'RUNNING' } });
const result = await store.listProducts(tenantId, { sort: 'createdAt', limit: 100, includeTotal: false });
// ... build CSV with csvCell() escaping ...
await writeFile(join(dir, `${operationId}.csv`), `${[header, ...lines].join('\n')}\n`, 'utf8');
await prisma.operation.update({
  where: { id: operationId },
  data: { status: 'SUCCEEDED', resultUrl: `/v1/tenants/${tenantId}/exports/${operationId}/result` },
});
```

`csvCell` quotes values containing `"`, `,`, `\r`, or `\n` and doubles embedded quotes. Without that, a product name containing a comma silently shifts every later column.

### Start: 202

```console
$ curl -sS -i --request POST http://localhost:4010/v1/tenants/ten_acme/exports -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 202 Accepted
X-Request-Id: 3092d2fe-1eba-4314-8e4b-9e8e8c628f62
Cache-Control: no-store
Retry-After: 1
Location: /v1/tenants/ten_acme/exports/op_3812a095-8c14-46a4-b2f6-07493cbc15ae
Content-Type: application/json; charset=utf-8
Content-Length: 298
Date: Thu, 29 Oct 2026 12:28:51 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"operation":{"id":"op_3812a095-8c14-46a4-b2f6-07493cbc15ae","type":"products_csv","status":"QUEUED","resultUrl":null,"error":null,"createdAt":"2026-10-29T12:28:51.610Z","updatedAt":"2026-10-29T12:28:51.610Z"},"links":{"self":"/v1/tenants/ten_acme/exports/op_3812a095-8c14-46a4-b2f6-07493cbc15ae"}}
```

### Poll immediately: still queued

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/exports/op_3812a095-8c14-46a4-b2f6-07493cbc15ae -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 200 OK
X-Request-Id: 5c131b0a-7852-4c2a-be09-8a7b315ce4cf
Cache-Control: no-store
Retry-After: 1
Content-Type: application/json; charset=utf-8
Content-Length: 196
Date: Thu, 29 Oct 2026 12:28:51 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"op_3812a095-8c14-46a4-b2f6-07493cbc15ae","type":"products_csv","status":"QUEUED","resultUrl":null,"error":null,"createdAt":"2026-10-29T12:28:51.610Z","updatedAt":"2026-10-29T12:28:51.610Z"}
```

### Result too early: 409

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/exports/op_3812a095-8c14-46a4-b2f6-07493cbc15ae/result -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 409 Conflict
X-Request-Id: ee80ff58-6b59-4cf5-8ce9-3a6edd44c4c6
Content-Type: application/problem+json; charset=utf-8
Content-Length: 319
Date: Thu, 29 Oct 2026 12:28:51 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/operation_not_complete","title":"Conflict","status":409,"detail":"The export is queued. Poll the operation until it succeeds.","instance":"/v1/tenants/ten_acme/exports/op_3812a095-8c14-46a4-b2f6-07493cbc15ae/result","code":"operation_not_complete","operationStatus":"QUEUED"}
```

### After the wait: SUCCEEDED

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/exports/op_3812a095-8c14-46a4-b2f6-07493cbc15ae -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 200 OK
X-Request-Id: a13201a5-9cd5-4fa9-8bcd-f28284a2f431
Cache-Control: no-store
Content-Type: application/json; charset=utf-8
Content-Length: 272
Date: Thu, 29 Oct 2026 12:28:53 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"op_3812a095-8c14-46a4-b2f6-07493cbc15ae","type":"products_csv","status":"SUCCEEDED","resultUrl":"/v1/tenants/ten_acme/exports/op_3812a095-8c14-46a4-b2f6-07493cbc15ae/result","error":null,"createdAt":"2026-10-29T12:28:51.610Z","updatedAt":"2026-10-29T12:28:52.823Z"}
```

### Download the result

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_acme/exports/op_3812a095-8c14-46a4-b2f6-07493cbc15ae/result -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 200 OK
X-Request-Id: 8c77bb72-6d9f-47d0-a19c-680b75ce4bf1
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="products-op_3812a095-8c14-46a4-b2f6-07493cbc15ae.csv"
Cache-Control: private, no-store
Content-Length: 407
Date: Thu, 29 Oct 2026 12:28:53 GMT
Connection: keep-alive
Keep-Alive: timeout=5

id,sku,slug,name,priceCents,currency,stock,active,version,createdAt
prd_tee,TEE-001,classic-tee,Classic T-Shirt,1999,USD,50,true,1,2026-01-01T09:00:00.000Z
prd_mug,MUG-001,camp-mug,Camp Mug,1299,USD,120,true,1,2026-01-01T10:00:00.000Z
prd_hoodie,HOO-001,trail-hoodie,Trail Hoodie,4999,USD,8,true,1,2026-01-01T11:00:00.000Z
prd_cap,CAP-001,running-cap,Running Cap,2499,USD,0,false,1,2026-01-01T12:00:00.000Z
```

`Content-Disposition: attachment` tells a browser to download rather than render; the filename is fixed to the operation id, which avoids user-controlled names and header injection.

### Another tenant cannot even see the operation

```console
$ curl -sS -i --request GET http://localhost:4010/v1/tenants/ten_globex/exports/op_3812a095-8c14-46a4-b2f6-07493cbc15ae -H 'Authorization: Bearer tok_acme_admin'
HTTP/1.1 403 Forbidden
X-Request-Id: e4e8c793-11a0-470f-89ae-f38c9f3c084d
Content-Type: application/problem+json; charset=utf-8
Content-Length: 251
Date: Thu, 29 Oct 2026 12:28:53 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/forbidden","title":"Forbidden","status":403,"detail":"This token is not allowed to access that tenant.","instance":"/v1/tenants/ten_globex/exports/op_3812a095-8c14-46a4-b2f6-07493cbc15ae","code":"forbidden"}
```

The path says Globex, the token says Acme: rejected at the tenant boundary before the operation lookup. Had the token matched but the operation belonged elsewhere, the lookup `where: { id, tenantId }` would return 404.

Matching `.http` file: [`requests/18-long-running-operations.http`](../requests/18-long-running-operations.http). Full capture: [`transcripts/18-long-running-operations.txt`](../transcripts/18-long-running-operations.txt).

---

## 4. Bad vs good

**Bad — doing the export in the request**

```ts
// DANGER DEMO — DO NOT SHIP
const csv = await buildCsv(allTenantProducts); // 40 seconds
res.send(csv);
```

Problems: proxies time out; the client does not know whether the job failed or is still running; a retry starts a second export; the event loop is blocked or the connection sits open; no progress, no result link, no cleanup. With 100k products, memory dies first.

**Bad — `202` without an operation resource**

"Accepted, check back later" with no URL is not a contract. The client cannot observe, cancel, or retrieve the result. `Location` is the whole point.

**Bad — polling the start endpoint for the result**

`GET /exports` returning a status enum related to "the last export" is ambiguous with multiple clients and multiple tenants. Give each job its own URL.

**Bad — `200` with `{status: "queued"}` and no `Retry-After`**

The client polls every 50 ms and DDOSes you with its own job. Send `Retry-After` and document a sensible interval.

**Bad — in-process `setTimeout` in production**

This tutorial uses it so the 202 flow is visible on one server. In production, work must survive a deploy or crash: use a durable queue (SQS, BullMQ/Redis, a database-backed job table) and a worker. A job stuck in `RUNNING` after a crash needs a recovery sweep.

**Good — 202 + operation + poll + result, all tenant-scoped**

```ts
res.status(202).location(operationUrl).set('Retry-After', '1').json({ operation, links });
```

**Trade-offs:**

- **Polling vs webhooks vs SSE.** Polling is simple, works through proxies, and needs no client callbacks; it wastes requests and adds latency. Webhooks (chapter 20) push completion but require a reachable, verifying receiver and retry logic. SSE/WebSocket fits interactive UIs but is harder to operate. Many APIs offer polling as the baseline and webhooks as an optimization.
- **`409` vs `404` for an unfinished result.** `404` says "no result exists yet"; `409` says "the result URL exists but is not ready" and carries the operation state. Both are used; 409 is more informative. Once a job fails, `409` forever is odd — consider `410` or a failure document at the result URL.
- **Result URL vs embedding the result.** A huge CSV should not be in JSON; `resultUrl` plus `Content-Disposition` is the standard. Small results (a count) can be embedded in the operation.
- **Operation expiry.** Results and operation rows should have a TTL (hours/days); otherwise storage grows forever. Document how long a `resultUrl` stays valid.
- **Idempotent job creation.** A retried POST creates two exports. Pair the start endpoint with an `Idempotency-Key` (chapter 12), or dedupe on `(tenant, type, params, window)`. This tutorial omits it to keep the flow small; production should not.
- **Cancellation.** `DELETE /exports/{id}` can request cancellation if the worker supports it. Say whether it is immediate or best-effort; do not pretend a `204` stopped work that keeps running.
- **`303 See Other` vs `202`.** If the work is usually fast, some APIs do the work and redirect to the result with `303`. For genuinely long work, `202` is clearer and does not hold the connection.

---

## 5. In a real multi-tenant e-commerce platform

Acme's finance team exports the product catalog every Monday. The admin UI POSTs, gets `202` with an operation URL, shows a progress chip, and polls every second (honoring `Retry-After`). The worker streams 50,000 rows to object storage instead of building a string in memory; the operation records the object key. When it finishes, the UI offers a download link, and the operation row expires after seven days.

Globex starts an export at the same moment. Operations are rows with `tenantId`; the worker receives the tenant id and uses the tenant-scoped store, so one tenant's export can never contain another's products. A Globex admin who guesses an Acme operation id and swaps the path segment gets 403 from the tenant boundary; if the path matched but the id belonged to Acme, the scoped lookup gives 404.

If the worker dies mid-export, the operation stays `RUNNING`. A recovery job sees rows older than the expected duration, marks them `FAILED`, and the client can start a new export. In this tutorial the process is the worker, so a restart loses in-flight work — acceptable for teaching, not for production.

---

## 6. When to use it and when NOT to

**Use 202 + operation when:**

- Work routinely exceeds a few seconds or is bursty.
- The work is expensive or touches many rows/external services.
- Clients need progress, retries, or a durable result.
- The request would hold a transaction or connection too long.

**When not to:**

- **Fast writes** (a single order) — return 201 and be done.
- **Work the client must see immediately** (payment authorization): blocking is the correct UX, with a short timeout and idempotency.
- **Fire-and-forget side effects** (send an email): accept and return 202 only if the client genuinely does not need a result; otherwise the operation resource is still useful for support.

**Do not** turn every endpoint into a job. Synchronous is simpler; use 202 where time or failure risk demands it.

---

## 7. Common mistakes

1. **Long work inside the request.** Timeouts, retries, held connections.
2. **`202` without `Location`.** Client cannot poll.
3. **No `Retry-After`.** Polling storms.
4. **No operation resource, only a status field on another resource.** Ambiguous with concurrency.
5. **Not tenant-scoping the operation.** Cross-tenant status/result leaks.
6. **Result URL without authorization.** A guessed URL (or a signed URL shared too widely) exposes data.
7. **Returning `200` before the work is durable.** A crash loses the job while the client thinks it was accepted.
8. **In-memory job state.** Survives neither restart nor horizontal scaling.
9. **No failure state or error message.** Clients poll forever.
10. **No TTL/cleanup.** Operations and result files accumulate.
11. **Blocking the event loop in the worker.** CSV building with huge strings stalls other requests; stream and yield.
12. **No idempotency on job creation.** Double-click creates two exports.
13. **CSV injection.** A field starting with `=`, `+`, `-`, or `@` can execute in a spreadsheet; sanitize if exports open in Excel.
14. **CSV quoting bugs.** Commas, quotes, and newlines in product names shift columns.
15. **Leaking internal error text into `error`.** Truncate and sanitize (this code truncates at 500 chars but still stores the message; production should map to safe codes).

---

## 8. Try it yourself

**Exercise.** Add an import job: `POST /v1/tenants/{tenantId}/imports` accepts CSV text and creates products asynchronously.

1. Design the start response and the operation resource fields. What is the `Location`?
2. The CSV has 10,000 rows and row 7,000 fails. Should the job fail entirely or report partial success? What does the operation body look like in each case?
3. How does the client learn about completion without polling every 100 ms?
4. A client retries the start request after a timeout. What prevents two imports?
5. What must the worker do so Globex can never import into Acme?

**Hint.** `202` + operation with `type: products_import`, `status`, counts (`rowsTotal`, `rowsOk`, `rowsFailed`), `errors` (first N), `resultUrl` maybe null. Partial success is usually better for imports: `SUCCEEDED` with counts, or `PARTIAL` if you add it; document which. Use webhooks (chapter 20) or a documented poll interval. Idempotency-Key on start. Worker takes `tenantId` from the operation row and calls the tenant-scoped store; the CSV cannot name a tenant.

---

## 9. Next

[19. File uploads →](19-file-uploads.md)
