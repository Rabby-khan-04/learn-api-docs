export type AuthRole = 'ADMIN' | 'SUPPORT' | 'PLATFORM_ADMIN' | 'DEVELOPMENT';

export type AuthContext = {
  subject: string;
  // null only for the platform admin, which may act on any tenant.
  tenantId: string | null;
  role: AuthRole;
};

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      tenantId?: string;
    }
  }
}

export {};
