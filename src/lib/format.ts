export function iso(date: Date): string {
  return date.toISOString();
}

export function isoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

// Deterministic JSON: sorted keys, so two equivalent bodies hash the same.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}
