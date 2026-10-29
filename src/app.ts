import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import express, { Router, type Express } from 'express';
import type { PrismaClient } from './generated/prisma/client.js';
import { config } from './config.js';
import { newId } from './lib/ids.js';
import { authenticate, tenantScope } from './http/auth.js';
import { rateLimit } from './http/rate-limit.js';
import { requestId } from './http/request-id.js';
import { errorHandler, notFoundHandler } from './http/problem.js';
import { buildOpenApiDocument } from './openapi.js';
import { customersRouter } from './routes/customers.js';
import { productsRouter } from './routes/products.js';
import { ordersRouter } from './routes/orders.js';
import { uploadsRouter } from './routes/uploads.js';
import { exportsRouter } from './routes/exports.js';
import { webhookEndpointsRouter } from './routes/webhook-endpoints.js';
import type { Store } from './store/types.js';

function tenantRouter(store: Store, prisma?: PrismaClient): Router {
  const router = Router({ mergeParams: true });
  router.use('/products', productsRouter(store));

  const hooks = prisma
    ? {
        onFraudEvent: async (event: {
          tenantId: string;
          customerId: string;
          action: 'BAN' | 'UNBAN';
          reason: string;
          actor: string;
        }) => {
          await prisma.fraudEvent.create({
            data: {
              id: newId('fre'),
              tenantId: event.tenantId,
              customerId: event.customerId,
              action: event.action,
              reason: event.reason,
              actor: event.actor,
            },
          });
        },
      }
    : {};
  router.use('/customers', customersRouter(store, hooks));

  if (prisma) {
    router.use('/orders', ordersRouter(prisma));
    router.use('/uploads', uploadsRouter(prisma, store));
    router.use('/exports', exportsRouter(prisma, store));
    router.use('/webhook-endpoints', webhookEndpointsRouter(prisma));
  }

  return router;
}

function systemRoutes(app: Express): void {
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/openapi.json', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json(buildOpenApiDocument());
  });

  const require = createRequire(import.meta.url);
  const swaggerDir = dirname(require.resolve('swagger-ui-dist/package.json'));
  app.use('/docs-assets', express.static(swaggerDir, { index: false, maxAge: '1h' }));
  app.get('/docs', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>api-learn API docs</title>
    <link rel="stylesheet" href="/docs-assets/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs-assets/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true });
    </script>
  </body>
</html>`);
  });
}

// Deprecated alias demo: same handlers, older path. RFC 9745 Deprecation and
// RFC 8594 Sunset let clients discover the end date programmatically.
function legacyDeprecation(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!config.legacyDeprecationHeaders) {
    next();
    return;
  }
  res.set({
    Deprecation: '@1798761599',
    Sunset: 'Thu, 31 Dec 2026 23:59:59 GMT',
    Link: '<http://localhost:4010/openapi.json>; rel="deprecation"; type="application/json"',
  });
  next();
}

function build(store: Store, prisma?: PrismaClient): Express {
  const app = express();
  app.disable('x-powered-by');
  // We set strong, content-derived ETags ourselves; Express's weak default
  // would double up on cached responses.
  app.set('etag', false);

  app.use(requestId);
  app.use(express.json({ limit: '100kb' }));

  systemRoutes(app);

  const v1 = Router();
  v1.use(
    '/tenants/:tenantId',
    authenticate,
    tenantScope((id) => store.tenantExists(id)),
    rateLimit,
    tenantRouter(store, prisma),
  );
  app.use('/v1', v1);
  app.use('/api', legacyDeprecation, v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

// Chapters 1-10 use the in-memory store; from chapter 11 the same route code
// runs on Prisma. Only the store implementation changes.
export function createCoreApp(store: Store): Express {
  return build(store);
}

export function createApp(store: Store, prisma: PrismaClient): Express {
  return build(store, prisma);
}
