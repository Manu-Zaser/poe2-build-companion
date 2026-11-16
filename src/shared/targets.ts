import type { ItemInfo } from './types';

/**
 * Target build ("does it fit my build?"): reads the items of a guide's Path of Building build and turns
 * each slot's item into a short list of wanted stats, e.g. boots: movement speed, life, fire resistance.
 * An item is then checked against that list. Values do not matter for the check – a guide's item is an
 * example, not a minimum – but they are shown for orientation.
 */

export interface WantedStat {
  /** Comparable key, e.g. "res:fire" or "+# to maximum life". */
  key: string;
  /** Short label for the checklist, e.g. "Fire Resistance" or "+# to maximum Life". */
  label: string;
  /** First number of the mod line (the guide item's roll). */
  value?: number;
  /** Nice to have (rarity, light radius, …): shown, but not counted for the fit. */
  minor?: boolean;
}

export interface TargetSlot {
  slot: string;
  name: string;
  base: string;
  rarity: string;
  unique: boolean;
  wanted: WantedStat[];
}

export interface TargetBuild {
  className?: string;
  ascendancy?: string;
  level?: number;
  slots: TargetSlot[];
}

export interface Fit {
  /** Slot of the target build that was used (rings: the better of both). */
  targetSlot: string;
  targetName: string;
  unique: boolean;
  have: (WantedStat & { itemValue?: number })[];
  missing: WantedStat[];
}

const EQUIPMENT_SLOTS = ['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt'];

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

const ELEMENTS = ['fire', 'cold', 'lightning', 'chaos'] as const;
const RES_LABEL: Record<string, string> = { fire: 'Fire Resistance', cold: 'Cold Resistance', lightning: 'Lightning Resistance', chaos: 'Chaos Resistance', all: 'All Elemental Resistances' };

/** Stats a guide's item happens to have but that rarely decide whether an item fits the build. */
const MINOR = [/rarity of items/, /light radius/, /stun threshold/, /per enemy killed/, /on kill/, /reduced attribute requirements/, /thorns/, /item quantity/, /flask charges/, /charm charges/];
const isMinor = (key: string) => MINOR.some((r) => r.test(key));

/** Mod line → comparable stats. One line can give several (e.g. "+#% to Fire and Cold Resistances"). */
export function statsOfLine(raw: string): WantedStat[] {
  const line = raw
    .replace(/\{[^}]*\}/g, '') // PoB markers like {crafted}, {range:0.5}
    .replace(/\(\d+(?:\.\d+)?-\d+(?:\.\d+)?\)/g, '') // advanced copy: 89(80-91)%
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) return [];
  const num = line.match(/-?\d+(?:\.\d+)?/);
  const value = num ? Number(num[0]) : undefined;
  const lower = line.toLowerCase();

  const res = lower.match(/^[+-]?[\d.]+% to (.+?) resistances?$/);
  if (res) {
    const what = res[1];
    if (/all elemental/.test(what)) return [{ key: 'res:all', label: RES_LABEL.all, value }];
    if (/maximum/.test(what)) return [{ key: `max-res:${what}`, label: line.replace(/[\d.]+/g, '#'), value }];
    const els = ELEMENTS.filter((e) => what.includes(e));
    if (els.length) return els.map((e) => ({ key: `res:${e}`, label: RES_LABEL[e], value }));
  }
  const template = line.replace(/-?\d+(?:\.\d+)?/g, '#');
  const key = template.toLowerCase();
  return [{ key, label: template, value, ...(isMinor(key) ? { minor: true } : {}) }];
}

interface PobItem {
  name: string;
  base: string;
  rarity: string;
  explicits: string[];
}

