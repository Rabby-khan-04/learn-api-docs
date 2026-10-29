# 21. OpenAPI 3.2 from Zod schemas

> **Run order:** Prisma server, port 4010, auth on.
>
> Every request below is copied from `transcripts/21-openapi-from-zod.txt`, captured with `curl` on 2026-10-29. The first response prints a 23,614-byte document, so the transcript keeps only the headers and the note that the body is omitted; the smaller `jq` queries right after it show the parts that matter.

---

## 1. Simple explanation (like I'm 7)

Imagine you write a rulebook for a game: "a player must have a name, a team, and at least one point." Then you also print a **menu** for guests that lists the same rules.

If you write the rulebook and the menu by hand, one day you change a rule in the book and forget the menu. Now guests are told the wrong thing, and everyone argues at the door.

The trick in this chapter: write the rules **once** with a machine-readable tool (Zod), and **build the menu automatically from those rules**. The menu cannot drift, because it is not written by hand at all.

---

## 2. Real name

**OpenAPI** is a standard, machine-readable description of an HTTP API: paths, methods, parameters, request bodies, responses, security, and examples. Tools consume it to render documentation (Swagger UI, Redoc), generate clients and server stubs, and run contract tests.

**OpenAPI 3.2.0** is the current version (released 2025-09-23). The document is JSON or YAML; JSON Schema (draft 2020-12) describes payload shapes.

The problem OpenAPI solves is **contract drift**: documentation that says `stock` is required while the code accepts it missing, or a response field that exists in production but not in the docs. The way to prevent drift is to derive the document from the same validators the server already runs.

This project has one source of truth for each request body: the Zod schema in `src/schemas/`. Chapter 9 used those schemas to reject bad input. This chapter feeds the *same objects* into `z.toJSONSchema()` and assembles them into an OpenAPI document served at `/openapi.json`, with Swagger UI at `/docs`.

The architecture:

```
src/schemas/product.ts ─┐
src/schemas/customer.ts ├─► z.toJSONSchema() ─► components.schemas.*
src/schemas/commerce.ts ┘                          │
                                                   ▼
              src/openapi.ts  ──►  buildOpenApiDocument()  ──►  GET /openapi.json
              (paths, responses,                                 │
               parameters, security)                             ▼
                                                        GET /docs  (Swagger UI)
```

Two kinds of schema live in the document, and it is important to know which is which:

| Kind | Where it comes from | Example |
| --- | --- | --- |
| **Input** schemas | Generated from Zod (`io: 'input'`) | `CreateProduct`, `PatchProduct`, `BulkUpdate`, `CreateOrder`, `CreatePayment`, `ApplyCoupon`, `WebhookEndpointCreate` |
| **Output** schemas | Hand-written in `src/openapi.ts`, mirroring the DTOs from chapter 10 | `Product`, `Customer`, `Order`, `Operation`, `Problem` |

Input is generated because Zod owns it. Output is written by hand because the DTOs are plain `.json()` calls, not Zod schemas — generating them would mean writing Zod schemas for responses that the server never validates. That asymmetry is deliberate and is discussed in the trade-offs at the end.

---

## 3. Example

### The generator

```ts
// src/openapi.ts (excerpt)
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',   // the JSON Schema dialect OpenAPI 3.2 uses
    io: 'input',                // describe what the server ACCEPTS
    unrepresentable: 'any',     // transforms/refinements fall back to `any` instead of throwing
  }) as Record<string, unknown>;
  delete generated.$schema;     // a $schema per component confuses some tools
  makeDefaultsOptional(generated);
  return generated;
}
```

Three details in that function are worth pausing on:

- **`io: 'input'`.** Zod distinguishes the value a caller sends from the value after parsing. `.trim()`, `.default()`, and `.transform()` make those differ. `io: 'input'` describes the wire format, which is exactly what an API document must describe. Using `io: 'output'` would advertise post-parse shapes that no client can actually send.
- **`unrepresentable: 'any'`.** Zod refinements (`.refine()`) and transforms have no JSON Schema equivalent. The default is to throw, which would make the whole document fail to build because of one refinement. `'any'` keeps the structural constraints and drops the semantic ones — see the gaps discussion below.
- **`delete $schema`.** `z.toJSONSchema` includes `$schema` at the root of the generated object. Embedded inside `components.schemas`, that key is noise and some tools mis-resolve it.

