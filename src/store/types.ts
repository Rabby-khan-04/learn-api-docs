import type { SeedCustomer, SeedProduct } from '../data/seed-data.js';
import { iso } from '../lib/format.js';

export type ProductRecord = SeedProduct & {
  version: number;
  updatedAt: Date;
  deletedAt: Date | null;
};

export type ProductWrite = {
  sku: string;
  slug: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  stock: number;
  active: boolean;
};

export type ProductPatch = {
  sku?: string | undefined;
  slug?: string | undefined;
  name?: string | undefined;
  description?: string | null | undefined;
  priceCents?: number | undefined;
  currency?: string | undefined;
  stock?: number | undefined;
  active?: boolean | undefined;
};

export type ProductListOptions = {
  q?: string | undefined;
  active?: boolean | undefined;
  minPriceCents?: number | undefined;
  maxPriceCents?: number | undefined;
  sort: 'createdAt' | '-createdAt' | 'name' | '-name' | 'priceCents' | '-priceCents';
  limit: number;
  offset?: number | undefined;
  cursor?: string | undefined;
  includeTotal: boolean;
};

export type CustomerRecord = SeedCustomer & {
  bannedAt: Date | null;
  banReason: string | null;
  version: number;
  updatedAt: Date;
};

export type CustomerListOptions = {
  q?: string | undefined;
  status?: 'ACTIVE' | 'BANNED' | undefined;
  sort: 'createdAt' | '-createdAt' | 'name' | '-name';
  limit: number;
  offset?: number | undefined;
  cursor?: string | undefined;
  includeTotal: boolean;
};

export type ListResult<T> = {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
  total?: number;
};

export type BulkUpdate = {
  id: string;
  priceCents: number;
  expectedVersion?: number | undefined;
};

export type BulkResult =
  | { ok: true; items: ProductRecord[] }
  | { ok: false; errors: { id: string; code: string; message: string }[] };

export type Store = {
  tenantExists(tenantId: string): Promise<boolean>;
  listProducts(tenantId: string, options: ProductListOptions): Promise<ListResult<ProductRecord>>;
  findProduct(tenantId: string, productId: string): Promise<ProductRecord | null>;
  createProduct(tenantId: string, input: ProductWrite): Promise<ProductRecord>;
  replaceProduct(
    tenantId: string,
    productId: string,
    input: ProductWrite,
    expectedVersion?: number,
  ): Promise<ProductRecord | null>;
  patchProduct(
    tenantId: string,
    productId: string,
    input: ProductPatch,
    expectedVersion?: number,
  ): Promise<ProductRecord | null>;
  deleteProduct(tenantId: string, productId: string): Promise<boolean>;
  bulkUpdateProducts(tenantId: string, updates: BulkUpdate[]): Promise<BulkResult>;
  listCustomers(tenantId: string, options: CustomerListOptions): Promise<ListResult<CustomerRecord>>;
  findCustomer(tenantId: string, customerId: string): Promise<CustomerRecord | null>;
  setCustomerBan(
    tenantId: string,
    customerId: string,
    action: 'BAN' | 'UNBAN',
    reason: string,
  ): Promise<{ customer: CustomerRecord; changed: boolean } | null>;
};

export function productDto(record: ProductRecord) {
  return {
    id: record.id,
    sku: record.sku,
    slug: record.slug,
    name: record.name,
    description: record.description,
    priceCents: record.priceCents,
    currency: record.currency,
    stock: record.stock,
    active: record.active,
    version: record.version,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export function customerDto(record: CustomerRecord) {
  return {
    id: record.id,
    email: record.email,
    name: record.name,
    status: record.bannedAt ? ('BANNED' as const) : ('ACTIVE' as const),
    bannedAt: record.bannedAt ? iso(record.bannedAt) : null,
    banReason: record.banReason,
    version: record.version,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export type ProductDto = ReturnType<typeof productDto>;
export type CustomerDto = ReturnType<typeof customerDto>;
