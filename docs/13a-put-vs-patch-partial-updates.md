# 13a. PUT vs PATCH and partial updates

> **Run order:** Prisma server, port 4010, auth off, cache off, deprecation headers off.
>
> Every request below is copied from `transcripts/13a-put-vs-patch-partial-updates.txt`, captured with `curl` on 2026-10-29.

---

## 1. Simple explanation (like I'm 7)

You have a drawing of a house. It has a door, two windows, a roof, and a chimney.

**PUT** means: "Here is the new drawing. Replace the old one **completely**." If your new drawing has no chimney, the house now has no chimney. You sent the whole picture.

**PATCH** means: "Change only this one thing: make the door red." Everything else stays exactly as it was.

If you send a PATCH that says "change nothing", the shop says "you forgot to say what to change." If you send a PUT that leaves out the roof, the roof is gone — that is not a mistake by the server, that is what PUT means.

---

## 2. Real name

| Method | Meaning | Body | Missing field means |
| --- | --- | --- | --- |
| `PUT` | Replace the entire resource representation | Complete representation | Field is removed / reset to default — usually invalid for required fields |
| `PATCH` | Apply a partial modification | Only fields to change | Field stays unchanged |
| `POST` | Create a subordinate/new resource | Create payload | Defaults apply |

RFC 9110 defines PUT as "replace the target resource's state with the state defined by the representation". PATCH (RFC 5789) is "apply a set of changes". RFC 9110 does not define a patch media type; `application/merge-patch+json` (RFC 7396) and `application/json-patch+json` (RFC 6902) are common choices. This course uses a plain JSON merge-style body with `application/json` — simple, readable, and strict.

Rules this chapter establishes:

1. **PUT requires the full writable representation.** `stock` is required; omitting it is a 422, not "keep the old stock".
2. **PATCH requires at least one field.** `{}` is a 422; a no-op PATCH is almost always a client bug.
3. **`null` is a value, absence is not.** `{"description": null}` clears the description; omitting `description` leaves it alone.
4. **Unknown fields are rejected.** `.strict()` turns `costCents` into a 422 instead of silently ignoring it.
5. **PUT and PATCH are not upserts here.** A missing resource is 404; creating by PUT is a deliberate design choice you can make, but it must be documented.
6. **Both bump `version`.** Concurrency control is chapter 13c; for now, notice that every successful write increments `version`.

---

## 3. Example

### Two schemas, one shared field set

```ts
// src/schemas/product.ts (excerpt)
export const createProductSchema = z
  .object({
    sku,
    slug,
    name,
    description: description.optional().default(null),
    priceCents,
    currency,
    stock,
    active: active.optional().default(true),
  })
  .strict();

// PUT uses the same complete representation as create.
export const replaceProductSchema = createProductSchema;

export const patchProductSchema = z
  .object({
    sku: sku.optional(),
    slug: slug.optional(),
    name: name.optional(),
    description: description.optional(), // nullable: null clears it
    priceCents: priceCents.optional(),
    currency: currency.optional(),
    stock: stock.optional(),
    active: active.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Send at least one field to update.',
  });
```

`replaceProductSchema = createProductSchema` is intentional: a PUT body and a POST body describe the same writable state. Reusing the schema keeps the two from drifting.

### The routes

```ts
// src/routes/products.ts (excerpt)
router.put('/:productId', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
  const tenantId = tenantIdOf(req);
  const current = await store.findProduct(tenantId, pathParam(req, 'productId'));
  if (!current) throw notFound('Product not found.');
  const expectedVersion = expectedVersionFrom(req, current);
  const input = parseInput(replaceProductSchema, req.body); // full representation
  const record = await store.replaceProduct(tenantId, current.id, input, expectedVersion);
  // ...
});

router.patch('/:productId', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
  const tenantId = tenantIdOf(req);
  const current = await store.findProduct(tenantId, pathParam(req, 'productId'));
  if (!current) throw notFound('Product not found.');
  const expectedVersion = expectedVersionFrom(req, current);
  const input = parseInput(patchProductSchema, req.body);   // only what changes
  const record = await store.patchProduct(tenantId, current.id, input, expectedVersion);
  // ...
});
```

The Prisma store writes only keys that were actually sent:

