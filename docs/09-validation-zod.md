# 09. Validation with Zod

> **Run order:** in-memory server, port 4011, auth off.
>
> Every request below is copied from `transcripts/09-validation-zod.txt`, captured with `curl` on 2026-10-29. Zod version: **4.6.7**.

---

## 1. Simple explanation (like I'm 7)

Imagine a bouncer at the door of a club. The bouncer has a checklist:

- Is there a name? (yes/no)
- Is the price a whole number, zero or more?
- Is the currency three capital letters?
- Are there any extra things in your bag that are not on the list?

If something fails, the bouncer does not let you in and tells you exactly which item failed. If everything passes, the bouncer makes a **clean copy** of your details and waves you in.

The bouncer is validation. Nobody inside the club ever checks your bag again, because the bouncer already did.

In code, Zod is the bouncer. It checks the input, transforms it into a typed value, and the rest of the code can trust it.

---

## 2. Real name

**Schema validation** means declaring the allowed shape of data and checking inputs against it at the boundary (the HTTP handler), before business logic runs.

Zod is a TypeScript-first schema library. A schema is both:

- a **runtime validator** (`safeParse` / `parse`), and
- a **static type** (`z.infer<typeof schema>`).

The practice this course follows:

1. **Parse at the boundary.** The route parses `req.body` and `req.query` with `parseInput`, which throws a `422` problem (chapter 08b).
2. **Strict objects.** `.strict()` rejects unknown keys. Typos and accidental internal fields fail loudly.
3. **Transform deliberately.** `z.coerce` turns query strings into numbers/booleans; `.trim()` normalizes whitespace; `.default()` fills omitted fields.
4. **Refine cross-field rules.** `minPriceCents <= maxPriceCents` cannot be expressed field-by-field.
5. **One schema per operation.** Create, replace, patch, and list query are separate schemas, because their allowed fields differ (chapter 13a).
6. **Schemas feed OpenAPI.** Chapter 21 generates the document from the same Zod objects, so validation and docs cannot drift.
7. **Never trust `req.body` after parsing?** Actually, never trust it *before* parsing. After `parseInput`, the handler holds a typed value, not `unknown`.

Zod 4 notes: `z.string().trim()` transforms before length checks, `z.coerce.number()` accepts strings and numbers, `z.iso.datetime()` asserts RFC 3339 strings (used for cursors), and `z.toJSONSchema()` generates JSON Schema (chapter 21).

---

## 3. Example

The product schemas:

```ts
// src/schemas/product.ts (excerpt, comments added)
const sku = z.string().trim().min(3).max(40)
  .regex(/^[A-Z0-9-]+$/, 'Use uppercase letters, digits, and hyphens.');
const name = z.string().trim().min(1).max(200);
const priceCents = z.number().int().min(0).max(100_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter ISO 4217 code such as USD.');

export const createProductSchema = z.object({
  sku,
  slug,
  name,
  description: z.string().max(2000).nullable().optional().default(null),
  priceCents,
  currency,
  stock: z.number().int().min(0).max(1_000_000),
  active: z.boolean().optional().default(true),
}).strict();

export const patchProductSchema = z.object({
  sku: sku.optional(),
  // ...
  description: z.string().max(2000).nullable().optional(), // null is meaningful here
  priceCents: priceCents.optional(),
  // ...
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'Send at least one field to update.',
});
```

The route never reads raw fields:

```ts
// src/routes/products.ts (excerpt)
const input = parseInput(createProductSchema, req.body); // typed + validated, or throws 422
const record = await store.createProduct(tenantId, input);
```

### `.trim()` runs before the length and pattern checks

```console
$ curl -sS -i --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Content-Type: application/json' --data-binary '{
  "sku": "  KEY-001  ",
  "slug": "  keyring  ",
  "name": "  Keyring  ",
  "priceCents": 499,
  "currency": "USD",
  "stock": 100
}'
HTTP/1.1 201 Created
X-Request-Id: c7696bfc-568e-4014-a495-7292348bea5e
Location: /api/tenants/ten_acme/products/prd_0e09ddcc-46fc-4487-9c8c-1e399fa07cad
Content-Type: application/json; charset=utf-8
Content-Length: 268
Date: Thu, 29 Oct 2026 12:27:00 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_0e09ddcc-46fc-4487-9c8c-1e399fa07cad","sku":"KEY-001","slug":"keyring","name":"Keyring","description":null,"priceCents":499,"currency":"USD","stock":100,"active":true,"version":1,"createdAt":"2026-10-29T12:27:00.278Z","updatedAt":"2026-10-29T12:27:00.278Z"}
```

The stored values are trimmed. If trimming happened after validation, `"  KEY-001  "` would fail the uppercase regex because of spaces (or pass and store padded values). Order of transforms matters.

### Unknown fields are rejected