### Defaults are not required on input

```ts
// src/openapi.ts (excerpt)
// Zod marks defaulted fields as required because the *output* always has them.
// On the request side, a default means the field may be omitted.
function makeDefaultsOptional(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(makeDefaultsOptional);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  const properties = record.properties as Record<string, Record<string, unknown>> | undefined;
  if (Array.isArray(record.required) && properties) {
    const required = record.required.filter((name) => {
      const property = properties[String(name)];
      return !(property && 'default' in property);
    });
    if (required.length === 0) delete record.required;
    else record.required = required;
  }
  for (const value of Object.values(record)) makeDefaultsOptional(value);
}
```

This is a real trap. `z.toJSONSchema` describes the **parsed output of the input**, where `.default(true)` always has a value, so `active` lands in `required`. But a client may legally omit it. If the document says `required: ["active"]`, generated clients demand the field and a contract test refuses the request the server happily accepts.

The walker removes exactly the properties that carry a `default` from every `required` array at every depth. The transcript below proves it: `CreateProduct.required` is `["sku","slug","name","priceCents","currency","stock"]`, and `description` (`default: null`) and `active` (`default: true`) are absent from it.

The recursive walk is necessary because defaults can sit inside nested objects and arrays (for example, order items), not only at the top level.

### Referencing shared pieces instead of repeating them

```ts
// src/openapi.ts (excerpt)
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const problemResponse = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ref('Problem') } },
});
```

Every error response in the document is `problemResponse('...')`, so there is exactly one definition of the RFC 9457 shape from chapter 8 and every endpoint points at it. If the error shape ever grows a member, one edit updates all 19 paths.

The same idea applies to parameters. `TenantId`, `Limit`, `Offset`, `Cursor`, `IncludeTotal`, `IfMatch`, and `IdempotencyKey` live in `components.parameters` once and are referenced with `$ref`, so `limit` cannot be `max 100` in one path and `max 50` in another.

### Paths, security, and the document root

```ts
// src/openapi.ts (excerpt)
return {
  openapi: '3.2.0',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: {
    title: 'api-learn multi-tenant commerce API',
    version: '1.0.0',
    description:
      'Teaching API. Every tenant-scoped route requires a Bearer token whose tenant matches {tenantId}. ' +
      'Errors use RFC 9457 application/problem+json.',
  },
  servers: [{ url: 'http://localhost:4010' }],
  security: [{ bearerAuth: [] }],   // default for every operation
  // ...
```

`security` at the document root means "Bearer token required unless an operation overrides it". `/health` overrides with `security: []` because a liveness probe must work without credentials. Being explicit about that single public route beats leaving it ambiguous.

The document is served from the same Express app it describes:

```ts
// src/app.ts (excerpt)
app.get('/openapi.json', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json(buildOpenApiDocument());
});
```

`no-store` because the document changes whenever the code changes; a cached copy from yesterday is exactly the drift problem this chapter is trying to eliminate.

### Swagger UI

