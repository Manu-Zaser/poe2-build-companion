import type { SlotComparison, Stats } from './types';

/**
 * "Is it better?" – turns PoB's before/after numbers for one slot into a verdict, the changes worth
 * showing and hard warnings. Hard warnings come first: an item with +10 % DPS that drops a resistance
 * below the cap is usually worse in game.
 */

export type VerdictKind = 'better' | 'worse' | 'mixed' | 'same' | 'warning';

export interface Change {
  key: string;
  label: string;
  /** Difference after − before. */
  delta: number;
  /** Relative change in %, for DPS and EHP. */
  pct?: number;
  unit?: '%' | '';
  good: boolean;
}

export interface SlotVerdict {
  slot: string;
  replaces: string | null;
  kind: VerdictKind;
  /** Main skill DPS change in %. */
  dpsPct: number;
  /** Effective health pool change in %. */
  ehpPct: number;
  /** Absolute changes of main skill DPS and effective health pool. */
  dpsDelta: number;
  ehpDelta: number;
  warnings: string[];
  changes: Change[];
  /** For ordering slots (rings): higher is better. */
  score: number;
}

/** Changes below this are treated as no change (rounding, tiny rolls). */
const NOISE_PCT = 0.5;

const pct = (after: number, before: number) => (before > 0 ? ((after - before) / before) * 100 : after > 0 ? 100 : 0);
const v = (s: Stats, k: string) => s[k] ?? 0;

const ELEMENTS = ['Fire', 'Cold', 'Lightning', 'Chaos'] as const;
const ATTRS = [
  ['Str', 'Strength'],
  ['Dex', 'Dexterity'],
  ['Int', 'Intelligence'],
] as const;

/** Rows shown in the overlay, in this order (DPS and EHP are shown separately). */
const ROWS: [key: string, label: string, unit?: '%' | ''][] = [
  ['Life', 'Life'],
  ['EnergyShield', 'Energy shield'],
  ['Mana', 'Mana'],
  ['FireResist', 'Fire res', '%'],
  ['ColdResist', 'Cold res', '%'],
  ['LightningResist', 'Lightning res', '%'],
  ['ChaosResist', 'Chaos res', '%'],
  ['PhysicalMaximumHitTaken', 'Max phys hit'],
  ['Evasion', 'Evasion'],
  ['Armour', 'Armour'],
  ['DeflectionRating', 'Deflection'],
  ['SpiritUnreserved', 'Free spirit'],
  ['Str', 'Strength'],
  ['Dex', 'Dexterity'],
  ['Int', 'Intelligence'],
];

export function hardWarnings(before: Stats, after: Stats): string[] {
  const out: string[] = [];
  for (const e of ELEMENTS) {
    const mb = v(before, `Missing${e}Resist`);
    const ma = v(after, `Missing${e}Resist`);
    if (ma > mb && ma > 0) {
      const res = v(after, `${e}Resist`);
      out.push(mb === 0 ? `${e} resistance falls below the cap (${res}% of ${res + ma}%)` : `${e} resistance drops further below the cap (${res}% of ${res + ma}%)`);
    }
  }
  for (const [k, name] of ATTRS) {
    const missBefore = Math.max(0, v(before, `Req${k}`) - v(before, k));
    const missAfter = Math.max(0, v(after, `Req${k}`) - v(after, k));
    if (missAfter > missBefore) out.push(`Not enough ${name}: ${v(after, k)} of ${v(after, `Req${k}`)} needed`);
  }
  const sb = v(before, 'SpiritUnreserved');
  const sa = v(after, 'SpiritUnreserved');
  if (sa < 0 && sa < sb) out.push(`Spirit no longer covers your reservations (${sa} free)`);
  return out;
}

export function judgeSlot(before: Stats, cmp: SlotComparison): SlotVerdict {
  const after = cmp.after;
  const dpsPct = pct(v(after, 'CombinedDPS'), v(before, 'CombinedDPS'));
  const ehpPct = pct(v(after, 'TotalEHP'), v(before, 'TotalEHP'));
  const warnings = hardWarnings(before, after);

  const changes: Change[] = [];
  for (const [key, label, unit] of ROWS) {
    const d = Math.round((v(after, key) - v(before, key)) * 10) / 10;
    if (d === 0) continue;
    changes.push({ key, label, delta: d, unit: unit ?? '', good: d > 0 });
  }

  const up = (p: number) => p >= NOISE_PCT;
  const down = (p: number) => p <= -NOISE_PCT;
  let kind: VerdictKind;
  if (warnings.length) kind = 'warning';
  else if ((up(dpsPct) || up(ehpPct)) && !down(dpsPct) && !down(ehpPct)) kind = 'better';
  else if ((down(dpsPct) || down(ehpPct)) && !up(dpsPct) && !up(ehpPct)) kind = 'worse';
  else if (up(dpsPct) || up(ehpPct)) kind = 'mixed';
  else kind = 'same';

  return {
    slot: cmp.slot,
    replaces: cmp.replaces,
    kind,
    dpsPct,
    ehpPct,
    dpsDelta: v(after, 'CombinedDPS') - v(before, 'CombinedDPS'),
    ehpDelta: v(after, 'TotalEHP') - v(before, 'TotalEHP'),
    warnings,
    changes,
    score: dpsPct + ehpPct - warnings.length * 1000,
  };
}

/** All slots the item fits, best first. */
export function judgeItem(before: Stats, slots: SlotComparison[]): SlotVerdict[] {
  return slots.map((s) => judgeSlot(before, s)).sort((a, b) => b.score - a.score);
}

export const VERDICT_TEXT: Record<VerdictKind, string> = {
  better: 'Better for your build',
  worse: 'Worse than what you wear',
  mixed: 'Trade-off',
  same: 'About the same',
  warning: 'Careful',
};
