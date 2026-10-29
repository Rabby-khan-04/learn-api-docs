import { Router } from 'express';
import { noStore } from '../http/cache.js';
import { notFound, parseInput } from '../http/problem.js';
import { pageMeta } from '../http/pagination.js';
import { requireRole } from '../http/auth.js';
import {
  banCustomerSchema,
  customerListQuerySchema,
  unbanCustomerSchema,
} from '../schemas/customer.js';
import { customerDto, type Store } from '../store/types.js';
import { assertPaginationMode, pathParam, tenantIdOf } from './helpers.js';

type FraudHook = (event: {
  tenantId: string;
  customerId: string;
  action: 'BAN' | 'UNBAN';
  reason: string;
  actor: string;
}) => Promise<void>;

export function customersRouter(store: Store, hooks: { onFraudEvent?: FraudHook } = {}): Router {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res) => {
    const tenantId = tenantIdOf(req);
    const query = parseInput(customerListQuerySchema, req.query);
    assertPaginationMode(query);
    const result = await store.listCustomers(tenantId, {
      q: query.q,
      status: query.status,
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
      cursor: query.cursor,
      includeTotal: query.includeTotal,
    });
    noStore(res);
    res.status(200).json({
      data: result.items.map(customerDto),
      pagination: pageMeta(result, {
        limit: query.limit,
        offset: query.offset,
        cursor: query.cursor,
        includeTotal: query.includeTotal,
      }),
    });
  });

  router.get('/:customerId', async (req, res) => {
    const tenantId = tenantIdOf(req);
    const customer = await store.findCustomer(tenantId, pathParam(req, 'customerId'));
    if (!customer) throw notFound('Customer not found.');
    noStore(res);
    res.status(200).json(customerDto(customer));
  });

  for (const [path, action, schema] of [
    ['ban', 'BAN', banCustomerSchema],
    ['unban', 'UNBAN', unbanCustomerSchema],
  ] as const) {
    router.post(`/:customerId/${path}`, requireRole('ADMIN', 'SUPPORT', 'PLATFORM_ADMIN'), async (req, res) => {
      const tenantId = tenantIdOf(req);
      const body = parseInput(schema, req.body);
      const result = await store.setCustomerBan(tenantId, pathParam(req, 'customerId'), action, body.reason);
      if (!result) throw notFound('Customer not found.');

      // Audit only real transitions; a repeated request is a safe no-op.
      if (result.changed && hooks.onFraudEvent) {
        await hooks.onFraudEvent({
          tenantId,
          customerId: result.customer.id,
          action,
          reason: body.reason,
          actor: req.auth?.subject ?? 'unknown',
        });
      }

      noStore(res);
      res.status(200).json({ customer: customerDto(result.customer), changed: result.changed });
    });
  }

  return router;
}
