/**
 * The Build Companion's MCP tools: read-only views of the player's build, calculated by Path of Building.
 * Pure shaping functions here (testable); loading the build and the engine live in server.ts.
 */
import type { Comparison, Overview, Stats } from '../shared/types';

/** Stats an AI needs to judge a build – PoB's names, values rounded. */
const KEY_STATS = [
  'Life', 'EnergyShield', 'Mana', 'Spirit', 'SpiritUnreserved', 'Evasion', 'EvadeChance', 'Armour', 'PhysicalDamageReduction',
  'DeflectChance', 'BlockChance', 'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist', 'TotalEHP',
  'PhysicalMaximumHitTaken', 'FireMaximumHitTaken', 'ColdMaximumHitTaken', 'LightningMaximumHitTaken', 'ChaosMaximumHitTaken',
  'Str', 'ReqStr', 'Dex', 'ReqDex', 'Int', 'ReqInt', 'CombinedDPS', 'TotalDPS', 'EffectiveMovementSpeedMod', 'LifeRegenRecovery', 'ManaRegenRecovery',
] as const;

const round = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100);

export function pickStats(stats: Stats, keys: readonly string[] = KEY_STATS): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = stats[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = round(v);
  }
  return out;
}

export function characterSummary(o: Overview, source: string) {
  return {
    source,
    class: o.className ?? null,
    ascendancy: o.ascendancy ?? null,
    level: o.level ?? null,
    mainSkill: o.mainSkill ?? null,
    weaponSet: o.weaponSet,
    gear: o.gear
      .filter((g) => g.item)
      .map((g) => ({
        slot: g.slot,
        ...(g.set ? { weaponSet: g.set } : {}),
        name: g.item!.title ?? g.item!.name,
        base: g.item!.base,
        rarity: g.item!.rarity,
        ...(g.item!.corrupted ? { corrupted: true } : {}),
        mods: g.item!.mods.map((m) => (m.kind && m.kind !== 'explicit' ? `${m.text} (${m.kind})` : m.text)),
      })),
    jewels: o.jewels.map((j) => ({ socket: j.slot, name: j.item.title ?? j.item.name, base: j.item.base, mods: j.item.mods.map((m) => m.text) })),
    skills: o.gemGroups
      .filter((g) => g.gems.length)
      .map((g) => ({
        ...(g.label ? { label: g.label } : {}),
        ...(g.slot ? { slot: g.slot } : {}),
        ...(g.fromItem ? { fromItem: true } : {}),
        ...(g.enabled ? {} : { disabled: true }),
        gems: g.gems.map((x) => `${x.name}${x.level ? ` ${x.level}` : ''}${x.quality ? `/${x.quality}%` : ''}${x.support ? ' (support)' : ''}${x.enabled ? '' : ' (off)'}`),
      })),
    passives: {
      points: o.passives.points,
      weaponSetPoints: o.passives.weaponSetPoints,
      ascendancyPoints: o.passives.ascendancyPoints,
      ascendancyAndKeystones: o.passives.nodes.map((n) => n.name),
    },
  };
}

export function statsSummary(o: Overview) {
  return {
    mainSkill: o.mainSkill ?? null,
    ...(o.mainSkillAuto ? { note: "PoB's selected main skill does no damage – the skill with the highest DPS is used." } : {}),
    stats: pickStats(o.stats),
    skills: o.skills
      .slice()
      .sort((a, b) => b.dps - a.dps)
      .slice(0, 8)
      .map((s) => ({ name: s.part ? `${s.name} (${s.part})` : s.name, dps: Math.round(s.dps), ...(s.main ? { main: true } : {}), stats: pickStats(s.stats, Object.keys(s.stats)) })),
  };
}

/** PoB's comparison of an item against what the build wears: changes per slot it fits, largest first. */
export function comparisonSummary(c: Comparison) {
  const pct = (before: number | undefined, after: number | undefined) =>
    before && after !== undefined && Number.isFinite(before) && before !== 0 ? Math.round(((after - before) / Math.abs(before)) * 1000) / 10 : null;
  return {
    item: { name: c.item.title ?? c.item.name, base: c.item.base, rarity: c.item.rarity, mods: c.item.mods.map((m) => m.text) },
    slots: c.slots.map((s) => ({
      slot: s.slot,
      replaces: s.replaces,
      dpsChangePct: pct(c.before.CombinedDPS ?? c.before.TotalDPS, s.after.CombinedDPS ?? s.after.TotalDPS),
      ehpChangePct: pct(c.before.TotalEHP, s.after.TotalEHP),
      changes: Object.fromEntries(
        Object.entries(s.delta)
          .filter(([k, v]) => typeof v === 'number' && v !== 0 && (KEY_STATS as readonly string[]).includes(k))
          .map(([k, v]) => [k, round(v as number)]),
      ),
    })),
  };
}

