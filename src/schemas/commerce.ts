import { z } from 'zod';

export const createOrderSchema = z
  .object({
    customerId: z.string().min(1),
    items: z
      .array(
        z
          .object({
            productId: z.string().min(1),
            quantity: z.number().int().min(1).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export const createPaymentSchema = z
  .object({
    provider: z.enum(['fakepay']),
    providerRef: z.string().trim().min(3).max(100),
  })
  .strict();

export const applyCouponSchema = z
  .object({
    code: z.string().trim().min(3).max(40).transform((value) => value.toUpperCase()),
  })
  .strict();

export const webhookEndpointSchema = z
  .object({
    url: z.url().max(500),
  })
  .strict();

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, digits, dot, colon, underscore, or hyphen.');
