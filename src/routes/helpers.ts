import type { Request } from 'express';
import { HttpProblem } from '../http/problem.js';
import { etagFor } from '../http/cache.js';
import { productFields, type ProductField } from '../schemas/product.js';
import { productDto, type ProductDto, type ProductRecord } from '../store/types.js';

export function tenantIdOf(req: Request): string {
  if (!req.tenantId) throw new Error('tenant middleware did not run');
  return req.tenantId;
}

export function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing or invalid path parameter :${name}`);
  }
  return value;
}

// Returns the version the client thinks it is editing. If-Match is optional
// here so beginners can try PUT/PATCH first; chapter 13c explains why real
// clients should always send it.
export function expectedVersionFrom(req: Request, current: ProductRecord): number | undefined {
  const header = req.get('if-match');
  if (!header) return undefined;

  const currentEtag = etagFor(productDto(current));
  const candidates = header
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!candidates.includes(currentEtag) && !candidates.includes('*')) {
    throw new HttpProblem(412, 'precondition_failed', 'If-Match does not match the current resource.', {
      headers: { ETag: currentEtag },
      extensions: { currentVersion: current.version },
    });
  }
  return current.version;
}

export function parseFields(raw: string | undefined): Set<ProductField> | null {
  if (!raw) return null;
  const requested = raw.split(',').map((field) => field.trim()).filter(Boolean);
  const allowed = new Set<string>(productFields);
  const unknown = requested.filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new HttpProblem(422, 'invalid_fields', `Unknown fields: ${unknown.join(', ')}`, {
      title: 'Validation Failed',
      errors: unknown.map((field) => ({
        pointer: '/fields',
        code: 'unknown_field',
        message: `Unknown field "${field}".`,
      })),
    });
  }
  // id is always present so every item remains identifiable.
  return new Set(['id', ...requested] as ProductField[]);
}

export function selectFields(dto: ProductDto, fields: Set<ProductField> | null) {
  if (!fields) return dto;
  const full = dto as unknown as Record<string, unknown>;
  return Object.fromEntries([...fields].map((field) => [field, full[field]]));
}

export function assertPaginationMode(query: {
  cursor?: string | undefined;
  offset?: number | undefined;
  includeTotal: boolean;
  sort?: string | undefined;
}): void {
  if (query.cursor && query.offset !== undefined) {
    throw new HttpProblem(422, 'invalid_pagination', 'Use either cursor or offset, not both.', {
      title: 'Validation Failed',
      errors: [
        { pointer: '/cursor', code: 'mutually_exclusive', message: 'cursor and offset cannot be combined.' },
      ],
    });
  }
  if (query.cursor && query.includeTotal) {
    throw new HttpProblem(422, 'invalid_pagination', 'Total counts are only available with offset pagination.', {
      title: 'Validation Failed',
      errors: [
        { pointer: '/includeTotal', code: 'unsupported_with_cursor', message: 'Remove includeTotal or use offset.' },
      ],
    });
  }
  if (query.cursor && query.sort && query.sort !== '-createdAt') {
    throw new HttpProblem(422, 'invalid_pagination', 'Cursor pagination only supports sort=-createdAt.', {
      title: 'Validation Failed',
      errors: [
        { pointer: '/sort', code: 'unsupported_with_cursor', message: 'Use offset pagination for custom sorts.' },
      ],
    });
  }
}
