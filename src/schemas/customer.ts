import { z } from 'zod';

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

export const banCustomerSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const unbanCustomerSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
