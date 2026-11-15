/** Number with thousands separators: 1,708 · 64 · 12.5 */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '–';
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 100 ? 1 : 0 });
}

/** Large numbers short: 471.8k · 1.25M */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return fmt(n);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" */
export function ageText(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'at an unknown time';
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** A build state older than this is flagged as possibly outdated. */
export const STALE_AFTER_MS = 3 * 24 * 3600_000;

export function isStale(iso: string, now = Date.now()): boolean {
  const t = Date.parse(iso);
  return !Number.isFinite(t) || now - t > STALE_AFTER_MS;
}

/** Very short form for tight rows, as poe.ninja shows max hits: 950 · 3.7k · 13k · 1.3M */
export function short(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return fmt(Math.round(n));
}
