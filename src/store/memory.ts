import { HttpProblem } from '../http/problem.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';
import { newId } from '../lib/ids.js';
import { CUSTOMERS, PRODUCTS, TENANTS } from '../data/seed-data.js';
import type {
  BulkResult,
  BulkUpdate,
  CustomerListOptions,
  CustomerRecord,
  ListResult,
  ProductListOptions,
  ProductPatch,
  ProductRecord,
  ProductWrite,
  Store,
} from './types.js';

function cloneProduct(record: ProductRecord): ProductRecord {
  return { ...record, createdAt: new Date(record.createdAt), updatedAt: new Date(record.updatedAt) };
}

function cloneCustomer(record: CustomerRecord): CustomerRecord {
  return { ...record, createdAt: new Date(record.createdAt), updatedAt: new Date(record.updatedAt) };
}

type Sortable = { createdAt: Date; id: string; name: string; priceCents?: number };

function compare(a: Sortable, b: Sortable, sort: string): number {
  const direction = sort.startsWith('-') ? -1 : 1;
  const field = sort.replace(/^-/, '');
  if (field === 'name') {
    const result = a.name.localeCompare(b.name);
    return result !== 0 ? result * direction : a.id.localeCompare(b.id);
  }
  if (field === 'priceCents') {
    const result = (a.priceCents ?? 0) - (b.priceCents ?? 0);
    return result !== 0 ? result * direction : a.id.localeCompare(b.id);
  }
  const result = a.createdAt.getTime() - b.createdAt.getTime();
  return result !== 0 ? result * direction : a.id.localeCompare(b.id) * direction;
}

function page<T extends Sortable>(
  rows: T[],
  options: { limit: number; offset?: number | undefined; cursor?: string | undefined; includeTotal: boolean },
): ListResult<T> {
  const total = options.includeTotal ? rows.length : undefined;
  let start = 0;

  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    const at = rows.findIndex(
      (row) => row.createdAt.toISOString() === cursor.createdAt && row.id === cursor.id,
    );
    // Cursor points at the last row of the previous page; continue after it.
    start = at >= 0 ? at + 1 : rows.length;
  } else if (options.offset) {
    start = options.offset;
  }

  const slice = rows.slice(start, start + options.limit);
  const hasMore = start + slice.length < rows.length;
  const last = slice.at(-1);
  return {
    items: slice,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
    ...(total !== undefined ? { total } : {}),
  };
}

export class MemoryStore implements Store {
  private readonly tenants = new Set(TENANTS.map((tenant) => tenant.id));
  private readonly products = new Map<string, ProductRecord>();
  private readonly customers = new Map<string, CustomerRecord>();

  constructor() {
    for (const product of PRODUCTS) {
      this.products.set(product.id, {
        ...product,
        description: product.description,
        version: 1,
        updatedAt: new Date(product.createdAt),
        deletedAt: null,
      });
    }
    for (const customer of CUSTOMERS) {
      this.customers.set(customer.id, {
        ...customer,
        bannedAt: null,
        banReason: null,
        version: 1,
        updatedAt: new Date(customer.createdAt),
      });
    }
  }

  async tenantExists(tenantId: string): Promise<boolean> {
    return this.tenants.has(tenantId);
  }