```ts
// src/app.ts (excerpt)
const swaggerDir = dirname(require.resolve('swagger-ui-dist/package.json'));
app.use('/docs-assets', express.static(swaggerDir, { index: false, maxAge: '1h' }));
app.get('/docs', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>api-learn API docs</title>
    <link rel="stylesheet" href="/docs-assets/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs-assets/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true });
    </script>
  </body>
</html>`);
});
```

The assets come from the `swagger-ui-dist` npm package on local disk — no CDN, so the docs page works offline and no third-party request is made. `require.resolve` finds the package's real directory, which is more robust than guessing a path inside `node_modules`.

### Requests and responses (actual)

The document itself.

```console
$ curl -sS -i --request GET http://localhost:4010/openapi.json
```

```http
HTTP/1.1 200 OK
X-Request-Id: fa368e04-77a6-4b1a-9f6c-350e80f4cc01
Cache-Control: no-store
Content-Type: application/json; charset=utf-8
Content-Length: 23614
Date: Thu, 29 Oct 2026 12:29:32 GMT
Connection: keep-alive
Keep-Alive: timeout=5
```

Body: the 23,614-byte document is printed in full by the server; it is omitted here to keep this transcript readable. The queries below read it the way a tool would.

Top-level version and path count:

```console
$ curl -sS http://localhost:4010/openapi.json | jq -r '.openapi, (.paths|keys|length)'
```

```console
3.2.0
19
```

All 19 paths:

```console
$ curl -sS http://localhost:4010/openapi.json | jq -r '.paths|keys[]'
```

```console
/health
/v1/tenants/{tenantId}/customers
/v1/tenants/{tenantId}/customers/{customerId}
/v1/tenants/{tenantId}/customers/{customerId}/ban
/v1/tenants/{tenantId}/customers/{customerId}/unban
/v1/tenants/{tenantId}/exports
/v1/tenants/{tenantId}/exports/{operationId}
/v1/tenants/{tenantId}/exports/{operationId}/result
/v1/tenants/{tenantId}/orders
/v1/tenants/{tenantId}/orders/{orderId}
/v1/tenants/{tenantId}/orders/{orderId}/coupon
/v1/tenants/{tenantId}/orders/{orderId}/payments
/v1/tenants/{tenantId}/products
/v1/tenants/{tenantId}/products/bulk
/v1/tenants/{tenantId}/products/{productId}
/v1/tenants/{tenantId}/uploads
/v1/tenants/{tenantId}/uploads/{uploadId}
/v1/tenants/{tenantId}/webhook-endpoints
/v1/tenants/{tenantId}/webhook-endpoints/{endpointId}/deliveries
```

Every route a client can call in chapters 1–20 is in the document. `/api` is deliberately absent: it is the deprecated alias from chapter 14, and the document describes the current contract.

One operation, as a tool sees it:

```console
$ curl -sS http://localhost:4010/openapi.json | jq '.paths["/v1/tenants/{tenantId}/products"].post | {summary, requestBody, responses: (.responses|keys)}'
```

```json
{
  "summary": "Create a product",
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CreateProduct"
        }
      }
    }
  },
  "responses": [
    "201",
    "409",
    "422"
  ]
}
```

The 201 response carries a `Location` header and the `Product` schema, and 409/422 carry `Problem`. A client generator can build a typed `createProduct` function from this alone.

The shared tenant parameter:

```console
$ curl -sS http://localhost:4010/openapi.json | jq '.components.parameters.TenantId'
```

```json
{
  "name": "tenantId",
  "in": "path",
  "required": true,
  "schema": {
    "type": "string"
  },
  "examples": {
    "acme": {
      "value": "ten_acme"
    }
  }
}
```

An example makes Swagger UI's "Try it out" work without the reader guessing an ID.

The generated input schema — this is Zod's output, post-processed:

```console
$ curl -sS http://localhost:4010/openapi.json | jq '.components.schemas.CreateProduct'
```

```json
{
  "type": "object",
  "properties": {
    "sku": {
      "type": "string",
      "minLength": 3,
      "maxLength": 40,
      "pattern": "^[A-Z0-9-]+$"
    },
    "slug": {
      "type": "string",
      "minLength": 3,
      "maxLength": 80,
      "pattern": "^[a-z0-9-]+$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "description": {
      "default": null,
      "anyOf": [
        {
          "type": "string",
          "maxLength": 2000
        },
        {
          "type": "null"
        }
      ]
    },
    "priceCents": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100000000
    },
    "currency": {
      "type": "string",
      "pattern": "^[A-Z]{3}$"
    },
    "stock": {
      "type": "integer",
      "minimum": 0,
      "maximum": 1000000
    },
    "active": {
      "default": true,
      "type": "boolean"
    }
  },
  "required": [
    "sku",
    "slug",
    "name",
    "priceCents",
    "currency",
    "stock"
  ],
  "additionalProperties": false
}
```

Compare this to the runtime schema in `src/schemas/product.ts`: the constraints are the same ones chapter 9 tested (`TEE-001` passes, `tee` fails the pattern, `stock: -1` fails the minimum), and `additionalProperties: false` comes from `.strict()`. That equivalence is the whole point — a contract test generated from this document tests the server that produced it.

Six required fields, not eight: `description` and `active` have defaults and were removed from `required` by `makeDefaultsOptional`. A client may omit both, and the document now says so.

Security scheme:

```console
$ curl -sS http://localhost:4010/openapi.json | jq '.components.securitySchemes'
```

```json
{
  "bearerAuth": {
    "type": "http",
    "scheme": "bearer"
  }
}
```

The docs page:

```console
$ curl -sS -i --request GET http://localhost:4010/docs
```

```http
HTTP/1.1 200 OK
X-Request-Id: 7d39fe16-87d8-488e-bc99-02b2450d2381
Content-Type: text/html; charset=utf-8
Content-Length: 412
Date: Thu, 29 Oct 2026 12:29:49 GMT
Connection: keep-alive
Keep-Alive: timeout=5

