import { z } from 'zod';

const sku = z.string().trim().min(3).max(40).regex(/^[A-Z0-9-]+$/, 'Use uppercase letters, digits, and hyphens.');
const slug = z.string().trim().min(3).max(80).regex(/^[a-z0-9-]+$/, 'Use lowercase letters, digits, and hyphens.');
const name = z.string().trim().min(1).max(200);
const description = z.string().max(2000).nullable();
const priceCents = z.number().int().min(0).max(100_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter ISO 4217 code such as USD.');
const stock = z.number().int().min(0).max(1_000_000);
const active = z.boolean();

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

export const replaceProductSchema = createProductSchema;

export const patchProductSchema = z
  .object({
    sku: sku.optional(),
    slug: slug.optional(),
    name: name.optional(),
    description: description.optional(),
    priceCents: priceCents.optional(),
    currency: currency.optional(),
    stock: stock.optional(),
    active: active.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Send at least one field to update.',
  });

export const productListQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    active: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
    minPriceCents: z.coerce.number().int().min(0).optional(),
    maxPriceCents: z.coerce.number().int().min(0).optional(),
    sort: z
      .enum(['createdAt', '-createdAt', 'name', '-name', 'priceCents', '-priceCents'])
      .default('-createdAt'),
    fields: z.string().min(1).max(300).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).optional(),
    cursor: z.string().min(1).max(500).optional(),
    includeTotal: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict()
  .refine(
    (q) =>
      q.minPriceCents === undefined ||
      q.maxPriceCents === undefined ||
      q.minPriceCents <= q.maxPriceCents,
    { message: 'minPriceCents must be less than or equal to maxPriceCents.', path: ['minPriceCents'] },
  );

export const productFields = [
  'id', 'sku', 'slug', 'name', 'description', 'priceCents', 'currency',
  'stock', 'active', 'version', 'createdAt', 'updatedAt',
] as const;

export type ProductField = (typeof productFields)[number];

export const bulkUpdateSchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            id: z.string().min(1),
            priceCents,
            expectedVersion: z.number().int().min(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
