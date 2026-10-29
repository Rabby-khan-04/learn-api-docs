// Safety gate for every Prisma command in this learning project.
// It refuses to continue unless DATABASE_URL points at the local throwaway DB.
import 'dotenv/config';

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_PORT = '5434';
const ALLOWED_DATABASE = 'api_learn';
const ALLOWED_USER = 'postgres';

let url;
try {
  url = new URL(process.env.DATABASE_URL ?? '');
} catch {
  console.error('REFUSING TO RUN: DATABASE_URL is missing or is not a valid URL.');
  process.exit(1);
}

const problems = [];
if (!['postgresql:', 'postgres:'].includes(url.protocol)) problems.push('protocol must be postgresql:');
if (!ALLOWED_HOSTS.has(url.hostname)) problems.push(`host must be localhost/127.0.0.1 (got ${url.hostname})`);
if (url.port !== ALLOWED_PORT) problems.push(`port must be ${ALLOWED_PORT} (got ${url.port || 'default'})`);
if (url.pathname !== `/${ALLOWED_DATABASE}`) problems.push(`database must be ${ALLOWED_DATABASE} (got ${url.pathname})`);
if (url.username !== ALLOWED_USER) problems.push(`user must be ${ALLOWED_USER} (got ${url.username})`);

if (problems.length > 0) {
  console.error('REFUSING TO RUN: DATABASE_URL is not the approved throwaway database.');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('Fix .env: it must point at localhost:5434/api_learn only.');
  process.exit(1);
}

console.log(`DATABASE_URL guard OK -> ${url.username}@${url.hostname}:${url.port}${url.pathname}`);