<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>api-learn API docs</title>
    <link rel="stylesheet" href="/docs-assets/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs-assets/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true });
    </script>
  </body>
</html>
```

Open `http://localhost:4010/docs` in a browser: 19 paths in seven tag groups, an "Authorize" button where you paste `tok_acme_admin`, and a schema viewer for every component. In production this page is usually served from CI artifacts or a docs site, not from the API itself.

---

## 4. Bad vs good

**Bad:** a hand-written `openapi.yaml` that is maintained "when we remember".

```yaml
# Bad: drifts the day after it is written
paths:
  /v1/tenants/{tenantId}/products:
    post:
      requestBody:
        content:
          application/json:
            schema:
              required: [sku, slug, name, priceCents, currency, stock, active]
              properties:
                active: { type: boolean }
```

`active` is listed as required, but the server defaults it (chapter 9). A generated client now requires a field it never needed; a contract test now fails a request that returns 201. Nothing catches this, because the YAML and the code have no relationship.

**Good:** the schema is generated and checked in CI.

```ts
// Good: the document is a function of the code
'x-zod-schema': jsonSchema(productListQuerySchema),
// ...
schemas: {
  CreateProduct: jsonSchema(createProductSchema),
  PatchProduct: jsonSchema(patchProductSchema),
  // ...
}
```

The `required` list is whatever the current `createProductSchema` says, minus defaulted fields, computed per request. There is no document to forget to update.

One escape hatch deserves a note: the list operations carry `'x-zod-schema'` as an extension member with the generated JSON Schema for their **query** parameters. The parameters are also listed explicitly under `parameters` with reusable `$ref`s, because that is what tooling understands; the extension keeps the complete generated schema visible for humans diffing the document against the Zod source. It is documentation for the reviewer, not something a generated client consumes.

**Also bad:** deleting `$schema` from each component but not validating the finished document. A generator that emits a shape your OpenAPI version cannot express (for example, comparing `exclusiveMinimum` forms) fails silently in clients.

**Also good:** validate the assembled document in CI with `@redocly/cli lint` or `swagger-cli validate`, and diff it against the deployed `/openapi.json`. Both operations take seconds and turn "the docs look right" into "the docs are right".

---

## 5. In a real multi-tenant e-commerce platform

Three teams consume this API:

- The **storefront** (TypeScript) generates typed clients from `/openapi.json` in its build. When the API adds `couponCode` to `Order`, the next build produces a type with that field.
- An **integration partner** reads `/docs`, sees that `Idempotency-Key` is required on `POST /orders`, and tries the call in the browser before writing a line of code.
- The **SDK team** runs the document through a generator for Python and Java. Shared `$ref`s per parameter and per error schema are what make those SDKs consistent across 19 endpoints.

The multi-tenant part is enforced in two places in the document: every path contains `{tenantId}` (there is no path without it except `/health`), and the security requirement is `bearerAuth` at the root. A partner reading only the docs still learns that every tenant-scoped call needs a token whose tenant matches the path — and chapter 17 is what makes that true in code.

When a tenant-specific field is added — say `taxProfile` on `Order` — the generated clients for every tenant gain it at once, because there is one document, not one per tenant. Field-level differences between tenants belong in the payload (chapter 10), never in separate contracts.

---

## 6. When to use it and when NOT to

**Use OpenAPI when:**

- The API is consumed by people or teams outside the one that wrote it.
- You generate clients, mocks, or server stubs; the document is the input.
- You want contract tests: replay recorded requests against the document's schemas.
- The API is public or partner-facing and needs a browsable reference.
- Multiple services share conventions (errors, pagination, idempotency headers) that you want enforced by a linter.

**Do not expect OpenAPI to:**

