import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { HttpProblem } from '../http/problem.js';
import { iso } from '../lib/format.js';
import { newId } from '../lib/ids.js';
import { runIdempotent } from './idempotency.js';

export type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;
export type PaymentRecord = Prisma.PaymentGetPayload<Record<string, never>>;

export function orderDto(order: OrderWithItems) {
  return {
    id: order.id,
    status: order.status,
    customerId: order.customerId,
    items: order.items.map((item) => ({
      productId: item.productId,
      sku: item.skuSnapshot,
      name: item.nameSnapshot,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      lineTotalCents: item.lineTotalCents,
    })),
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    currency: order.currency,
    couponCode: order.couponCode,
    version: order.version,
    createdAt: iso(order.createdAt),
    updatedAt: iso(order.updatedAt),
  };
}

export function paymentDto(payment: PaymentRecord) {
  return {
    id: payment.id,
    orderId: payment.orderId,
    status: payment.status,
    amountCents: payment.amountCents,
    currency: payment.currency,
    provider: payment.provider,
    providerRef: payment.providerRef,
    createdAt: iso(payment.createdAt),
  };
}

export async function createOrder(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    idempotencyKey: string;
    path: string;
    body: { customerId: string; items: { productId: string; quantity: number }[] };
  },
) {
  const quantities = new Map<string, number>();
  for (const item of input.body.items) {
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  }

  return runIdempotent(prisma, {
    tenantId: input.tenantId,
    key: input.idempotencyKey,
    method: 'POST',
    path: input.path,
    body: input.body,
    execute: async (idempotencyRowId) => {
      const order = await prisma.$transaction(async (tx) => {
        const customer = await tx.customer.findFirst({
          where: { id: input.body.customerId, tenantId: input.tenantId },
        });
        if (!customer) throw new HttpProblem(422, 'invalid_customer', 'Customer does not exist for this tenant.');
        if (customer.bannedAt) {
          throw new HttpProblem(409, 'customer_banned', 'Banned customers cannot place new orders.');
        }

        const productIds = [...quantities.keys()];
        const products = await tx.product.findMany({
          where: { tenantId: input.tenantId, id: { in: productIds }, deletedAt: null },
        });
        if (products.length !== productIds.length) {
          throw new HttpProblem(422, 'invalid_product', 'One or more products do not exist for this tenant.');
        }

        let currency: string | null = null;
        let subtotalCents = 0;
        const lines = products.map((product) => {
          if (!product.active) {
            throw new HttpProblem(409, 'product_inactive', `Product ${product.id} is not available.`);
          }
          if (currency !== null && product.currency !== currency) {
            throw new HttpProblem(409, 'currency_mismatch', 'All items in an order must use one currency.');
          }
          currency = product.currency;
          const quantity = quantities.get(product.id)!;
          const lineTotalCents = product.priceCents * quantity;
          subtotalCents += lineTotalCents;
          return { product, quantity, lineTotalCents };
        });

        // Conditional decrement prevents overselling under concurrency.
        for (const line of lines) {
          const reserved = await tx.product.updateMany({
            where: {
              id: line.product.id,
              tenantId: input.tenantId,
              deletedAt: null,
              active: true,
              stock: { gte: line.quantity },
            },
            data: { stock: { decrement: line.quantity }, version: { increment: 1 } },
          });
          if (reserved.count === 0) {
            throw new HttpProblem(409, 'insufficient_stock', `Not enough stock for ${line.product.id}.`);
          }
        }

        const orderId = newId('ord');
        await tx.order.create({
          data: {
            id: orderId,
            tenantId: input.tenantId,
            customerId: customer.id,
            subtotalCents,
            discountCents: 0,
            totalCents: subtotalCents,
            currency: currency ?? 'USD',
            idempotencyKeyId: idempotencyRowId,
          },
        });
        await tx.orderItem.createMany({
          data: lines.map((line) => ({
            id: newId('oit'),
            tenantId: input.tenantId,
            orderId,
            productId: line.product.id,
            skuSnapshot: line.product.sku,
            nameSnapshot: line.product.name,
            unitPriceCents: line.product.priceCents,
            quantity: line.quantity,
            lineTotalCents: line.lineTotalCents,
          })),
        });
        return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
      });

      return { status: 201, body: orderDto(order) };
    },
  });
}