```console
$ curl -sS -i --request POST http://localhost:4011/api/tenants/ten_acme/products -H 'Content-Type: application/json' --data-binary '{
  "sku": "PEN-001",
  "slug": "pen",
  "name": "Pen",
  "priceCents": 199,
  "currency": "USD",
  "stock": 100,
  "costCents": 50
}'
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 272d68e1-c5a0-408c-844a-63c2999b0fcb
Content-Type: application/problem+json; charset=utf-8
Content-Length: 315
Date: Thu, 29 Oct 2026 12:27:00 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":"422","detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products","code":"validation_failed","errors":[{"pointer":"","code":"unrecognized_keys","message":"Unrecognized key: \"costCents\""}]}
```

`costCents` is internal. Without `.strict()`, Zod would silently drop it and the client would believe it set a cost. With `.strict()`, the client learns the field is not accepted. This is also how mass-assignment bugs are prevented: an attacker cannot smuggle `tenantId` or `id` into the body.

### Query strings are validated too

```console
$ curl -sS -i --request GET http://localhost:4011/api/tenants/ten_acme/products\?active=maybe
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: dc557483-d033-4949-b3b6-6827f17b9ea0
Content-Type: application/problem+json; charset=utf-8
Content-Length: 350
Date: Thu, 29 Oct 2026 12:27:00 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products?active=maybe","code":"validation_failed","errors":[{"pointer":"/active","code":"invalid_value","message":"Invalid option: expected one of \"true\"|\"false\""}]}
```

Query values arrive as strings. `z.enum(['true','false'])` is explicit and suggests the allowed values. `z.coerce.number()` is used for numeric query parameters (chapter 05a). Do not coerce booleans with JavaScript truthiness: `"false"` is truthy.

### An empty PATCH is rejected by a refinement

```console
$ curl -sS -i --request PATCH http://localhost:4011/api/tenants/ten_acme/products/prd_tee -H 'Content-Type: application/json' --data-binary \{\}
HTTP/1.1 422 Unprocessable Entity
X-Request-Id: 047a7357-661d-41cd-bc53-c0bfc2a2e65b
Content-Type: application/problem+json; charset=utf-8
Content-Length: 315
Date: Thu, 29 Oct 2026 12:27:00 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"https://api-learn.example/problems/validation_failed","title":"Validation Failed","status":422,"detail":"One or more fields are invalid.","instance":"/api/tenants/ten_acme/products/prd_tee","code":"validation_failed","errors":[{"pointer":"","code":"custom","message":"Send at least one field to update."}]}
```

All fields are optional in a patch, so an empty object passes the shape check but is meaningless. `.refine()` closes that hole. In production, a no-op PATCH might return `200` with the unchanged resource; this API chooses `422` because it treats an empty patch as a client bug. Decide and document.

### `null` is allowed where it is meaningful

```console
$ curl -sS -i --request PATCH http://localhost:4011/api/tenants/ten_acme/products/prd_tee -H 'Content-Type: application/json' --data-binary '{ "description": null }'
HTTP/1.1 200 OK
X-Request-Id: 38144ca6-fdfc-4826-97fd-58849cbcc2af
Content-Type: application/json; charset=utf-8
Content-Length: 247
Date: Thu, 29 Oct 2026 12:27:00 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"prd_tee","sku":"TEE-001","slug":"classic-tee","name":"Classic T-Shirt","description":null,"priceCents":1999,"currency":"USD","stock":50,"active":true,"version":2,"createdAt":"2026-01-01T09:00:00.000Z","updatedAt":"2026-10-29T12:27:00.319Z"}
```

`description` is declared `.nullable()`, so `null` means "clear the description". Other optional fields without `.nullable()` cannot be set to null. This distinction is the heart of chapter 13a: absent means "leave unchanged", `null` means "set to empty".

Matching `.http` file: [`requests/09-validation-zod.http`](../requests/09-validation-zod.http). Full capture: [`transcripts/09-validation-zod.txt`](../transcripts/09-validation-zod.txt).

Also visible in the transcript: a successful list (`limit=2`) before the mutations, unchanged by validation work.

---

## 4. Bad vs good

**Bad — hand-rolled checks scattered through the handler**

```ts
// DANGER DEMO — DO NOT SHIP
app.post('/products', (req, res) => {
  const { sku, name, priceCents } = req.body;
  if (!sku) return res.status(400).send('sku required');
  if (typeof priceCents !== 'number') return res.status(400).send('bad price');
  const product = { ...req.body, id: randomUUID() }; // tenantId can be smuggled in
  db.insert(product);
  res.json(product);
});
```

Problems:

- One error at a time; the client plays whack-a-mole.
- `req.body` is spread into the DB row, so `tenantId`, `id`, and `internalCost` from the client can overwrite server-controlled values.
- Status codes and messages are inconsistent with the rest of the API.
- No static type; `sku` is `any`, and a rename compiles but breaks at runtime.
- The same rules must be re-implemented in every handler.

**Good — schema at the boundary, typed value inside**

```ts
const input = parseInput(createProductSchema, req.body); // 422 with errors[] on failure
const record = await store.createProduct(tenantIdOf(req), input); // tenant from path, never body
```