/** Item text as stored in a PoB build (Rarity, name, base, meta lines, "Implicits: N", mods). */
export function parsePobItem(text: string): PobItem | null {
  const lines = unescapeXml(text.replace(/<ModRange[^>]*\/>/g, ''))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const r = lines.findIndex((l) => /^Rarity: /i.test(l));
  if (r < 0) return null;
  const rarity = lines[r].slice(8).trim().toUpperCase();
  const rest = lines.slice(r + 1);
  const twoNames = rarity === 'RARE' || rarity === 'UNIQUE' || rarity === 'RELIC';
  const name = rest[0] ?? '';
  const base = twoNames ? rest[1] ?? '' : name;
  const body = rest.slice(twoNames ? 2 : 1);
  const idx = body.findIndex((l) => /^Implicits: \d+$/.test(l));
  if (idx < 0) return { name, base, rarity, explicits: [] };
  const implicits = Number(body[idx].slice(11));
  const explicits = body
    .slice(idx + 1 + implicits)
    .filter((l) => !/^\{(rune|enchant)/i.test(l)) // socketed runes and enchants are not part of the item
    .filter((l) => !/^(Corrupted|Mirrored|Unidentified|Sanctified)$/i.test(l));
  return { name, base, rarity, explicits };
}

/** The guide's equipment, one entry per filled slot of its active item set. */
export function parseTargetBuild(xml: string): TargetBuild {
  const items = new Map<string, string>();
  for (const m of xml.matchAll(/<Item\b([^>]*)>([\s\S]*?)<\/Item>/g)) {
    const id = m[1].match(/\bid="(\d+)"/)?.[1];
    if (id) items.set(id, m[2]);
  }
  const itemsTag = xml.match(/<Items\b[^>]*>/)?.[0] ?? '';
  const activeSet = itemsTag.match(/\bactiveItemSet="(\d+)"/)?.[1] ?? '1';
  const setBody =
    [...xml.matchAll(/<ItemSet\b([^>]*)>([\s\S]*?)<\/ItemSet>/g)].find((m) => m[1].match(/\bid="(\d+)"/)?.[1] === activeSet)?.[2] ??
    xml.match(/<ItemSet\b[^>]*>([\s\S]*?)<\/ItemSet>/)?.[1] ??
    '';
  const useSwap = /\buseSecondWeaponSet="true"/.test(itemsTag);

  const slotItem = new Map<string, string>();
  for (const m of setBody.matchAll(/<Slot\b[^>]*>/g)) {
    const name = m[0].match(/\bname="([^"]+)"/)?.[1];
    const id = m[0].match(/\bitemId="(\d+)"/)?.[1];
    if (name && id && id !== '0') slotItem.set(name, id);
  }

  const slots: TargetSlot[] = [];
  for (const slot of EQUIPMENT_SLOTS) {
    // The guide's weapons: the set it fights with.
    const source = useSwap && slot.startsWith('Weapon') && slotItem.has(`${slot} Swap`) ? `${slot} Swap` : slot;
    const id = slotItem.get(source);
    const text = id ? items.get(id) : undefined;
    const item = text ? parsePobItem(text) : null;
    if (!item) continue;
    const unique = item.rarity === 'UNIQUE' || item.rarity === 'RELIC';
    const seen = new Set<string>();
    const wanted = unique
      ? [{ key: `unique:${item.name.toLowerCase()}`, label: item.name }]
      : item.explicits.flatMap(statsOfLine).filter((w) => !seen.has(w.key) && seen.add(w.key));
    slots.push({ slot, name: item.name, base: item.base, rarity: item.rarity, unique, wanted });
  }

  const build = xml.match(/<Build\b[^>]*>/)?.[0] ?? '';
  const attr = (n: string) => build.match(new RegExp(`\\b${n}="([^"]*)"`))?.[1];
  const level = Number(attr('level'));
  return {
    ...(attr('className') ? { className: attr('className') } : {}),
    ...(attr('ascendClassName') && attr('ascendClassName') !== 'None' ? { ascendancy: attr('ascendClassName') } : {}),
    ...(Number.isFinite(level) && level > 0 ? { level } : {}),
    slots,
  };
}

/** Explicit stats of an item (as the engine describes it). */
function itemStats(item: ItemInfo): Map<string, number | undefined> {
  const stats = new Map<string, number | undefined>();
  for (const m of item.mods) {
    if (m.kind !== 'explicit' && m.kind !== 'unique') continue;
    for (const s of statsOfLine(m.text)) if (!stats.has(s.key)) stats.set(s.key, s.value);
  }
  return stats;
}

/** Fit of an item with one specific slot of the target build. */
export function fitAgainst(target: TargetSlot, item: ItemInfo): Fit {
  const have: Fit['have'] = [];
  const missing: WantedStat[] = [];
  if (target.unique) {
    const same = item.title?.toLowerCase() === target.name.toLowerCase() || item.name.toLowerCase().startsWith(`${target.name.toLowerCase()},`);
    (same ? have : missing).push(target.wanted[0]);
  } else {
    const stats = itemStats(item);
    for (const w of target.wanted) {
      // "+#% to all Elemental Resistances" also covers a wanted single elemental resistance.
      const key = stats.has(w.key) ? w.key : /^res:(fire|cold|lightning)$/.test(w.key) && stats.has('res:all') ? 'res:all' : null;
      if (key) have.push({ ...w, itemValue: stats.get(key) });
      else missing.push(w);
    }
  }
  return { targetSlot: target.slot, targetName: target.name, unique: target.unique, have, missing };
}

/** Counted stats only (minor ones are shown but do not count). */
export function fitCount(f: Fit): { have: number; total: number } {
  const have = f.have.filter((w) => !w.minor).length;
  return { have, total: have + f.missing.filter((w) => !w.minor).length };
}

const share = (f: Fit) => {
  const c = fitCount(f);
  return c.total ? c.have / c.total : 0;
};

/**
 * How well an item in one of the player's slots matches the target build. Rings are compared with both
 * target rings (the better one counts); weapon swap slots use the guide's weapons.
 */
export function fitForSlot(target: TargetBuild, slot: string, item: ItemInfo): Fit | null {
  const base = slot.replace(/ Swap$/, '');
  const candidates = base.startsWith('Ring') ? ['Ring 1', 'Ring 2'] : [base];
  const fits = candidates
    .map((s) => target.slots.find((t) => t.slot === s))
    .filter((t): t is TargetSlot => !!t && t.wanted.length > 0)
    .map((t) => fitAgainst(t, item));
  if (!fits.length) return null;
  return fits.sort((a, b) => share(b) - share(a) || (b.targetSlot === base ? 1 : 0) - (a.targetSlot === base ? 1 : 0))[0];
}
