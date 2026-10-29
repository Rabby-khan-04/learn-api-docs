import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { PrismaStore } from './store/prisma.js';

const app = createApp(new PrismaStore(prisma), prisma);

const server = app.listen(config.port, () => {
  console.log(`api-learn (Prisma + PostgreSQL) listening on http://localhost:${config.port}`);
  console.log(`docs: http://localhost:${config.port}/docs`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
  });
}