```ts
// src/store/prisma.ts (excerpt)
const data: Prisma.ProductUpdateManyMutationInput = { version: { increment: 1 } };
if (input.sku !== undefined) data.sku = input.sku;
if (input.slug !== undefined) data.slug = input.slug;
// ...
if (input.description !== undefined) data.description = input.description; // null allowed
```

### Starting state

```console
$ curl -sS -i --request GET http://localhost:4010/api/tenants/ten_acme/products/prd_tee
HTTP/1.1 200 OK
X-Request-Id: 77a824e8-10fb-4bcd-a327-8a1104f728c5
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:27:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":"Heavyweight cotton tee.","priceCents":1999,"currency":"USD","stock":50,"active":true,"version":1,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:19.567Z"}
```

### PUT: full replacement

```console
$ curl -sS -i --request PUT http://localhost:4010/api/tenants/ten_acme/products/prd_tee -H 'Content-Type: application/json' --data-binary '{
  "sku": "TEE-001",
  "slug": "classic-tee",
  "name": "Classic T-Shirt (2026)",
  "description": "New heavyweight cotton tee.",
  "priceCents": 2199,
  "currency": "USD",
  "stock": 50,
  "active": true
}'
HTTP/1.1 200 OK
X-Request-Id: 32398349-a71b-4ed7-843c-02caa75955be
Content-Type: application/json; charset=utf-8
Content-Length: 279
Date: Thu, 29 Oct 2026 12:27:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt (2026)","description":"New heavyweight cotton tee.","priceCents":2199,"currency":"USD","stock":50,"active":true,"version":2,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:19.787Z"}
```

Version went 1 → 2. `id`, `version`, `createdAt` are server-controlled and not part of the writable representation.

### PATCH: one field

```console
$ curl -sS -i --request PATCH http://localhost:4010/api/tenants/ten_acme/products/prd_tee -H 'Content-Type: application/json' --data-binary '{ "priceCents": 2299 }'
HTTP/1.1 200 OK
X-Request-Id: 831da345-2cf2-44d7-9b62-9225dbbbec1d
Content-Type: application/json; charset=utf-8
Content-Length: 279
Date: Thu, 29 Oct 2026 12:27:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt (2026)","description":"New heavyweight cotton tee.","priceCents":2299,"currency":"USD","stock":50,"active":true,"version":3,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:19.803Z"}
```

Name, description, and stock survived. Only the price changed, and the version moved to 3.

### PATCH with `null` clears a nullable field

```console
$ curl -sS -i --request PATCH http://localhost:4010/api/tenants/ten_acme/products/prd_tee -H 'Content-Type: application/json' --data-binary '{ "description": null }'
HTTP/1.1 200 OK
X-Request-Id: 7b4c52d3-2d94-4bbf-9e54-4c7f2b3f3ac1
Content-Type: application/json; charset=utf-8
Content-Length: 254
Date: Thu, 29 Oct 2026 12:27:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt (2026)","description":null,"priceCents":2299,"currency":"USD","stock":50,"active":true,"version":4,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:19.817Z"}
```

Compare with `{}` (below): absence does nothing and is rejected; `null` does something and is accepted.

### Unknown field: 422, not silently ignored

```console
$ curl -sS -i --request PATCH http://localhost:4010/api/tenants/ten_acme/products/prd_tee -H 'Content-Type: application/json' --data-binary '{ "priceCents": 1999, "costCents": 700 }'
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 6bdb173b-9cb6-4b4f-a76f-15eeaaf540db
Content-Type: application/problem+json; charset=utf-8
Content-Length: 323
Date: Thu, 29 Oct 2026 12:27:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products/prd_tee","code":"validation_failed","errors":[{"pointer":"","code":"unrecognized_keys","message":"Unrecognized key: \"costCents\""}]}
```

The pointer is `""` (the whole object) because strict-object failures are not tied to a field path. The whole request is rejected; `priceCents` is not partially applied.

### PUT missing a required field: 422