- **Replace behavioral documentation.** "Requires `Idempotency-Key`" is expressible; "the same key with a different body returns 409" is a description field at best. Chapters 12 and 13b carry rules the document cannot enforce.
- **Capture refinements.** Zod's `.refine()` (for example, "`maxPriceCents` must be ≥ `minPriceCents`") has no JSON Schema form. It appears in the document as nothing, because of `unrepresentable: 'any'`. Client-side validation from the document will be *weaker* than the server's; that is acceptable — the server is the authority.
- **Describe the output that hand-written schemas miss.** `Product`, `Customer`, `Order`, `Operation`, and `Problem` are maintained by hand. If a DTO gains a field and the OpenAPI component is not updated, the document is wrong and no generator complains. This is the remaining drift risk in a code-first setup, and it is why chapter 22's review checklist includes "diff the document against a live response".
- **Be the source of truth for design.** If you want to agree on an API before writing code, a design-first workflow (write the document, generate servers) fits better. This project chose code-first because the Zod schemas already exist and must not be duplicated.

**Skip it** for a tiny internal service with one consumer in one repository, where the TypeScript types are the contract. Even then, generating the document costs a few lines and pays off the first time someone asks for the API reference.

---

## 7. Common mistakes

1. **Documenting with `io: 'output'`.** Requests are described with the post-parse shape: trimmed strings, filled defaults, transformed values. Clients then send what the server cannot accept. Use `io: 'input'`.
2. **Leaving defaulted fields in `required`.** The most common symptom: generated clients demand `active` or `description` that the server happily defaults. Check any field with `.default()`.
3. **Letting one refinement break the whole build.** With the default `unrepresentable: 'throw'`, a single `.refine()` in any schema makes `buildOpenApiDocument()` throw and `/openapi.json` return 500 — while every other endpoint works. `'any'` plus a comment keeps the document alive and makes the gap visible.
4. **Forgetting `additionalProperties: false`.** Zod's `.strict()` produces it; a hand-written component that omits it tells clients "extra fields are fine", the opposite of what the server does.
5. **Hand-writing input schemas "just for docs".** They drift immediately. Generate them.
6. **Assuming generated output schemas.** In this project output components are hand-written. Do not trust the document for response fields without comparing it to a real response.
7. **No validation step.** An invalid document that still parses as JSON is served with 200 and breaks generators downstream. Lint it in CI.
8. **Serving `/docs` from production without thought.** It is usually fine (the contract is public anyway), but it is also an inventory of every endpoint for an attacker. Decide deliberately.
9. **Caching `/openapi.json`.** Without `no-store`, a CDN can serve yesterday's contract next to today's behaviour.
10. **Documenting the deprecated alias.** `/api` is intentionally absent; listing it makes new clients adopt the path being retired.

---

## 8. Try it yourself

Document the ban response body.

`POST /v1/tenants/{tenantId}/customers/{customerId}/ban` is in the document, but its `200` response has only a description (`"Customer state after the call; changed=false when already banned."`) and no schema, so generated clients get `unknown` back from the single most important fraud operation in the API. Your task has two parts:

1. In `src/openapi.ts`, add a `200` body to the `ban` operation: `content: { 'application/json': { schema: { type: 'object', required: ['customer', 'changed'], properties: { customer: ref('Customer'), changed: { type: 'boolean' } } } } }`, keeping the `403` problem response.
2. Fetch `/openapi.json`, extract `.paths["/v1/tenants/{tenantId}/customers/{customerId}/ban"].post.responses`, and confirm the new shape. Then compare it with the real response body from `transcripts/25d-pattern-fraud-ban-unban.txt` — do the keys match exactly?

**Hint:** the real body is `{"customer":{...},"changed":true}`. If your schema lets a client omit `changed`, the document is wrong: the server always sends it. Also verify that you did not accidentally make the `customer` property a bare object literal instead of `ref('Customer')`; inline copies of shared components are how documents start drifting again.

---

## 9. Next

Chapter 22 takes everything built so far and turns it into reviewable rules: naming, parameter conventions, error consistency, and a workflow for reviewing an API change against an explicit checklist — including how to keep the document from chapter 21 honest.

Next: [22. Consistency, naming, and API review](22-consistency-and-review.md)
