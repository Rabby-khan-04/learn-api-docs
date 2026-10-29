import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

export type ProblemFieldError = {
  pointer: string;
  code: string;
  message: string;
};

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

// A thrown problem carries everything the response needs. Route code never
// builds error JSON by hand; one middleware owns the wire format.
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly options: {
      title?: string;
      type?: string;
      errors?: ProblemFieldError[];
      headers?: Record<string, string>;
      extensions?: Record<string, unknown>;
    } = {},
  ) {
    super(detail);
    this.name = 'HttpProblem';
  }
}

export function problemBody(req: Request, error: HttpProblem) {
  const base = {
    type: error.options.type ?? `https://api-learn.example/problems/${error.code}`,
    title: error.options.title ?? TITLES[error.status] ?? 'Error',
    status: error.status,
    detail: error.detail,
    instance: req.originalUrl,
    code: error.code,
    ...(error.options.errors ? { errors: error.options.errors } : {}),
    ...error.options.extensions,
  };
  return base;
}

function pointerFor(path: PropertyKey[]): string {
  if (path.length === 0) return '';
  return `/${path
    .map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1'))
    .join('/')}`;
}

export function fieldErrors(error: ZodError): ProblemFieldError[] {
  return error.issues.map((issue) => ({
    pointer: pointerFor(issue.path),
    code: issue.code,
    message: issue.message,
  }));
}

export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpProblem(422, 'validation_failed', 'One or more fields are invalid.', {
      title: 'Validation Failed',
      errors: fieldErrors(result.error),
    });
  }
  return result.data;
}

export function notFound(detail: string): HttpProblem {
  return new HttpProblem(404, 'not_found', detail);
}

export function conflict(code: string, detail: string): HttpProblem {
  return new HttpProblem(409, code, detail);
}

export function forbidden(detail: string): HttpProblem {
  return new HttpProblem(403, 'forbidden', detail);
}

export function unauthorized(detail: string): HttpProblem {
  return new HttpProblem(401, 'invalid_token', detail, {
    headers: { 'WWW-Authenticate': 'Bearer realm="api-learn", error="invalid_token"' },
  });
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }

  if (error instanceof HttpProblem) {
    if (error.options.headers) res.set(error.options.headers);
    res.status(error.status).type('application/problem+json').json(problemBody(req, error));
    return;
  }

  // body-parser reports malformed JSON with this marker.
  if (
    error instanceof SyntaxError &&
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.parse.failed'
  ) {
    const malformed = new HttpProblem(400, 'malformed_json', 'The request body is not valid JSON.');
    res.status(malformed.status).type('application/problem+json').json(problemBody(req, malformed));
    return;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.too.large'
  ) {
    const tooLarge = new HttpProblem(413, 'body_too_large', 'The request body is too large.');
    res.status(tooLarge.status).type('application/problem+json').json(problemBody(req, tooLarge));
    return;
  }

  // Never expose stack traces or database errors. Log them server-side only.
  console.error(`[${req.requestId}] unhandled error`, error);
  const internal = new HttpProblem(500, 'internal_error', 'An unexpected error occurred.');
  res.status(500).type('application/problem+json').json(problemBody(req, internal));
}

export function notFoundHandler(req: Request, res: Response): void {
  const error = notFound(`No route matches ${req.method} ${req.path}.`);
  res.status(404).type('application/problem+json').json(problemBody(req, error));
}
