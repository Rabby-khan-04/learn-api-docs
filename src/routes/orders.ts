import { Router } from 'express';
import type { PrismaClient } from '../generated/prisma/client.js';
import { noStore } from '../http/cache.js';
import { HttpProblem, notFound, parseInput } from '../http/problem.js';
import { requireRole } from '../http/auth.js';
import { idempotencyKeySchema, applyCouponSchema, createOrderSchema, createPaymentSchema } from '../schemas/commerce.js';
import { createOrder, createPayment, applyCoupon, orderDto, type OrderWithItems } from '../services/orders.js';
import { deliverEvent } from '../services/webhooks.js';
import { pathParam, tenantIdOf } from './helpers.js';

function idempotencyKeyFrom(req: Parameters<typeof tenantIdOf>[0]): string {
  const header = req.get('idempotency-key');
  if (!header) {
    throw new HttpProblem(
      400,
      'idempotency_key_required',
      'Send an Idempotency-Key header so a retry cannot create a duplicate.',
    );
  }
  return parseInput(idempotencyKeySchema, header);
}

export function ordersRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });

  router.post('/', requireRole('ADMIN', 'SUPPORT', 'PLATFORM_ADMIN'), async (req, res) => {
    const tenantId = tenantIdOf(req);
    const key = idempotencyKeyFrom(req);
    const body = parseInput(createOrderSchema, req.body);
    const result = await createOrder(prisma, {
      tenantId,
      idempotencyKey: key,
      path: req.originalUrl.split('?')[0] ?? req.path,
      body,
    });

    if (result.replayed) res.set('Idempotent-Replayed', 'true');
    res.set('Cache-Control', 'no-store');
    const order = result.body as { id: string };
    res.status(result.status).location(`${req.baseUrl}/${order.id}`).json(result.body);

    if (!result.replayed) {
      const dto = result.body as ReturnType<typeof orderDto>;
      void deliverEvent(prisma, tenantId, 'order.created', {
        orderId: dto.id,
        customerId: dto.customerId,
        totalCents: dto.totalCents,
        currency: dto.currency,
      });
    }
  });

  router.get('/:orderId', async (req, res) => {
    const tenantId = tenantIdOf(req);
    const order = await prisma.order.findFirst({
      where: { id: pathParam(req, 'orderId'), tenantId },
      include: { items: true },
    });
    if (!order) throw notFound('Order not found.');
    noStore(res);
    res.status(200).json(orderDto(order as OrderWithItems));
  });

  router.post('/:orderId/payments', requireRole('ADMIN', 'SUPPORT', 'PLATFORM_ADMIN'), async (req, res) => {
    const tenantId = tenantIdOf(req);
    const key = idempotencyKeyFrom(req);
    const body = parseInput(createPaymentSchema, req.body);
    const result = await createPayment(prisma, {
      tenantId,
      orderId: pathParam(req, 'orderId'),
      idempotencyKey: key,
      path: req.originalUrl.split('?')[0] ?? req.path,
      body,
    });

    if (result.replayed) res.set('Idempotent-Replayed', 'true');
    res.set('Cache-Control', 'no-store');
    res.status(result.status).json(result.body);

    if (!result.replayed) {
      const payment = result.body as { orderId: string; amountCents: number; currency: string };
      void deliverEvent(prisma, tenantId, 'order.paid', {
        orderId: payment.orderId,
        amountCents: payment.amountCents,
        currency: payment.currency,
      });
    }
  });

  router.post('/:orderId/coupon', requireRole('ADMIN', 'SUPPORT', 'PLATFORM_ADMIN'), async (req, res) => {
    const tenantId = tenantIdOf(req);
    const body = parseInput(applyCouponSchema, req.body);
    const order = await applyCoupon(prisma, {
      tenantId,
      orderId: pathParam(req, 'orderId'),
      code: body.code,
    });
    noStore(res);
    res.status(200).json(order);
  });

  return router;
}
