import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { CUSTOMERS, PRODUCTS, TENANTS } from '../src/data/seed-data.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Delete children first so foreign keys never block the reset.
  await prisma.couponRedemption.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.fraudEvent.deleteMany();
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.operation.deleteMany();
  await prisma.upload.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.product.deleteMany();
  await prisma.tenant.deleteMany();

  // Same seed module the in-memory store uses, so both servers expose
  // identical IDs and timestamps.
  await prisma.tenant.createMany({ data: TENANTS });
  await prisma.product.createMany({ data: PRODUCTS });
  await prisma.customer.createMany({ data: CUSTOMERS });

  // Two fixed pending orders so later chapters can refer to a known order ID
  // instead of depending on a random one from a previous run.
  await prisma.order.create({
    data: {
      id: 'ord_demo_pending',
      tenantId: 'ten_acme',
      customerId: 'cus_acme_03',
      status: 'PENDING',
      subtotalCents: 4999,
      discountCents: 0,
      totalCents: 4999,
      currency: 'USD',
      version: 1,
      createdAt: new Date(Date.UTC(2026, 0, 20, 9, 0, 0)),
    },
  });
  await prisma.orderItem.create({
    data: {
      id: 'oit_demo_pending',
      tenantId: 'ten_acme',
      orderId: 'ord_demo_pending',
      productId: 'prd_hoodie',
      skuSnapshot: 'HOO-001',
      nameSnapshot: 'Trail Hoodie',
      unitPriceCents: 4999,
      quantity: 1,
      lineTotalCents: 4999,
    },
  });
  await prisma.order.create({
    data: {
      id: 'ord_demo_payable',
      tenantId: 'ten_acme',
      customerId: 'cus_acme_04',
      status: 'PENDING',
      subtotalCents: 2598,
      discountCents: 0,
      totalCents: 2598,
      currency: 'USD',
      version: 1,
      createdAt: new Date(Date.UTC(2026, 0, 21, 9, 0, 0)),
    },
  });
  await prisma.orderItem.create({
    data: {
      id: 'oit_demo_payable',
      tenantId: 'ten_acme',
      orderId: 'ord_demo_payable',
      productId: 'prd_mug',
      skuSnapshot: 'MUG-001',
      nameSnapshot: 'Camp Mug',
      unitPriceCents: 1299,
      quantity: 2,
      lineTotalCents: 2598,
    },
  });

  // Coupon windows are relative to seed time so "expired" stays expired.
  const now = Date.now();
  const day = 86_400_000;
  await prisma.coupon.createMany({
    data: [
      {
        id: 'cpn_save10', tenantId: 'ten_acme', code: 'SAVE10', type: 'PERCENT',
        percentOff: 10, currency: 'USD', startsAt: new Date(now - 7 * day),
        endsAt: new Date(now + 30 * day), maxRedemptions: 1000,
      },
      {
        id: 'cpn_flat500', tenantId: 'ten_acme', code: 'FLAT500', type: 'FIXED',
        amountOffCents: 500, currency: 'USD', startsAt: new Date(now - 7 * day),
        endsAt: new Date(now + 30 * day), maxRedemptions: 1000,
      },
      {
        id: 'cpn_max1', tenantId: 'ten_acme', code: 'MAX1', type: 'FIXED',
        amountOffCents: 100, currency: 'USD', startsAt: new Date(now - day),
        endsAt: new Date(now + day), maxRedemptions: 1,
      },
      {
        id: 'cpn_expired', tenantId: 'ten_acme', code: 'EXPIRED10', type: 'PERCENT',
        percentOff: 10, currency: 'USD', startsAt: new Date(now - 60 * day),
        endsAt: new Date(now - 30 * day), maxRedemptions: 1000,
      },
      {
        id: 'cpn_eu10', tenantId: 'ten_globex', code: 'EU10', type: 'PERCENT',
        percentOff: 10, currency: 'EUR', startsAt: new Date(now - 7 * day),
        endsAt: new Date(now + 30 * day), maxRedemptions: 1000,
      },
    ],
  });

  await prisma.webhookEndpoint.create({
    data: {
      id: 'wh_acme',
      tenantId: 'ten_acme',
      url: process.env.WEBHOOK_RECEIVER_URL ?? 'http://localhost:4020/hooks/orders',
      secret: 'whsec_learn_acme',
      active: true,
    },
  });

  const counts = {
    tenants: await prisma.tenant.count(),
    products: await prisma.product.count(),
    customers: await prisma.customer.count(),
    coupons: await prisma.coupon.count(),
    webhookEndpoints: await prisma.webhookEndpoint.count(),
  };
  console.log('seed complete', counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