**Trade-offs:**

- **`.strict()` vs `.passthrough()`.** Strict catches typos and protects against mass assignment, but breaks clients that send extra metadata fields. For public APIs with unknown clients, a documented "ignore unknown" policy is sometimes necessary; for this API, strict is the right default.
- **Coercion vs explicit parsing.** `z.coerce.number()` is convenient for query strings but can surprise (`" "` becomes `0` in JavaScript; Zod's coerce uses `Number`, so validate bounds). Explicit parsing with a custom transform is more code but more predictable.
- **Zod vs other validators.** `zod`, `valibot`, `ajv` (JSON Schema), `typebox`. Zod's TypeScript inference and OpenAPI generation are strong; Ajv validates JSON Schema directly and may be faster. The important architectural choice is "validate at the boundary with one schema", not the library.
- **Validation messages vs codes.** Zod issue codes (`too_small`, `invalid_type`) are stable enough to expose; the messages are not a stable contract. Clients should use `code` and `pointer`.

---

## 5. In a real multi-tenant e-commerce platform

Acme's merchandiser pastes a CSV into an admin form. The frontend sends each row as JSON. The API trims whitespace, enforces SKU format, rejects a `costCents` field the UI accidentally included, and returns all six errors at once. No partial products are created.

A partner sends `stock: "25"` (a string from their CSV). The schema declares `stock` as a number, so the request is `422`. Should the API coerce? For bodies, this course does not coerce: JSON has real numbers, and a string means the partner's client is wrong. For query strings, coercion is necessary because everything is a string. That asymmetry is deliberate and documented.

The tenant never comes from the body. `tenantIdOf(req)` reads the verified path tenant (chapter 17). If a body contains `tenantId`, `.strict()` rejects it. This is defense in depth: even if a handler forgot to ignore it, the schema would not allow it.

---

## 6. When to use it and when NOT to

**Use schema validation when:**

- Data crosses a trust boundary (HTTP request, queue message, file import).
- The shape is non-trivial or has cross-field rules.
- You want types and runtime checks from one source.

**When not to:**

- **Internal function calls between trusted, typed modules.** Re-validating every parameter is noise. Validate at the boundary; trust inside.
- **Response validation in production.** Useful in tests and staging; in production it adds cost. Generate types from the DTOs instead.
- **Very large streaming inputs.** Parse incrementally or validate on write, not by buffering the whole body.
- **Binary payloads.** Validate metadata, sniff content types (chapter 19), and scan bytes separately.

**Do not** validate only in the frontend. The frontend is a convenience; the server is the boundary.

---

## 7. Common mistakes

1. **Reading `req.body` before parsing.** A cast (`as CreateProduct`) is not validation; it is a lie to the compiler.
2. **Spreading `req.body` into a DB write.** Mass assignment: clients set `tenantId`, `id`, `role`, `internalCost`.
3. **Forgetting `.strict()`.** Unknown fields are silently dropped, and clients believe they were accepted.
4. **Transform order bugs.** Trim before length/pattern; coerce before bounds; default after optional.
5. **Using `z.boolean()` on query strings.** `"false"` is a non-empty string; parse explicitly.
6. **Duplicating schemas per handler.** Create/replace/patch differ; share field definitions, not whole objects.
7. **Exposing raw Zod messages as a stable contract.** Use `code` + `pointer`; messages can change.
8. **Re-validating responses in production.** Cost without benefit; test it instead.
9. **Trusting path parameters.** Validate IDs' shape and let the store scope by tenant; do not assume `productId` is safe because it is in the path.
10. **Letting a schema drift from OpenAPI.** Generate both from the same schema (chapter 21).

---

## 8. Try it yourself

**Exercise.** Add a `POST /api/tenants/{tenantId}/products/{productId}/reviews` endpoint with this schema:

```ts
{
  rating: integer 1..5,
  title: trimmed string 1..120,
  body?: trimmed string max 2000,
  metadata?: object with at most 5 string keys and string values
}
```

Requirements:

1. Unknown top-level fields are rejected.
2. `metadata` keys must not be `tenantId`, `internal`, or `cost`.
3. The handler must not read `req.body` directly.

Write the Zod schema, wire it through `parseInput`, and test four requests: valid, `rating: 0`, `rating: 3.5`, and `metadata: { cost: "1" }`.

**Hint.** `z.number().int().min(1).max(5)` handles rating. `z.record(z.string(), z.string())` handles metadata; add `.refine()` for the key allowlist/denylist and `.refine()` for the max key count (or use `z.record(...).refine(obj => Object.keys(obj).length <= 5)`). `3.5` fails `.int()` with `invalid_type` (expected int). The denylisted key should produce a `custom` issue with a clear message and, ideally, a pointer to `/metadata/cost` — Zod's `ctx.addIssue({ path: ['metadata', key] })` inside a refinement can do that. Re-run `npm run typecheck` and capture the actual responses before documenting them.

---

## 9. Next

[10. Response shaping and DTOs →](10-response-shaping-dtos.md)
