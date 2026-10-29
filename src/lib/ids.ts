import { randomUUID } from 'node:crypto';

// Prefixed, opaque IDs. The prefix tells humans what the ID is; the random
// suffix stops clients from guessing neighbors or parsing meaning out of it.
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