const DEFENCE = /Resist|^Life|EnergyShield|Evasion|Evade|Deflect|Armour|Block|Ward|MaximumHitTaken|EHP|Regen|Leech|Recharge|DamageReduction|^Mana|Spirit|MovementSpeed/;

/** All defensive and recovery numbers PoB calculated, rounded. */
export function defenceSummary(o: Overview) {
  const stats = pickStats(o.stats, Object.keys(o.stats).filter((k) => DEFENCE.test(k)).sort());
  const res = ['Fire', 'Cold', 'Lightning', 'Chaos'].map((e) => ({ element: e, resist: stats[`${e}Resist`] ?? null, maxHit: stats[`${e}MaximumHitTaken`] ?? null }));
  return { resistances: res, stats };
}

/** One skill: all of PoB's numbers for it and the gems in its group. Without a name: the main skill. */
export function skillDetails(o: Overview, name?: string) {
  const q = (name ?? '').trim().toLowerCase();
  const skill = q ? o.skills.find((s) => s.name.toLowerCase() === q) ?? o.skills.find((s) => s.name.toLowerCase().includes(q)) : o.skills.find((s) => s.main) ?? o.skills[0];
  if (!skill) throw new Error(q ? `No damaging skill called "${name}" in this build. Skills: ${o.skills.map((s) => s.name).join(', ')}.` : 'No damaging skills in this build.');
  const group = o.gemGroups.find((g) => g.index === skill.group);
  return {
    name: skill.part ? `${skill.name} (${skill.part})` : skill.name,
    main: !!skill.main,
    dps: Math.round(skill.dps),
    stats: pickStats(skill.stats, Object.keys(skill.stats).sort()),
    gems: group ? group.gems.map((g) => `${g.name}${g.level ? ` ${g.level}` : ''}${g.quality ? `/${g.quality}%` : ''}${g.support ? ' (support)' : ''}${g.enabled ? '' : ' (off)'}`) : [],
    otherSkills: o.skills.filter((s) => s !== skill).map((s) => s.name),
  };
}

/** Before/after of a what-if or an equip: changes in % for damage and EHP, plus the stats that moved. */
export function changeSummary(before: Stats, after: Stats) {
  const pct = (a?: number, b?: number) => (a && b !== undefined && Number.isFinite(a) && a !== 0 ? Math.round(((b - a) / Math.abs(a)) * 1000) / 10 : null);
  const changes: Record<string, { before: number; after: number }> = {};
  for (const k of Object.keys(after)) {
    const a = before[k];
    const b = after[k];
    if (typeof a === 'number' && typeof b === 'number' && Math.abs(b - a) > 1e-9) changes[k] = { before: round(a), after: round(b) };
  }
  return {
    dpsChangePct: pct(before.CombinedDPS ?? before.TotalDPS, after.CombinedDPS ?? after.TotalDPS),
    ehpChangePct: pct(before.TotalEHP, after.TotalEHP),
    changes,
  };
}

/** Trade listing in the shape the AI gets. */
export function candidateSummary(c: {
  item: { title?: string; name: string; base: string };
  price: { amount: number; currency: string } | null;
  dpsPct?: number | null;
  ehpPct?: number | null;
  gain: number;
  upgrade: boolean;
  blocking: string[];
  warnings: string[];
  listedAt?: string;
  tradeUrl?: string;
}) {
  return {
    name: c.item.title ?? c.item.name,
    base: c.item.base,
    price: c.price ? `${c.price.amount} ${c.price.currency}` : null,
    dpsChangePct: typeof c.dpsPct === 'number' ? Math.round(c.dpsPct * 10) / 10 : null,
    ehpChangePct: typeof c.ehpPct === 'number' ? Math.round(c.ehpPct * 10) / 10 : null,
    overallPct: Math.round(c.gain * 10) / 10,
    upgrade: c.upgrade,
    ...(c.blocking.length ? { problems: c.blocking } : {}),
    ...(c.warnings.length ? { warnings: c.warnings } : {}),
    ...(c.listedAt ? { listed: c.listedAt } : {}),
    ...(c.tradeUrl ? { tradeLink: c.tradeUrl } : {}),
  };
}
