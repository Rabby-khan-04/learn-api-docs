import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { HttpProblem } from '../http/problem.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';
import { newId } from '../lib/ids.js';
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

type PrismaProduct = Prisma.ProductGetPayload<Record<string, never>>;
type PrismaCustomer = Prisma.CustomerGetPayload<Record<string, never>>;

function toProduct(record: PrismaProduct): ProductRecord {
  return { ...record, deletedAt: record.deletedAt };
}

function toCustomer(record: PrismaCustomer): CustomerRecord {
  return { ...record };
}

function isUniqueViolation(error: unknown): error is { code: string; meta?: { target?: string[] } } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

class BulkAbort extends Error {
  constructor(readonly errors: { id: string; code: string; message: string }[]) {
    super('bulk aborted');
  }
}

export class PrismaStore implements Store {
  constructor(private readonly prisma: PrismaClient) {}

  async tenantExists(tenantId: string): Promise<boolean> {
    return (await this.prisma.tenant.count({ where: { id: tenantId } })) > 0;
  }

  private productWhere(tenantId: string, options: ProductListOptions): Prisma.ProductWhereInput {
    const where: Prisma.ProductWhereInput = { tenantId, deletedAt: null };
    if (options.active !== undefined) where.active = options.active;
    if (options.minPriceCents !== undefined || options.maxPriceCents !== undefined) {
      where.priceCents = {
        ...(options.minPriceCents !== undefined ? { gte: options.minPriceCents } : {}),
        ...(options.maxPriceCents !== undefined ? { lte: options.maxPriceCents } : {}),
      };
    }
    if (options.q) {
      where.OR = [
        { name: { contains: options.q, mode: 'insensitive' } },
        { sku: { contains: options.q, mode: 'insensitive' } },
        { slug: { contains: options.q, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  async listProducts(tenantId: string, options: ProductListOptions): Promise<ListResult<ProductRecord>> {
    const baseWhere = this.productWhere(tenantId, options);
    const where: Prisma.ProductWhereInput = { ...baseWhere };
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      const at = new Date(cursor.createdAt);
      where.AND = [
        {
          OR: [
            { createdAt: { lt: at } },
            { createdAt: at, id: { lt: cursor.id } },
          ],
        },
      ];
    }

    const direction: Prisma.SortOrder = options.sort.startsWith('-') ? 'desc' : 'asc';
    const field = options.sort.replace(/^-/, '');
    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      field === 'name'
        ? [{ name: direction }, { id: direction }]
        : field === 'priceCents'
          ? [{ priceCents: direction }, { id: direction }]
          : [{ createdAt: direction }, { id: direction }];

    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy,
        ...(options.offset ? { skip: options.offset } : {}),
        take: options.limit + 1,
      }),
      options.includeTotal ? this.prisma.product.count({ where: baseWhere }) : Promise.resolve(undefined),
    ]);

    const hasMore = rows.length > options.limit;
    const items = (hasMore ? rows.slice(0, options.limit) : rows).map(toProduct);
    const last = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
      ...(total !== undefined ? { total } : {}),
    };
  }

  async findProduct(tenantId: string, productId: string): Promise<ProductRecord | null> {
    const record = await this.prisma.product.findFirst({
      where: { id: productId, tenantId, deletedAt: null },
    });
    return record ? toProduct(record) : null;
  }

  async createProduct(tenantId: string, input: ProductWrite): Promise<ProductRecord> {
    try {
      const record = await this.prisma.product.create({
        data: { ...input, id: newId('prd'), tenantId },
      });
      return toProduct(record);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const target = error.meta?.target?.[1];
        throw new HttpProblem(
          409,
          target === 'slug' ? 'slug_taken' : 'sku_taken',
          'That SKU or slug already exists for this tenant.',
        );
      }
      throw error;
    }
  }

  async replaceProduct(
    tenantId: string,
    productId: string,
    input: ProductWrite,
    expectedVersion?: number,
  ): Promise<ProductRecord | null> {
    try {
      const updated = await this.prisma.product.updateMany({
        where: {
          id: productId,
          tenantId,
          deletedAt: null,
          ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
        },
        data: { ...input, version: { increment: 1 } },
      });
      if (updated.count === 0) return this.explainWriteMiss(tenantId, productId, expectedVersion);
      const record = await this.prisma.product.findUniqueOrThrow({ where: { id: productId } });
      return toProduct(record);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpProblem(409, 'sku_or_slug_taken', 'That SKU or slug already exists for this tenant.');
      }
      throw error;
    }
  }

  async patchProduct(
    tenantId: string,
    productId: string,
    input: ProductPatch,
    expectedVersion?: number,
  ): Promise<ProductRecord | null> {
    const data: Prisma.ProductUpdateManyMutationInput = { version: { increment: 1 } };
    if (input.sku !== undefined) data.sku = input.sku;
    if (input.slug !== undefined) data.slug = input.slug;
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.priceCents !== undefined) data.priceCents = input.priceCents;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.stock !== undefined) data.stock = input.stock;
    if (input.active !== undefined) data.active = input.active;

    try {
      const updated = await this.prisma.product.updateMany({
        where: {
          id: productId,
          tenantId,
          deletedAt: null,
          ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
        },
        data,
      });
      if (updated.count === 0) return this.explainWriteMiss(tenantId, productId, expectedVersion);
      const record = await this.prisma.product.findUniqueOrThrow({ where: { id: productId } });
      return toProduct(record);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpProblem(409, 'sku_or_slug_taken', 'That SKU or slug already exists for this tenant.');
      }
      throw error;
    }
  }

  private async explainWriteMiss(
    tenantId: string,
    productId: string,
    expectedVersion?: number,
  ): Promise<never> {
    const current = await this.prisma.product.findFirst({
      where: { id: productId, tenantId, deletedAt: null },
    });
    if (!current) throw new HttpProblem(404, 'not_found', 'Product not found.');
    throw new HttpProblem(412, 'version_mismatch', 'The resource was modified by someone else.', {
      extensions: { currentVersion: current.version },
    });
  }

  async deleteProduct(tenantId: string, productId: string): Promise<boolean> {
    const result = await this.prisma.product.updateMany({
      where: { id: productId, tenantId, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    return result.count > 0;
  }

  async bulkUpdateProducts(tenantId: string, updates: BulkUpdate[]): Promise<BulkResult> {
    try {
      const items = await this.prisma.$transaction(async (tx) => {
        const ids = updates.map((update) => update.id);
        const existing = await tx.product.findMany({
          where: { tenantId, id: { in: ids }, deletedAt: null },
        });
        const byId = new Map(existing.map((product) => [product.id, product]));
        const errors: { id: string; code: string; message: string }[] = [];

        for (const update of updates) {
          const product = byId.get(update.id);
          if (!product) {
            errors.push({ id: update.id, code: 'not_found', message: 'Product not found.' });
            continue;
          }
          if (update.expectedVersion !== undefined && product.version !== update.expectedVersion) {
            errors.push({
              id: update.id,
              code: 'version_mismatch',
              message: `Expected version ${update.expectedVersion}, found ${product.version}.`,
            });
          }
        }
        if (errors.length > 0) throw new BulkAbort(errors);

        for (const update of updates) {
          const result = await tx.product.updateMany({
            where: {
              id: update.id,
              tenantId,
              deletedAt: null,
              ...(update.expectedVersion !== undefined ? { version: update.expectedVersion } : {}),
            },
            data: { priceCents: update.priceCents, version: { increment: 1 } },
          });
          if (result.count === 0) {
            throw new BulkAbort([
              { id: update.id, code: 'version_mismatch', message: 'Concurrent update detected.' },
            ]);
          }
        }

        const updated = await tx.product.findMany({ where: { tenantId, id: { in: ids } } });
        return updated.map(toProduct);
      });
      return { ok: true, items };
    } catch (error) {
      if (error instanceof BulkAbort) return { ok: false, errors: error.errors };
      throw error;
    }
  }

  private customerWhere(tenantId: string, options: CustomerListOptions): Prisma.CustomerWhereInput {
    const where: Prisma.CustomerWhereInput = { tenantId };
    if (options.status === 'ACTIVE') where.bannedAt = null;
    if (options.status === 'BANNED') where.bannedAt = { not: null };
    if (options.q) {
      where.OR = [
        { name: { contains: options.q, mode: 'insensitive' } },
        { email: { contains: options.q, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  async listCustomers(tenantId: string, options: CustomerListOptions): Promise<ListResult<CustomerRecord>> {
    const baseWhere = this.customerWhere(tenantId, options);
    const where: Prisma.CustomerWhereInput = { ...baseWhere };
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      const at = new Date(cursor.createdAt);
      where.AND = [
        {
          OR: [
            { createdAt: { lt: at } },
            { createdAt: at, id: { lt: cursor.id } },
          ],
        },
      ];
    }
    const direction: Prisma.SortOrder = options.sort.startsWith('-') ? 'desc' : 'asc';
    const field = options.sort.replace(/^-/, '');
    const orderBy: Prisma.CustomerOrderByWithRelationInput[] =
      field === 'name' ? [{ name: direction }, { id: direction }] : [{ createdAt: direction }, { id: direction }];

    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy,
        ...(options.offset ? { skip: options.offset } : {}),
        take: options.limit + 1,
      }),
      options.includeTotal ? this.prisma.customer.count({ where: baseWhere }) : Promise.resolve(undefined),
    ]);

    const hasMore = rows.length > options.limit;
    const items = (hasMore ? rows.slice(0, options.limit) : rows).map(toCustomer);
    const last = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
      ...(total !== undefined ? { total } : {}),
    };
  }

  async findCustomer(tenantId: string, customerId: string): Promise<CustomerRecord | null> {
    const record = await this.prisma.customer.findFirst({ where: { id: customerId, tenantId } });
    return record ? toCustomer(record) : null;
  }

  async setCustomerBan(
    tenantId: string,
    customerId: string,
    action: 'BAN' | 'UNBAN',
    reason: string,
  ): Promise<{ customer: CustomerRecord; changed: boolean } | null> {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: customerId, tenantId } });
      if (!customer) return null;
      const isBanned = customer.bannedAt !== null;
      if ((action === 'BAN' && isBanned) || (action === 'UNBAN' && !isBanned)) {
        return { customer: toCustomer(customer), changed: false };
      }
      const updated = await tx.customer.update({
        where: { id: customerId },
        data: {
          bannedAt: action === 'BAN' ? new Date() : null,
          banReason: action === 'BAN' ? reason : customer.banReason,
          version: { increment: 1 },
        },
      });
      return { customer: toCustomer(updated), changed: true };
    });
  }
}
