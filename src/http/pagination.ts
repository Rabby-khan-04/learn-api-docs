import { z } from 'zod';
import { HttpProblem } from './problem.js';

export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).optional(),
    cursor: z.string().min(1).max(500).optional(),
    includeTotal: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export type ListQuery = z.infer<typeof listQuerySchema>;

export type PageMeta = {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
  offset?: number;
  total?: number;
};

export type CursorPayload = {
  createdAt: string;
  id: string;
};

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    const result = z
      .object({ createdAt: z.iso.datetime(), id: z.string().min(1) })
      .strict()
      .safeParse(parsed);
    if (!result.success) throw new Error('bad shape');
    return result.data;
  } catch {
    throw new HttpProblem(422, 'invalid_cursor', 'The cursor is malformed. Use nextCursor from the previous page.', {
      title: 'Validation Failed',
      errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Cursor is not valid.' }],
    });
  }
}

export function pageMeta(
  result: { hasMore: boolean; nextCursor?: string | null; total?: number },
  query: ListQuery,
): PageMeta {
  return {
    limit: query.limit,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor ?? null,
    ...(query.offset !== undefined ? { offset: query.offset } : {}),
    ...(result.total !== undefined ? { total: result.total } : {}),
  };
}
