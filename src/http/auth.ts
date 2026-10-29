import type { NextFunction, Request, Response } from 'express';
import type { AuthContext, AuthRole } from '../types/express.js';
import { forbidden, unauthorized } from './problem.js';
import { config } from '../config.js';

// Demo-only tokens. A real system validates JWTs or opaque tokens issued by
// its identity provider and maps them to a tenant + role.
const TOKENS: Record<string, AuthContext> = {
  tok_acme_admin: { subject: 'user_acme_admin', tenantId: 'ten_acme', role: 'ADMIN' },
  tok_acme_support: { subject: 'user_acme_support', tenantId: 'ten_acme', role: 'SUPPORT' },
  tok_globex_admin: { subject: 'user_globex_admin', tenantId: 'ten_globex', role: 'ADMIN' },
  tok_platform: { subject: 'user_platform', tenantId: null, role: 'PLATFORM_ADMIN' },
};

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  if (!config.authEnabled) {
    // DANGER DEMO for chapters 1-16: any caller can pick any tenant.
    req.auth = { subject: 'tutorial', tenantId: null, role: 'DEVELOPMENT' };
    next();
    return;
  }

  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized('A Bearer token is required.');
  }
  const token = header.slice('Bearer '.length).trim();
  const principal = TOKENS[token];
  if (!principal) throw unauthorized('The Bearer token is invalid.');
  req.auth = principal;
  next();
}

export function requireRole(...roles: AuthRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!config.authEnabled) {
      next();
      return;
    }
    const role = req.auth?.role;
    if (!role || !roles.includes(role)) {
      throw forbidden(`This action requires one of these roles: ${roles.join(', ')}.`);
    }
    next();
  };
}

// Enforces both isolation and existence. A tenant token may never act on
// another tenant, even when it knows that tenant's ID.
export function tenantScope(tenantExists: (tenantId: string) => Promise<boolean>) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const tenantId = req.params.tenantId;
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new Error('tenantScope mounted without a :tenantId parameter');
    }

    if (!config.authEnabled) {
      // DANGER DEMO for chapters 1-16: no token, no tenant ownership check.
      // The tenant still has to exist, but any caller can pick any tenant.
      if (!(await tenantExists(tenantId))) {
        throw forbidden('This token is not allowed to access that tenant.');
      }
      req.tenantId = tenantId;
      next();
      return;
    }

    const auth = req.auth;
    if (!auth) throw unauthorized('Authentication is required.');
    if (auth.role !== 'PLATFORM_ADMIN' && auth.tenantId !== tenantId) {
      throw forbidden('This token is not allowed to access that tenant.');
    }
    if (!(await tenantExists(tenantId))) {
      throw forbidden('This token is not allowed to access that tenant.');
    }
    req.tenantId = tenantId;
    next();
  };
}
