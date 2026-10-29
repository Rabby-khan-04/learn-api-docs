import { createCoreApp } from './app.js';
import { config } from './config.js';
import { MemoryStore } from './store/memory.js';

// Chapters 1-10: no database, no orders/uploads/exports/webhooks. Data resets
// on every restart, which keeps early examples small and reproducible.
const app = createCoreApp(new MemoryStore());

const server = app.listen(config.port, () => {
  console.log(`api-learn (in-memory) listening on http://localhost:${config.port}`);
  console.log(`docs: http://localhost:${config.port}/docs`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