```console
$ curl -sS -i --request PUT http://localhost:4010/api/tenants/ten_acme/products/prd_mug -H 'Content-Type: application/json' --data-binary '{
  "sku": "MUG-001",
  "slug": "camp-mug",
  "name": "Camp Mug",
  "priceCents": 1299,
  "currency": "USD",
  "active": true
}'
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 1f74b95f-d6c2-404c-be49-45c7fa0be866
Content-Type: application/problem+json; charset=utf-8
Content-Length: 343
Date: Thu, 29 Oct 2026 12:27:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products/prd_mug","code":"validation_failed","errors":[{"pointer":"/stock","code":"invalid_type","message":"Invalid input: expected number, received undefined"}]}
```

The server did not guess "keep the old stock". A PUT omission is an error, because otherwise PUT silently becomes a partial update and clients cannot tell the two apart.

### Empty PATCH: 422

```console
$ curl -sS -i --request PATCH http://localhost:4010/api/tenants/ten_acme/products/prd_mug -H 'Content-Type: application/json' --data-binary \{\}
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 6ce41809-ebb9-4751-9fad-457e134b9f89
Content-Type: application/problem+json; charset=utf-8
Content-Length: 315
Date: Thu, 29 Oct 2026 12:27:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products/prd_mug","code":"validation_failed","errors":[{"pointer":"","code":"custom","message":"Send at least one field to update."}]}
```

Matching `.http` file: [`requests/13a-put-vs-patch-partial-updates.http`](../requests/13a-put-vs-patch-partial-updates.http). Full capture: [`transcripts/13a-put-vs-patch-partial-updates.txt`](../transcripts/13a-put-vs-patch-partial-updates.txt).

---

## 4. Bad vs good

**Bad — PUT that behaves like PATCH**

```ts
// DANGER DEMO — DO NOT SHIP
const data = { version: { increment: 1 } };
if (req.body.name !== undefined) data.name = req.body.name;
if (req.body.priceCents !== undefined) data.priceCents = req.body.priceCents;
await prisma.product.updateMany({ where: { id, tenantId }, data });
```

Two problems: the method now lies (PUT promises replacement but patches), and a client that omits `stock` can never tell whether `stock` was reset or ignored. API consumers build caching and "full form submit" logic on PUT semantics.

**Bad — PATCH that accepts unknown fields**

`.passthrough()` or no `.strict()` means `{"costCents": 1}` is accepted and ignored. The client believes the cost was updated; it was not. Later someone adds a real `costCents` column and the old client silently starts setting it. Reject unknowns now.

**Bad — `null` and absent treated the same**

```ts
if (input.description) data.description = input.description;
```

This makes it impossible to clear a description, and it confuses `""` with "not sent". Use `if (input.description !== undefined)`.

**Good — full validation, explicit presence**

```ts
const input = parseInput(replaceProductSchema, req.body); // required fields enforced
const patch = parseInput(patchProductSchema, req.body);   // at least one field
if (input.description !== undefined) data.description = input.description; // null clears
```

**Trade-offs:**

- **Plain JSON merge patch vs RFC 7396 `application/merge-patch+json`.** RFC 7396 gives a standard meaning for `null` (delete) and nested objects; clients must send the right `Content-Type`. This course uses strict flat schemas, where plain JSON is unambiguous. If you support nested resources in PATCH, adopt RFC 7396 and say so.
- **JSON Patch (RFC 6902) vs merge patch.** JSON Patch can express array edits (`add`, `remove`, `replace` with paths) and is ideal for complex documents; it is verbose and harder to validate with Zod. Merge patch is simpler for flat resources.
- **PUT requires all fields vs accepts partial.** Requiring all fields makes replacement honest; accepting partial turns PUT into PATCH with a different name. This API requires all required fields; optional fields (`description`, `active`) have defaults in the create schema and may be omitted.
- **404 vs upsert on PUT.** RFC 9110 allows PUT to create if the client chooses the URL. This API separates creation (POST, server-generated id) from replacement (PUT, existing id) and returns 404 for unknown ids. Upsert-by-PUT is fine when ids are client-owned; document it if you do it.
- **Rejecting unknown fields vs ignoring them.** Rejection catches typos and prevents silent contract drift; ignoring is more forgiving during rollout but hides bugs. Stripe rejects unknown parameters; Microsoft's guidelines recommend ignoring unknown *response* fields on the client, which is a different direction. Be strict on input, tolerant on output.
- **Version bump on every write.** Even setting the same value bumps `version`; that is intentional for concurrency (13c), and it means "no change" cannot be detected by comparing versions.

