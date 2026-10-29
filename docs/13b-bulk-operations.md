# 13b. Bulk operations

> **Run order:** Prisma server, port 4010, auth off, cache off, deprecation headers off.
>
> Every request below is copied from `transcripts/13b-bulk-operations.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

You have ten pencils and want to write a new price on five of them. You could walk to the teacher five times, once per pencil. Or you could put all five pencils on the desk and say: "Change these five prices, or change none of them."

The second way is a **bulk operation**. It saves trips, and — this is the important part — if one pencil cannot be changed (someone is holding it), the teacher changes **no pencils at all**, so you never end up with half an update.

---

## 2. Real name

A **bulk operation** applies the same kind of change to many resources in one request. The key design questions:

1. **Shape.** One request with an array of updates, versus N requests. Fewer round trips, one authorization decision, one transaction.
2. **Partial success or atomic?** "All or nothing" is easier to reason about and matches a transaction; "partial success" needs a `207 Multi-Status`-style report and clients must reconcile.
3. **Result semantics.** Does `200` mean "all applied" or "received"? This API uses `200` for all-applied and `422 bulk_update_failed` for none-applied.
4. **Concurrency.** Each item can carry `expectedVersion` so a bulk write does not silently overwrite concurrent edits.
5. **Limits.** An unbounded array is a denial-of-service ticket: cap it (50 here) and cap body size (the server's 100 kb JSON limit).

RFC 9110 does not define bulk semantics; `207 Multi-Status` is from WebDAV (RFC 4918) and is a legitimate choice for partial success. Stripe uses dedicated batch endpoints; Microsoft's guidelines suggest `POST /batch` with a request array. This chapter uses a resource-specific `PATCH .../products/bulk` for a single, narrow operation (price updates), which keeps validation simple.

---

## 3. Example

### Schema: bounded, strict, per-item version

```ts
// src/schemas/product.ts (excerpt)
export const bulkUpdateSchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            id: z.string().min(1),
            priceCents,                                  // reuse the single-item rule
            expectedVersion: z.number().int().min(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
```

`.max(50)` is a product rule, not a technical limit: it is the largest set the admin UI sends, and it keeps one transaction short. `.min(1)` rejects an empty list early.

### Route: admin-only, all-or-nothing

```ts
// src/routes/products.ts (excerpt)
router.patch('/bulk', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
  const tenantId = tenantIdOf(req);
  const body = parseInput(bulkUpdateSchema, req.body);
  const result = await store.bulkUpdateProducts(tenantId, body.updates);
  if (!result.ok) {
    throw new HttpProblem(422, 'bulk_update_failed', 'No products were changed because some updates failed.', {
      title: 'Validation Failed',
      errors: result.errors.map((error) => ({
        pointer: '/updates',
        code: error.code,
        message: `${error.id}: ${error.message}`,
      })),
    });
  }
  noStore(res);
  res.status(200).json({ data: result.items.map(productDto) });
});
```

`/bulk` is registered **before** `/:productId`, or Express would treat `bulk` as a product id. Ordering of routes is part of the contract.

### Store: transaction, pre-check, then conditional writes

```ts
// src/store/prisma.ts (excerpt, comments added)
const items = await this.prisma.$transaction(async (tx) => {
  const existing = await tx.product.findMany({ where: { tenantId, id: { in: ids }, deletedAt: null } });
  const byId = new Map(existing.map((product) => [product.id, product]));
  const errors = [];

  // 1. Validate everything before writing anything.
  for (const update of updates) {
    const product = byId.get(update.id);
    if (!product) { errors.push({ id: update.id, code: 'not_found', message: 'Product not found.' }); continue; }
    if (update.expectedVersion !== undefined && product.version !== update.expectedVersion) {
      errors.push({ id: update.id, code: 'version_mismatch', message: `Expected version ${update.expectedVersion}, found ${product.version}.` });
    }
  }
  if (errors.length > 0) throw new BulkAbort(errors);

  // 2. Write with the same version predicate again, in case another transaction won the race.
  for (const update of updates) {
    const result = await tx.product.updateMany({
      where: { id: update.id, tenantId, deletedAt: null,
        ...(update.expectedVersion !== undefined ? { version: update.expectedVersion } : {}) },
      data: { priceCents: update.priceCents, version: { increment: 1 } },
    });
    if (result.count === 0) throw new BulkAbort([{ id: update.id, code: 'version_mismatch', message: 'Concurrent update detected.' }]);
  }
  return tx.product.findMany({ where: { tenantId, id: { in: ids } } });
});
```

Validate-then-write shrinks the window but does not close it; the conditional `updateMany` inside the transaction is the actual guarantee. `BulkAbort` rolls the transaction back, so a failed item leaves earlier items untouched.

### All items valid: one response, all updated

```console
$ curl -sS -i --request PATCH http://localhost:4010/api/tenants/ten_acme/products/bulk -H 'Content-Type: application/json' --data-binary '{
  "updates": [
    { "id": "prd_tee", "priceCents": 2199, "expectedVersion": 1 },
    { "id": "prd_mug", "priceCents": 1399, "expectedVersion": 1 }
  ]
}'
HTTP/1.1 200 OK
X-Request-Id: 6966ca1c-1f08-45c3-99a8-37ddaa407621
Content-Type: application/json; charset=utf-8
Content-Length: 535
Date: Thu, 29 Oct 2026 12:27:20 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"data":[{"id":"prd_mug","sku":"MUG-001","slug":"camp-mug","name":"Camp Mug","description":"Enamel mug, 350 ml.","priceCents":1399,"currency":"USD","stock":120,"active":true,"version":2,"createdAt":"2026-01-01T10:00:00.000Z","updatedAt":"2026-10-29T12:27:20.847Z"},{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":2199,"currency":"USD","stock":50,"active":true,"version":2,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:20.846Z"}]}
```

Both versions became 2. The returned order follows the database's result order (`prd_mug`, then `prd_tee`), not the input order. Clients should match by `id`, not position.

### One bad item: 422, nothing changed

```console
$ curl -sS -i --request PATCH http://localhost:4010/api/tenants/ten_acme/products/bulk -H 'Content-Type: application/json' --data-binary '{
  "updates": [
    { "id": "prd_tee", "priceCents": 2299, "expectedVersion": 99 },
    { "id": "prd_missing", "priceCents": 100 }
  ]
}'
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 93c69e39-c950-4330-8776-901aeb23aa38
Content-Type: application/problem+json; charset=utf-8
Content-Length: 444
Date: Thu, 29 Oct 2026 12:27:20 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/bulk_update_failed","title":"Validation Failed","status":422,"detail":"No products were changed because some updates failed.","instance":"/api/tenants/ten_acme/products/bulk","code":"bulk_update_failed","errors":[{"pointer":"/updates","code":"version_mismatch","message":"prd_tee: Expected version 99, found 2."},{"pointer":"/updates","code":"not_found","message":"prd_missing: Product not found."}]}
```

Two errors are reported at once — one round trip tells the admin everything wrong. The pointer is `/updates` for every item because the item index is not encoded; the id is in the message. A richer version would use `/updates/0/expectedVersion` pointers.

### The unchanged product proves atomicity

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_acme/products/prd_tee
HTTP/1.1 200 OK
X-Request-Id: 2069cb96-1f09-422c-b985-c59175138056
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:27:20 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":2199,"currency":"USD","stock":50,"active":true,"version":2,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:20.846Z"}
```

