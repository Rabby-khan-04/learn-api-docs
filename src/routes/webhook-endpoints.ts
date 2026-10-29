import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { PrismaClient } from '../generated/prisma/client.js';
import { noStore } from '../http/cache.js';
import { notFound, parseInput } from '../http/problem.js';
import { requireRole } from '../http/auth.js';
import { webhookEndpointSchema } from '../schemas/commerce.js';
import { iso } from '../lib/format.js';
import { newId } from '../lib/ids.js';
import { pathParam, tenantIdOf } from './helpers.js';

export function webhookEndpointsRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });

  router.post('/', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
    const tenantId = tenantIdOf(req);
    const body = parseInput(webhookEndpointSchema, req.body);
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        id: newId('whe'),
        tenantId,
        url: body.url,
        secret: `whsec_${randomBytes(24).toString('base64url')}`,
      },
    });

    noStore(res);
    res.status(201).location(`/v1/tenants/${tenantId}/webhook-endpoints/${endpoint.id}`).json({
      id: endpoint.id,
      url: endpoint.url,
      active: endpoint.active,
      // Shown once, at creation. List responses never include it.
      secret: endpoint.secret,
      createdAt: iso(endpoint.createdAt),
    });
  });

  router.get('/', async (req, res) => {
    const tenantId = tenantIdOf(req);
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
    noStore(res);
    res.status(200).json({
      data: endpoints.map((endpoint) => ({
        id: endpoint.id,
        url: endpoint.url,
        active: endpoint.active,
        createdAt: iso(endpoint.createdAt),
      })),
    });
  });

  router.get('/:endpointId/deliveries', async (req, res) => {
    const tenantId = tenantIdOf(req);
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { id: pathParam(req, 'endpointId'), tenantId },
    });
    if (!endpoint) throw notFound('Webhook endpoint not found.');

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { tenantId, endpointId: endpoint.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    noStore(res);
    res.status(200).json({
      data: deliveries.map((delivery) => ({
        id: delivery.id,
        eventId: delivery.eventId,
        eventType: delivery.eventType,
        status: delivery.status,
        attempts: delivery.attempts,
        lastError: delivery.lastError,
        createdAt: iso(delivery.createdAt),
        deliveredAt: delivery.deliveredAt ? iso(delivery.deliveredAt) : null,
      })),
    });
  });

  router.get('/:endpointId', async (req, res) => {
    const tenantId = tenantIdOf(req);
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { id: pathParam(req, 'endpointId'), tenantId },
    });
    if (!endpoint) throw notFound('Webhook endpoint not found.');
    noStore(res);
    res.status(200).json({
      id: endpoint.id,
      url: endpoint.url,
      active: endpoint.active,
      createdAt: iso(endpoint.createdAt),
    });
  });

  return router;
}
