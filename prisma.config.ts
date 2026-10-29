// Prisma 7 configuration: the datasource URL lives here, not in schema.prisma.
// dotenv is not loaded automatically by Prisma 7, so load it first.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const rawUrl = process.env.DATABASE_URL ?? '';
const url = new URL(rawUrl);
const allowed =
  ['postgresql:', 'postgres:'].includes(url.protocol) &&
  ['localhost', '127.0.0.1', '::1'].includes(url.hostname) &&
  url.port === '5434' &&
  url.pathname === '/api_learn' &&
  url.username === 'postgres';

if (!allowed) {
  throw new Error('REFUSING TO RUN: DATABASE_URL must be postgresql://postgres:***@localhost:5434/api_learn');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: rawUrl,
  },
});