`prd_tee` still has the price from the first bulk (2199) and version 2; the failed bulk did not partially apply 2299.

### Empty list: 422 from the schema

```console
$ curl -sS -i --request PATCH http://localhost:4010/api/tenants/ten_acme/products/bulk -H 'Content-Type: application/json' --data-binary '{ "updates": [] }'
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 1eaf7f9c-bdd5-4ac8-840a-a6de67e5fe56
Content-Type: application/problem+json; charset=utf-8
Content-Length: 332
Date: Thu, 29 Oct 2026 12:27:20 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products/bulk","code":"validation_failed","errors":[{"pointer":"/updates","code":"too_small","message":"Too small: expected array to have >=1 items"}]}
```

Matching `.http` file: [`requests/13b-bulk-operations.http`](../requests/13b-bulk-operations.http). Full capture: [`transcripts/13b-bulk-operations.txt`](../transcripts/13b-bulk-operations.txt).

---

## 4. Bad vs good

**Bad — client loop of single PATCHes**

```ts
// DANGER DEMO — DO NOT SHIP
for (const update of updates) await patchProduct(update.id, update);
```

Problems: N round trips, N authorization checks, N transactions, partial application when request 7 fails, no single error report, and no way to reason about the set as a unit. On a slow mobile link this is also N timeouts waiting to happen.

**Bad — one giant SQL `UPDATE` from user input**

Building `UPDATE products SET price = CASE ...` from request values invites injection and unbounded statements. Use parameterized ORM calls with a capped array.

**Bad — 200 with per-item errors**

Returning `200` plus `[{"error": ...}]` forces clients to inspect a body to know whether the operation failed. If nothing was applied, the status should say so (`422`); if some were applied, a documented partial-success format (207) is clearer than a silent 200.

**Good — atomic bulk with item-level errors**

```ts
if (!result.ok) throw new HttpProblem(422, 'bulk_update_failed', ..., { errors: ... });
res.status(200).json({ data: result.items.map(productDto) });
```

**Trade-offs:**

