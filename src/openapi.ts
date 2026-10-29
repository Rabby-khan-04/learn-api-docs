import { z } from 'zod';
import {
  bulkUpdateSchema,
  createProductSchema,
  patchProductSchema,
  productListQuerySchema,
} from './schemas/product.js';
import { banCustomerSchema, customerListQuerySchema } from './schemas/customer.js';
import {
  applyCouponSchema,
  createOrderSchema,
  createPaymentSchema,
  webhookEndpointSchema,
} from './schemas/commerce.js';

// Zod is the request validator; OpenAPI is generated from the same schemas so
// the contract cannot drift from the code the way hand-written YAML does.
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete generated.$schema;
  makeDefaultsOptional(generated);
  return generated;
}

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

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const problemResponse = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ref('Problem') } },
});

const product = {
  type: 'object',
  required: ['id', 'sku', 'slug', 'name', 'priceCents', 'currency', 'stock', 'active', 'version', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', examples: ['prd_tee'] },
    sku: { type: 'string', examples: ['TEE-001'] },
    slug: { type: 'string', examples: ['classic-tee'] },
    name: { type: 'string', examples: ['Classic T-Shirt'] },
    description: { type: ['string', 'null'] },
    priceCents: { type: 'integer', examples: [1999], description: 'Minor units, e.g. cents.' },
    currency: { type: 'string', examples: ['USD'] },
    stock: { type: 'integer' },
    active: { type: 'boolean' },
    version: { type: 'integer', examples: [1] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const customer = {
  type: 'object',
  required: ['id', 'email', 'name', 'status', 'version', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', examples: ['cus_acme_01'] },
    email: { type: 'string', format: 'email' },
    name: { type: 'string' },
    status: { type: 'string', enum: ['ACTIVE', 'BANNED'] },
    bannedAt: { type: ['string', 'null'], format: 'date-time' },
    banReason: { type: ['string', 'null'] },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const order = {
  type: 'object',
  required: ['id', 'status', 'customerId', 'items', 'subtotalCents', 'discountCents', 'totalCents', 'currency', 'version', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', examples: ['ord_...'] },
    status: { type: 'string', enum: ['PENDING', 'PAID'] },
    customerId: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          productId: { type: 'string' },
          sku: { type: 'string' },
          name: { type: 'string' },
          unitPriceCents: { type: 'integer' },
          quantity: { type: 'integer' },
          lineTotalCents: { type: 'integer' },
        },
      },
    },
    subtotalCents: { type: 'integer' },
    discountCents: { type: 'integer' },
    totalCents: { type: 'integer' },
    currency: { type: 'string' },
    couponCode: { type: ['string', 'null'] },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const operation = {
  type: 'object',
  required: ['id', 'type', 'status', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', examples: ['op_...'] },
    type: { type: 'string', examples: ['products_csv'] },
    status: { type: 'string', enum: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'] },
    resultUrl: { type: ['string', 'null'] },
    error: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const collection = (item: string) => ({
  type: 'object',
  required: ['data', 'pagination'],
  properties: {
    data: { type: 'array', items: ref(item) },
    pagination: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        hasMore: { type: 'boolean' },
        nextCursor: { type: ['string', 'null'] },
        offset: { type: 'integer' },
        total: { type: 'integer' },
      },
    },
  },
});

export function buildOpenApiDocument() {
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
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'System' },
      { name: 'Products' },
      { name: 'Customers' },
      { name: 'Orders' },
      { name: 'Uploads' },
      { name: 'Exports' },
      { name: 'Webhooks' },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Liveness probe',
          security: [],
          responses: { '200': { description: 'Process is up.' } },
        },
      },
      '/v1/tenants/{tenantId}/products': {
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        get: {
          tags: ['Products'],
          summary: 'List products',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'active', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
            { name: 'minPriceCents', in: 'query', schema: { type: 'integer', minimum: 0 } },
            { name: 'maxPriceCents', in: 'query', schema: { type: 'integer', minimum: 0 } },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['createdAt', '-createdAt', 'name', '-name', 'priceCents', '-priceCents'] } },
            { name: 'fields', in: 'query', schema: { type: 'string' } },
            { $ref: '#/components/parameters/Limit' },
            { $ref: '#/components/parameters/Offset' },
            { $ref: '#/components/parameters/Cursor' },
            { $ref: '#/components/parameters/IncludeTotal' },
          ],
          responses: {
            '200': {
              description: 'A page of products.',
              content: { 'application/json': { schema: collection('Product') } },
            },
            '401': problemResponse('Missing or invalid token.'),
            '403': problemResponse('Token belongs to another tenant.'),
            '422': problemResponse('Invalid query parameters.'),
          },
          'x-zod-schema': jsonSchema(productListQuerySchema),
        },
        post: {
          tags: ['Products'],
          summary: 'Create a product',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('CreateProduct') } },
          },
          responses: {
            '201': {
              description: 'Created.',
              headers: { Location: { schema: { type: 'string' } } },
              content: { 'application/json': { schema: ref('Product') } },
            },
            '409': problemResponse('SKU or slug already exists.'),
            '422': problemResponse('Validation failed.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/products/bulk': {
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        patch: {
          tags: ['Products'],
          summary: 'Update prices in one all-or-nothing batch',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('BulkUpdate') } },
          },
          responses: {
            '200': { description: 'Every update applied.' },
            '422': problemResponse('At least one update failed; nothing was applied.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/products/{productId}': {
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { $ref: '#/components/parameters/ProductId' },
        ],
        get: {
          tags: ['Products'],
          summary: 'Get one product',
          responses: {
            '200': {
              description: 'The product. A strong ETag is returned.',
              headers: { ETag: { schema: { type: 'string' } } },
              content: { 'application/json': { schema: ref('Product') } },
            },
            '304': { description: 'If-None-Match matched.' },
            '404': problemResponse('Product not found in this tenant.'),
          },
        },
        put: {
          tags: ['Products'],
          summary: 'Replace a product',
          parameters: [{ $ref: '#/components/parameters/IfMatch' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('ReplaceProduct') } },
          },
          responses: {
            '200': { description: 'Replaced.' },
            '412': problemResponse('If-Match did not match the current version.'),
            '422': problemResponse('Validation failed.'),
          },
        },
        patch: {
          tags: ['Products'],
          summary: 'Partially update a product',
          parameters: [{ $ref: '#/components/parameters/IfMatch' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('PatchProduct') } },
          },
          responses: {
            '200': { description: 'Updated.' },
            '412': problemResponse('If-Match did not match the current version.'),
          },
        },
        delete: {
          tags: ['Products'],
          summary: 'Soft-delete a product',
          responses: {
            '204': { description: 'Deleted.' },
            '404': problemResponse('Product not found.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/customers': {
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        get: {
          tags: ['Customers'],
          summary: 'Search and filter customers',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['ACTIVE', 'BANNED'] } },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['createdAt', '-createdAt', 'name', '-name'] } },
            { $ref: '#/components/parameters/Limit' },
            { $ref: '#/components/parameters/Offset' },
            { $ref: '#/components/parameters/Cursor' },
            { $ref: '#/components/parameters/IncludeTotal' },
          ],
          responses: {
            '200': {
              description: 'A page of customers.',
              content: { 'application/json': { schema: collection('Customer') } },
            },
          },
          'x-zod-schema': jsonSchema(customerListQuerySchema),
        },
      },
      '/v1/tenants/{tenantId}/customers/{customerId}': {
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { $ref: '#/components/parameters/CustomerId' },
        ],
        get: {
          tags: ['Customers'],
          summary: 'Get one customer',
          responses: {
            '200': { description: 'The customer.', content: { 'application/json': { schema: ref('Customer') } } },
            '404': problemResponse('Customer not found.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/customers/{customerId}/ban': {
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { $ref: '#/components/parameters/CustomerId' },
        ],
        post: {
          tags: ['Customers'],
          summary: 'Ban a customer (idempotent)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: jsonSchema(banCustomerSchema) } },
          },
          responses: {
            '200': { description: 'Customer state after the call; changed=false when already banned.' },
            '403': problemResponse('Role not allowed.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/customers/{customerId}/unban': {
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { $ref: '#/components/parameters/CustomerId' },
        ],
        post: {
          tags: ['Customers'],
          summary: 'Unban a customer (idempotent)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['reason'],
                  properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } },
                  additionalProperties: false,
                },
              },
            },
          },
          responses: { '200': { description: 'Customer state after the call.' } },
        },
      },
      '/v1/tenants/{tenantId}/orders': {
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        post: {
          tags: ['Orders'],
          summary: 'Create an order (requires Idempotency-Key)',
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('CreateOrder') } },
          },
          responses: {
            '201': {
              description: 'Created, or replayed from the stored first response.',
              headers: {
                Location: { schema: { type: 'string' } },
                'Idempotent-Replayed': { schema: { type: 'string', enum: ['true'] } },
              },
              content: { 'application/json': { schema: ref('Order') } },
            },
            '400': problemResponse('Idempotency-Key header missing.'),
            '409': problemResponse('Idempotency key reused, insufficient stock, or banned customer.'),
            '422': problemResponse('Unknown customer or product.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/orders/{orderId}': {
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { $ref: '#/components/parameters/OrderId' },
        ],
        get: {
          tags: ['Orders'],
          summary: 'Get one order',
          responses: {
            '200': { description: 'The order.', content: { 'application/json': { schema: ref('Order') } } },
            '404': problemResponse('Order not found.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/orders/{orderId}/payments': {
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { $ref: '#/components/parameters/OrderId' },
        ],
        post: {
          tags: ['Orders'],
          summary: 'Pay an order (requires Idempotency-Key)',
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('CreatePayment') } },
          },
          responses: {
            '201': { description: 'Payment recorded; order becomes PAID.' },
            '409': problemResponse('Order is not PENDING.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/orders/{orderId}/coupon': {
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { $ref: '#/components/parameters/OrderId' },
        ],
        post: {
          tags: ['Orders'],
          summary: 'Apply a coupon to a pending order',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('ApplyCoupon') } },
          },
          responses: {
            '200': { description: 'Updated order.', content: { 'application/json': { schema: ref('Order') } } },
            '409': problemResponse('Coupon exhausted or order already has a coupon.'),
            '422': problemResponse('Coupon invalid, expired, or wrong currency.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/uploads': {
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        post: {
          tags: ['Uploads'],
          summary: 'Upload a product image (multipart/form-data, field "file")',
          parameters: [{ name: 'productId', in: 'query', schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: { file: { type: 'string', format: 'binary' } },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Stored; returns a tenant-scoped URL.' },
            '413': problemResponse('File exceeds 2 MiB.'),
            '415': problemResponse('Not a PNG, JPEG, or WebP image.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/uploads/{uploadId}': {
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { name: 'uploadId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        get: {
          tags: ['Uploads'],
          summary: 'Download an uploaded image',
          responses: {
            '200': { description: 'Image bytes.', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
            '404': problemResponse('Upload not found in this tenant.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/exports': {
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        post: {
          tags: ['Exports'],
          summary: 'Start a product CSV export',
          responses: {
            '202': {
              description: 'Accepted; poll the operation.',
              headers: { Location: { schema: { type: 'string' } }, 'Retry-After': { schema: { type: 'integer' } } },
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['operation'],
                    properties: { operation: ref('Operation') },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/tenants/{tenantId}/exports/{operationId}': {
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { name: 'operationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        get: {
          tags: ['Exports'],
          summary: 'Poll an export operation',
          responses: {
            '200': { description: 'Current state.', content: { 'application/json': { schema: ref('Operation') } } },
            '404': problemResponse('Operation not found.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/exports/{operationId}/result': {
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { name: 'operationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        get: {
          tags: ['Exports'],
          summary: 'Download the finished CSV',
          responses: {
            '200': { description: 'CSV file.', content: { 'text/csv': { schema: { type: 'string' } } } },
            '409': problemResponse('The export is not finished yet.'),
          },
        },
      },
      '/v1/tenants/{tenantId}/webhook-endpoints': {
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        get: {
          tags: ['Webhooks'],
          summary: 'List webhook endpoints (secrets never returned)',
          responses: { '200': { description: 'Endpoints.' } },
        },
        post: {
          tags: ['Webhooks'],
          summary: 'Register a webhook endpoint',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('WebhookEndpointCreate') } },
          },
          responses: {
            '201': { description: 'Created. The signing secret is returned only here.' },
          },
        },
      },
      '/v1/tenants/{tenantId}/webhook-endpoints/{endpointId}/deliveries': {
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        get: {
          tags: ['Webhooks'],
          summary: 'Inspect recent delivery attempts',
          responses: { '200': { description: 'Deliveries, newest first.' } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
      parameters: {
        TenantId: { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' }, examples: { acme: { value: 'ten_acme' } } },
        ProductId: { name: 'productId', in: 'path', required: true, schema: { type: 'string' } },
        CustomerId: { name: 'customerId', in: 'path', required: true, schema: { type: 'string' } },
        OrderId: { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
        Limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        Offset: { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
        Cursor: { name: 'cursor', in: 'query', schema: { type: 'string' } },
        IncludeTotal: { name: 'includeTotal', in: 'query', schema: { type: 'string', enum: ['true', 'false'], default: 'false' } },
        IfMatch: { name: 'If-Match', in: 'header', schema: { type: 'string' }, description: 'Strong ETag from a previous GET.' },
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          schema: { type: 'string', minLength: 8, maxLength: 200 },
        },
      },
      schemas: {
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status', 'detail', 'instance', 'code'],
          properties: {
            type: { type: 'string', format: 'uri' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            instance: { type: 'string' },
            code: { type: 'string', examples: ['validation_failed'] },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                required: ['pointer', 'code', 'message'],
                properties: {
                  pointer: { type: 'string', examples: ['/priceCents'] },
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        Product: product,
        CreateProduct: jsonSchema(createProductSchema),
        ReplaceProduct: jsonSchema(createProductSchema),
        PatchProduct: jsonSchema(patchProductSchema),
        BulkUpdate: jsonSchema(bulkUpdateSchema),
        Customer: customer,
        CreateOrder: jsonSchema(createOrderSchema),
        CreatePayment: jsonSchema(createPaymentSchema),
        ApplyCoupon: jsonSchema(applyCouponSchema),
        Order: order,
        Operation: operation,
        WebhookEndpointCreate: jsonSchema(webhookEndpointSchema),
      },
    },
  } as const;
}

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
