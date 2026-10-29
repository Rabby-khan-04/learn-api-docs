export type SeedTenant = {
  id: string;
  slug: string;
  name: string;
  plan: string;
};

export type SeedProduct = {
  id: string;
  tenantId: string;
  sku: string;
  slug: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  stock: number;
  active: boolean;
  createdAt: Date;
};

export type SeedCustomer = {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  createdAt: Date;
};

export const TENANTS: SeedTenant[] = [
  { id: 'ten_acme', slug: 'acme', name: 'Acme Outdoors', plan: 'PRO' },
  { id: 'ten_globex', slug: 'globex', name: 'Globex Europe', plan: 'ENTERPRISE' },
];

const BASE = Date.UTC(2026, 0, 1, 9, 0, 0);

export const PRODUCTS: SeedProduct[] = [
  {
    id: 'prd_tee', tenantId: 'ten_acme', sku: 'TEE-001', slug: 'classic-tee',
    name: 'Classic T-Shirt', description: 'Heavyweight cotton tee.', priceCents: 1999,
    currency: 'USD', stock: 50, active: true, createdAt: new Date(BASE),
  },
  {
    id: 'prd_mug', tenantId: 'ten_acme', sku: 'MUG-001', slug: 'camp-mug',
    name: 'Camp Mug', description: 'Enamel mug, 350 ml.', priceCents: 1299,
    currency: 'USD', stock: 120, active: true, createdAt: new Date(BASE + 3_600_000),
  },
  {
    id: 'prd_hoodie', tenantId: 'ten_acme', sku: 'HOO-001', slug: 'trail-hoodie',
    name: 'Trail Hoodie', description: 'Fleece-lined hoodie.', priceCents: 4999,
    currency: 'USD', stock: 8, active: true, createdAt: new Date(BASE + 7_200_000),
  },
  {
    id: 'prd_cap', tenantId: 'ten_acme', sku: 'CAP-001', slug: 'running-cap',
    name: 'Running Cap', description: 'Lightweight cap.', priceCents: 2499,
    currency: 'USD', stock: 0, active: false, createdAt: new Date(BASE + 10_800_000),
  },
  {
    id: 'prd_eu_mug', tenantId: 'ten_globex', sku: 'MUG-EU', slug: 'eu-mug',
    name: 'EU Camp Mug', description: 'Euro edition.', priceCents: 1199,
    currency: 'EUR', stock: 40, active: true, createdAt: new Date(BASE + 14_400_000),
  },
  {
    id: 'prd_eu_tee', tenantId: 'ten_globex', sku: 'TEE-EU', slug: 'eu-tee',
    name: 'EU Classic Tee', description: 'Euro edition tee.', priceCents: 2199,
    currency: 'EUR', stock: 25, active: true, createdAt: new Date(BASE + 18_000_000),
  },
];

const NAMES = [
  'Alice Johnson', 'Bob Smith', 'Carol Diaz', 'Diana Prince', 'Eve Adams',
  'Frank Miller', 'Grace Hopper', 'Heidi Klum', 'Ivan Petrov', 'Judy Chen',
  'Kenji Watanabe', 'Lara Croft', 'Mona Lisa', 'Nina Simone', 'Oscar Wilde',
  'Pablo Picasso', 'Quinn Taylor', 'Rosa Parks', 'Sam Lee', 'Tina Turner',
  'Uma Thurman', 'Victor Hugo', 'Wendy Darling', 'Xena Warrior', 'Yara Shahidi',
  'Zane Grey', 'Alice Cooper', 'Bob Dylan', 'Carol King', 'Diana Ross',
];

function customers(tenantId: string, prefix: string, count: number): SeedCustomer[] {
  return Array.from({ length: count }, (_, i) => {
    const display = NAMES[i % NAMES.length]!;
    const slug = display.toLowerCase().replace(/[^a-z]+/g, '.');
    return {
      id: `cus_${prefix}_${String(i + 1).padStart(2, '0')}`,
      tenantId,
      email: `${slug}.${i + 1}@example.com`,
      name: display,
      createdAt: new Date(Date.UTC(2026, 0, 1 + i, 9, 0, 0)),
    };
  });
}

export const CUSTOMERS: SeedCustomer[] = [
  ...customers('ten_acme', 'acme', 30),
  ...customers('ten_globex', 'globex', 3),
];