  async listProducts(tenantId: string, options: ProductListOptions): Promise<ListResult<ProductRecord>> {
    const q = options.q?.toLowerCase();
    let rows = [...this.products.values()].filter((product) => {
      if (product.tenantId !== tenantId || product.deletedAt) return false;
      if (options.active !== undefined && product.active !== options.active) return false;
      if (options.minPriceCents !== undefined && product.priceCents < options.minPriceCents) return false;
      if (options.maxPriceCents !== undefined && product.priceCents > options.maxPriceCents) return false;
      if (q) {
        const haystack = `${product.name} ${product.sku} ${product.slug}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    rows = rows.sort((a, b) => compare(a, b, options.sort));
    if (options.cursor) {
      // Cursor mode is only supported for the default newest-first order.
      const cursor = decodeCursor(options.cursor);
      rows = rows.filter(
        (row) =>
          row.createdAt.toISOString() < cursor.createdAt ||
          (row.createdAt.toISOString() === cursor.createdAt && row.id < cursor.id),
      );
    }
    return page(rows, { ...options, cursor: undefined });
  }

  async findProduct(tenantId: string, productId: string): Promise<ProductRecord | null> {
    const product = this.products.get(productId);
    if (!product || product.tenantId !== tenantId || product.deletedAt) return null;
    return cloneProduct(product);
  }

  async createProduct(tenantId: string, input: ProductWrite): Promise<ProductRecord> {
    for (const product of this.products.values()) {
      if (product.tenantId !== tenantId) continue;
      if (product.sku === input.sku) throw new HttpProblem(409, 'sku_taken', 'That SKU already exists for this tenant.');
      if (product.slug === input.slug) throw new HttpProblem(409, 'slug_taken', 'That slug already exists for this tenant.');
    }
    const now = new Date();
    const record: ProductRecord = {
      ...input,
      id: newId('prd'),
      tenantId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.products.set(record.id, record);
    return cloneProduct(record);
  }

  private writable(tenantId: string, productId: string): ProductRecord {
    const product = this.products.get(productId);
    if (!product || product.tenantId !== tenantId || product.deletedAt) {
      throw new HttpProblem(404, 'not_found', 'Product not found.');
    }
    return product;
  }

  private checkVersion(product: ProductRecord, expectedVersion?: number): void {
    if (expectedVersion !== undefined && product.version !== expectedVersion) {
      throw new HttpProblem(412, 'version_mismatch', 'The resource was modified by someone else.', {
        extensions: { currentVersion: product.version },
      });
    }
  }

  private checkUnique(product: ProductRecord, input: ProductPatch): void {
    for (const other of this.products.values()) {
      if (other.id === product.id || other.tenantId !== product.tenantId || other.deletedAt) continue;
      if (input.sku !== undefined && other.sku === input.sku) {
        throw new HttpProblem(409, 'sku_taken', 'That SKU already exists for this tenant.');
      }
      if (input.slug !== undefined && other.slug === input.slug) {
        throw new HttpProblem(409, 'slug_taken', 'That slug already exists for this tenant.');
      }
    }
  }

  async replaceProduct(
    tenantId: string,
    productId: string,
    input: ProductWrite,
    expectedVersion?: number,
  ): Promise<ProductRecord | null> {
    const existing = this.writable(tenantId, productId);
    this.checkVersion(existing, expectedVersion);
    this.checkUnique(existing, input);
    const updated: ProductRecord = {
      ...existing,
      ...input,
      version: existing.version + 1,
      updatedAt: new Date(),
    };
    this.products.set(productId, updated);
    return cloneProduct(updated);
  }

  async patchProduct(
    tenantId: string,
    productId: string,
    input: ProductPatch,
    expectedVersion?: number,
  ): Promise<ProductRecord | null> {
    const existing = this.writable(tenantId, productId);
    this.checkVersion(existing, expectedVersion);
    this.checkUnique(existing, input);
    const updated: ProductRecord = {
      ...existing,
      version: existing.version + 1,
      updatedAt: new Date(),
    };
    // Only apply keys the client actually sent. An explicit null (description)
    // is applied; an absent key is left untouched.
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) (updated as unknown as Record<string, unknown>)[key] = value;
    }
    this.products.set(productId, updated);
    return cloneProduct(updated);
  }

  async deleteProduct(tenantId: string, productId: string): Promise<boolean> {
    const product = this.products.get(productId);
    if (!product || product.tenantId !== tenantId || product.deletedAt) return false;
    product.deletedAt = new Date();
    product.updatedAt = new Date();
    product.version += 1;
    return true;
  }

  async bulkUpdateProducts(tenantId: string, updates: BulkUpdate[]): Promise<BulkResult> {
    const errors: { id: string; code: string; message: string }[] = [];
    const targets: ProductRecord[] = [];
    for (const update of updates) {
      const product = this.products.get(update.id);
      if (!product || product.tenantId !== tenantId || product.deletedAt) {
        errors.push({ id: update.id, code: 'not_found', message: 'Product not found.' });
        continue;
      }
      if (update.expectedVersion !== undefined && product.version !== update.expectedVersion) {
        errors.push({
          id: update.id,
          code: 'version_mismatch',
          message: `Expected version ${update.expectedVersion}, found ${product.version}.`,
        });
        continue;
      }
      targets.push(product);
    }
    if (errors.length > 0) return { ok: false, errors };

    // All-or-nothing: nothing is mutated until every update validates.
    const updated = targets.map((product, index) => {
      const next: ProductRecord = {
        ...product,
        priceCents: updates[index]!.priceCents,
        version: product.version + 1,
        updatedAt: new Date(),
      };
      this.products.set(next.id, next);
      return cloneProduct(next);
    });
    return { ok: true, items: updated };
  }

  async listCustomers(tenantId: string, options: CustomerListOptions): Promise<ListResult<CustomerRecord>> {
    const q = options.q?.toLowerCase();
    let rows = [...this.customers.values()].filter((customer) => {
      if (customer.tenantId !== tenantId) return false;
      if (options.status === 'ACTIVE' && customer.bannedAt) return false;
      if (options.status === 'BANNED' && !customer.bannedAt) return false;
      if (q) {
        const haystack = `${customer.name} ${customer.email}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    rows = rows.sort((a, b) => compare(a, b, options.sort));
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      rows = rows.filter(
        (row) =>
          row.createdAt.toISOString() < cursor.createdAt ||
          (row.createdAt.toISOString() === cursor.createdAt && row.id < cursor.id),
      );
    }
    return page(rows, { ...options, cursor: undefined });
  }

  async findCustomer(tenantId: string, customerId: string): Promise<CustomerRecord | null> {
    const customer = this.customers.get(customerId);
    if (!customer || customer.tenantId !== tenantId) return null;
    return cloneCustomer(customer);
  }

  async setCustomerBan(
    tenantId: string,
    customerId: string,
    action: 'BAN' | 'UNBAN',
    reason: string,
  ): Promise<{ customer: CustomerRecord; changed: boolean } | null> {
    const customer = this.customers.get(customerId);
    if (!customer || customer.tenantId !== tenantId) return null;
    const isBanned = customer.bannedAt !== null;
    if ((action === 'BAN' && isBanned) || (action === 'UNBAN' && !isBanned)) {
      return { customer: cloneCustomer(customer), changed: false };
    }
    const updated: CustomerRecord = {
      ...customer,
      bannedAt: action === 'BAN' ? new Date() : null,
      banReason: action === 'BAN' ? reason : customer.banReason,
      version: customer.version + 1,
      updatedAt: new Date(),
    };
    this.customers.set(customerId, updated);
    return { customer: cloneCustomer(updated), changed: true };
  }
}