---

## 5. In a real multi-tenant e-commerce platform

The admin product form loads the full product, lets an editor change several fields, and submits a PUT with the complete representation. If a second editor changed a field in between, the version check (13c) rejects the stale save instead of silently overwriting.

The mobile app's "quick edit price" screen sends a PATCH with only `priceCents`. That request must not wipe the description or reset stock. The strict patch schema makes the intent explicit and keeps the payload small.

A support agent tries to set an internal `costCents` through the public API. The 422 says `Unrecognized key: "costCents"` instead of pretending to succeed. Internal cost is changed through a separate, role-protected endpoint (not part of this course).

For a storefront, a PUT replaces only the fields the merchant owns. Server-managed fields (`id`, `version`, `createdAt`, `updatedAt`) stay out of the request schema, so a client cannot forge them.

---

## 6. When to use it and when NOT to

**Use PUT when:**

- The client has (or can fetch) the full representation.
- The resource is small and flat.
- You want natural idempotency (repeat the same PUT → same state).
- A form submits every field anyway.

**Use PATCH when:**

- The payload should be small (mobile, high-frequency updates).
- Only a few fields change (price, stock, status).
- Different clients own different subsets of fields.

**When not to:**

- **Appending to a list or counters.** PATCH with `{"stock": 10}` replaces the value; "add 5 to stock" needs a different command (an action sub-resource such as `POST /stock-adjustments`), because merge patch is not arithmetic.
- **Concurrent full-resource edits with no version check.** Both PUT and PATCH can overwrite silently; see 13c.
- **Very large documents where a diff is expected.** Use JSON Patch or a dedicated command endpoint.

**Do not** invent `PUT /products/{id}` that creates missing products "because it's convenient" unless the client controls the id and your docs promise upsert semantics.

---

## 7. Common mistakes

1. **PUT implemented as PATCH.** The method lies; clients cannot rely on replacement.
2. **PATCH replacing the whole row.** Reading a partial body and passing it to `update` with defaults wipes fields.
3. **Conflating `null` and absent.** Use `!== undefined` checks and allow explicit `null` only for nullable fields.
4. **Accepting unknown fields.** Typos disappear; future columns get set accidentally. Use `.strict()`.
5. **Accepting an empty PATCH.** Almost always a client bug (form state lost); reject with 422.
6. **Client-controlled server fields in the body.** Never read `id`, `version`, `createdAt` from input; they come from the path and server.
7. **PUT missing `Content-Type`.** `express.json` will not parse it; you get a confusing 400/empty body.
8. **PATCH on a list index or array by position.** Concurrent inserts shift positions; patch by id inside a sub-resource instead.
9. **Returning 204 for PUT/PATCH.** Returning the updated representation is friendlier and saves a follow-up GET; 204 is valid but forces a read.
10. **No version increment.** Without it, concurrency control has nothing to compare.
11. **Validating after fetching.** Parse the body before doing work where possible; a 422 should not require a transaction.
12. **Partial application on validation failure.** Validate the whole body first, then write once; do not loop fields and commit some.

---

## 8. Try it yourself

**Exercise.** Products gain a nullable `weightGrams` field.

1. Add it to the create/PUT schema (optional, default `null`), the PATCH schema (optional, nullable), the DTO, and the field allowlist.
2. Send a PUT **without** `weightGrams`. What happens, and is that the behavior you want?
3. Send `PATCH {"weightGrams": null}` and then `PATCH {}`. What statuses do you expect?
4. Decide whether `PUT` should reset an omitted optional field to its default or require it explicitly. Write one sentence of documentation for your choice.

**Hint.** In this project, `description` and `active` are optional in the create schema and have defaults; `weightGrams` should behave like `description` (optional, default `null`) if you want old clients to keep working. Omitted → default in PUT; `null` in PATCH → cleared; `{}` → 422. The documentation sentence is the contract: "PUT replaces the writable representation; omitted optional fields are reset to their defaults." Consider making the PUT schema require every field to avoid ambiguity.

---

## 9. Next

[13b. Bulk operations →](13b-bulk-operations.md)
