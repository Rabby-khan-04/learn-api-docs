import { createHmac } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { iso } from '../lib/format.js';
import { newId } from '../lib/ids.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

// Fire-and-forget delivery with in-process retries. A production system would
// persist nextAttemptAt and let a worker retry with exponential backoff.
export async function deliverEvent(
  prisma: PrismaClient,
  tenantId: string,
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { tenantId, active: true } });
  if (endpoints.length === 0) return;

  const eventId = newId('evt');
  const payload = { id: eventId, type: eventType, createdAt: iso(new Date()), data };

  for (const endpoint of endpoints) {
    const delivery = await prisma.webhookDelivery.create({
      data: {
        id: newId('whd'),
        tenantId,
        endpointId: endpoint.id,
        eventId,
        eventType,
        payload: payload as unknown as Prisma.InputJsonValue,
        status: 'PENDING',
      },
    });
    void attempt(prisma, delivery.id, endpoint.url, endpoint.secret, payload).catch((error) => {
      console.error('webhook delivery crashed', error);
    });
  }
}

async function attempt(
  prisma: PrismaClient,
  deliveryId: string,
  url: string,
  secret: string,
  payload: unknown,
): Promise<void> {
  const rawBody = JSON.stringify(payload);
  let lastError = '';

  for (let attemptNo = 1; attemptNo <= 3; attemptNo += 1) {
    const timestamp = Math.floor(Date.now() / 1000);
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { attempts: attemptNo, lastError: lastError || null },
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-event': String((payload as { type: string }).type),
          'x-webhook-event-id': String((payload as { id: string }).id),
          'x-webhook-delivery': deliveryId,
          'x-webhook-signature': `t=${timestamp},v1=${signWebhook(secret, timestamp, rawBody)}`,
        },
        body: rawBody,
        signal: AbortSignal.timeout(2000),
      });

      if (response.ok) {
        await prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: { status: 'DELIVERED', deliveredAt: new Date(), lastError: null },
        });
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'delivery failed';
    }

    if (attemptNo < 3) await sleep(300 * attemptNo);
  }

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: 'FAILED', lastError },
  });
}