export async function createPayment(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    orderId: string;
    idempotencyKey: string;
    path: string;
    body: { provider: 'fakepay'; providerRef: string };
  },
) {
  return runIdempotent(prisma, {
    tenantId: input.tenantId,
    key: input.idempotencyKey,
    method: 'POST',
    path: input.path,
    body: input.body,
    execute: async () => {
      const payment = await prisma.$transaction(async (tx) => {
        const order = await tx.order.findFirst({
          where: { id: input.orderId, tenantId: input.tenantId },
        });
        if (!order) throw new HttpProblem(404, 'not_found', 'Order not found.');
        if (order.status !== 'PENDING') {
          throw new HttpProblem(409, 'invalid_order_state', `Order is ${order.status}, not PENDING.`);
        }

        const created = await tx.payment.create({
          data: {
            id: newId('pay'),
            tenantId: input.tenantId,
            orderId: order.id,
            amountCents: order.totalCents,
            currency: order.currency,
            status: 'SUCCEEDED',
            provider: input.body.provider,
            providerRef: input.body.providerRef,
          },
        });
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'PAID', version: { increment: 1 } },
        });
        return created;
      });
      return { status: 201, body: paymentDto(payment) };
    },
  });
}

export async function applyCoupon(
  prisma: PrismaClient,
  input: { tenantId: string; orderId: string; code: string },
): Promise<ReturnType<typeof orderDto>> {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: input.orderId, tenantId: input.tenantId },
      include: { items: true },
    });
    if (!order) throw new HttpProblem(404, 'not_found', 'Order not found.');
    if (order.status !== 'PENDING') {
      throw new HttpProblem(409, 'invalid_order_state', `Order is ${order.status}, not PENDING.`);
    }
    if (order.couponId) {
      throw new HttpProblem(409, 'coupon_already_applied', 'This order already has a coupon.');
    }

    const coupon = await tx.coupon.findFirst({
      where: { tenantId: input.tenantId, code: input.code },
    });
    const now = new Date();
    // Do not reveal whether a coupon exists in another tenant or in the future.
    if (
      !coupon ||
      !coupon.active ||
      coupon.startsAt > now ||
      coupon.endsAt < now ||
      coupon.currency !== order.currency
    ) {
      throw new HttpProblem(422, 'invalid_coupon', 'The coupon cannot be applied to this order.');
    }

    const discountCents =
      coupon.type === 'PERCENT'
        ? Math.round((order.subtotalCents * (coupon.percentOff ?? 0)) / 100)
        : Math.min(coupon.amountOffCents ?? 0, order.subtotalCents);

    // Atomic cap: only one transaction can consume the last redemption.
    const consumed = await tx.coupon.updateMany({
      where: {
        id: coupon.id,
        tenantId: input.tenantId,
        active: true,
        redemptionCount: { lt: coupon.maxRedemptions },
      },
      data: { redemptionCount: { increment: 1 } },
    });
    if (consumed.count === 0) {
      throw new HttpProblem(409, 'coupon_exhausted', 'This coupon has reached its redemption limit.');
    }

    const updatedOrder = await tx.order.updateMany({
      where: {
        id: order.id,
        tenantId: input.tenantId,
        status: 'PENDING',
        couponId: null,
      },
      data: {
        couponId: coupon.id,
        couponCode: coupon.code,
        discountCents,
        totalCents: order.subtotalCents - discountCents,
        version: { increment: 1 },
      },
    });
    if (updatedOrder.count === 0) {
      throw new HttpProblem(409, 'coupon_already_applied', 'This order already has a coupon.');
    }

    await tx.couponRedemption.create({
      data: {
        id: newId('red'),
        tenantId: input.tenantId,
        couponId: coupon.id,
        orderId: order.id,
        customerId: order.customerId,
      },
    });

    return tx.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
  });

  return orderDto(updated);
}