- **Atomic vs partial success.** Atomic matches "the admin clicked Save once" and is easy to retry. Partial is better for huge batches where rejecting everything for one bad id is unacceptable (imports, migrations); then use `207` with per-item status and document retry semantics. This API is atomic because the set is small and priced edits are reviewed as a unit.
- **`PATCH /bulk` vs `POST /bulk-actions`.** PATCH says "apply these partial changes"; POST implies a new action resource. Both are used in the wild; PATCH is a reasonable fit for same-resource updates, POST is clearer when the operation has its own state (long-running imports, chapter 18).
- **Per-item `expectedVersion` vs one `If-Match`.** One header cannot express 50 different versions. Per-item versions preserve optimistic concurrency; clients that omit them accept the risk.
- **Returning full DTOs vs ids.** Full DTOs save a follow-up refresh; for 50 products the payload is still small. For 10,000 rows, return only ids or a job reference.
- **Separate endpoint vs a generic `/batch`.** A resource-specific endpoint has typed validation and clear errors; a generic batch endpoint can mix methods and paths but needs its own envelope, auth rules per sub-request, and careful limits. Start specific.
- **Error pointers with indexes.** `/updates/1/expectedVersion` is more machine-readable than `/updates`; it costs a little bookkeeping to preserve the input index. The current implementation reports the id in the message.

---

## 5. In a real multi-tenant e-commerce platform

A merchant runs a 10% price increase on 50 SKUs before a holiday. The admin UI sends one bulk request. The server checks tenant ownership, versions, and the 50-item cap; one transaction applies all 50 updates or none. If the merchant's second browser tab changed one price, the whole batch is rejected with a precise list, and the UI can refresh and resubmit.

Under the hood, the tenant filter is applied to both the validation read and every update. A malicious id from another tenant is simply `not_found`, and the composite foreign keys in `order_items` mean historical orders still point at the right tenant's product. The bulk path never bypasses the single-item rules: `priceCents` is the same Zod schema.

For very large catalog imports, this endpoint is the wrong tool: 50k rows need an async operation (chapter 18), not a synchronous transaction holding locks.

---

## 6. When to use it and when NOT to

**Use bulk when:**

- An admin UI edits a set as one action.
- N is small (tens to low hundreds) and the operation fits one transaction.
- You want all-or-nothing semantics and one error report.
- The per-item payload is simple (one or two fields).

**When not to:**

- **Huge imports/exports.** Use an async job with a status resource (chapter 18).
- **Heterogeneous operations** (create some, delete others, change a third). A generic batch API is a different design with its own auth/complexity; often separate calls are safer.
- **Independent items where one failure should not block the rest.** Then either partial success with a documented `207`, or individual requests.
- **Long-running per-item work.** A transaction that calls external services per row is a lock-holding disaster.

**Do not** accept unbounded arrays or per-item arbitrary field sets; both are a validation and abuse problem.

---

## 7. Common mistakes

1. **`/bulk` route after `/:id`.** Express matches `/:productId` first; the bulk endpoint becomes a 404 or updates a product literally named "bulk".
2. **No cap.** A 100k-item array holds a transaction and memory for a long time.
3. **Partial writes without saying so.** Returning 200 while some items failed breaks the contract.
4. **Skipping tenant filters per item.** One global `id IN (...)` query lets a tenant update another tenant's rows if ids are guessed.
5. **No version checks.** Bulk edits are exactly where last-write-wins destroys colleagues' work.
6. **Duplicate ids in the input.** Decide and document: reject duplicates, or apply last; otherwise results depend on loop order.
7. **Reporting only the first error.** Admins then fix, retry, hit the next error, repeat. Collect all item errors in one pass.
8. **Using one giant transaction for slow work.** Keep transactions short; do external calls outside.
9. **Returning results in input order implicitly.** Database order differs; clients should key by id, and docs should say so.
10. **Different validation than single-item endpoints.** Drift means a price valid in bulk but invalid in PATCH.
11. **No audit trail.** Bulk price changes need an actor and a timestamp (a fraud/audit event or version history) in production.
12. **Assuming `200` means each item was updated exactly once.** Retries can replay; pair with idempotency if the operation is not naturally repeatable.

---

## 8. Try it yourself

**Exercise.** The bulk endpoint must also support activating/deactivating products.

1. Change the per-item schema to accept `active?: boolean` and `priceCents` as optional, requiring at least one change per item. What does `.refine` look like?
2. Decide what a duplicate id in `updates` should do. Implement one behavior and document it.
3. Two clients bulk-edit the same product with the same `expectedVersion`. Describe the outcome.
4. Change the error pointer from `/updates` to `/updates/{index}/...`. Which data must the store return to make that possible?

**Hint.** Per-item refinement mirrors `patchProductSchema` (at least one of `priceCents`/`active`). Duplicates: reject with `duplicate_id` or dedupe last-wins; either is defensible if documented. Concurrent same-version: the first transaction increments the version, the second's conditional update hits zero rows and aborts with `version_mismatch`. For indexed pointers, the store must return the original array index with each error (or the route maps id → index from the input).

---

## 9. Next

[13c. Concurrency: ETags and If-Match →](13c-concurrency-etags-if-match.md)
