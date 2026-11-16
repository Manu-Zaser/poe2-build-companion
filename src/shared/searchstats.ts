/**
 * Which stats the upgrade search looks for – from PoB's mod weights to a short list of stats that matter.
 *
 * PoB weighs every mod that can roll on the slot one by one. Taken as they are, the top mods are mostly
 * variants of the same thing that never come together on one item:
 *  - "+26% to Cold Resistance", "+15% to Cold and Chaos Resistances", "+12% to all Elemental Resistances"
 *    → the trade site's pseudo stat "total Cold Resistance" covers all of them (also implicits);
 *  - "% increased Energy Shield", "% increased Evasion and Energy Shield", "% increased Armour and Energy
 *    Shield" → only the one that fits the base's defences works (and the search stays on such bases);
 *  - life, mana and attributes → their pseudo totals.
 * Stats worth much less than the best one are left out: an item does not get better by having them.
 */
import type { PobModWeight } from './upgrades';

export interface SearchStat {
  /** Trade stat id (explicit/implicit or pseudo). */
  id: string;
  /** Short text for the page, e.g. "Cold resistance". */
  label: string;
  /** PoB's effect of a typical roll (for ordering and the relevance cut). */
  effect: number;
  /** A good roll: the minimum at full strictness (null = no minimum). */
  value: number | null;
}

export interface Defences {
  armour: boolean;
  evasion: boolean;
  energyShield: boolean;
}

/** At most this many stats in the search. */
export const MAX_SEARCH_STATS = 8;
/** Stats worth less than this share of the best one are left out. */
export const RELEVANT_SHARE = 0.3;
/** Pseudo resistance minimum as a share of a single-resistance roll: hybrid and all-res mods roll lower. */
const RES_SHARE = 0.6;

const ARMOUR_SLOTS = new Set(['Helmet', 'Body Armour', 'Gloves', 'Boots']);
const ELEMENTS = ['fire', 'cold', 'lightning', 'chaos'] as const;
type Element = (typeof ELEMENTS)[number];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const norm = (text: string) => text.replace(/\s*\(Local\)\s*$/i, '').trim();

/** Elements a resistance mod gives, or null if it is no resistance mod. */
function resistanceElements(text: string): Element[] | null {
  const t = norm(text).toLowerCase();
  if (/^\+?#% to all elemental resistances$/.test(t)) return ['fire', 'cold', 'lightning'];
  const m = t.match(/^\+?#% to (fire|cold|lightning|chaos)(?: and (fire|cold|lightning|chaos))? resistances?$/);
  if (!m) return null;
  return m[2] ? [m[1] as Element, m[2] as Element] : [m[1] as Element];
}

/** Defences a local "% increased …" or flat "+# to …" defence mod works on, or null for other mods. */
function localDefences(text: string): { kind: 'percent' | 'flat'; set: Defences } | null {
  const t = norm(text).toLowerCase();
  const pct = t.match(/^#% increased (armour|evasion rating|energy shield|armour and evasion|armour and energy shield|evasion and energy shield|armour, evasion and energy shield)$/);
  const flat = t.match(/^\+?# to (armour|evasion rating|maximum energy shield)$/);
  const what = pct?.[1] ?? flat?.[1];
  if (!what) return null;
  return {
    kind: pct ? 'percent' : 'flat',
    set: { armour: what.includes('armour'), evasion: what.includes('evasion'), energyShield: what.includes('energy shield') },
  };
}

const sameSet = (a: Defences, b: Defences) => a.armour === b.armour && a.evasion === b.evasion && a.energyShield === b.energyShield;
const within = (a: Defences, base: Defences) => (!a.armour || base.armour) && (!a.evasion || base.evasion) && (!a.energyShield || base.energyShield);

/** "#% increased Attack Speed" → "x% increased Attack Speed" */
const labelOf = (text: string) => norm(text).replace(/#/g, 'x');

export function searchStats(mods: PobModWeight[], ctx: { slot: string; defences: Defences | null }): SearchStat[] {
  const armourSlot = ARMOUR_SLOTS.has(ctx.slot) && ctx.defences !== null;
  const res = new Map<Element, { effect: number; value: number | null; single: boolean }>();
  const totals = new Map<string, SearchStat>();
  const out: SearchStat[] = [];

  for (const m of mods) {
    if (!(m.weight > 0) || !m.text) continue;
    const text = m.text;

    const elements = resistanceElements(text);
    if (elements) {
      // Effect per element: a single-element mod counts fully, a hybrid's effect is split over its elements.
      for (const e of elements) {
        const single = elements.length === 1;
        const effect = m.effect / elements.length;
        const prev = res.get(e);
        if (!prev || (single && !prev.single) || (single === prev.single && effect > prev.effect)) {
          res.set(e, { effect: single ? m.effect : effect, value: m.testedValue, single });
        }
      }
      continue;
    }

    const t = norm(text).toLowerCase();
    const total =
      /^\+?# to maximum life$/.test(t) ? ['pseudo.pseudo_total_life', 'Life'] :
      /^\+?# to maximum mana$/.test(t) ? ['pseudo.pseudo_total_mana', 'Mana'] :
      ((): [string, string] | null => {
        const a = t.match(/^\+?# to (strength|dexterity|intelligence)$/);
        return a ? [`pseudo.pseudo_total_${a[1]}`, cap(a[1])] : null;
      })();
    if (total) {
      const [id, label] = total;
      const prev = totals.get(id);
      if (!prev || m.effect > prev.effect) totals.set(id, { id, label, effect: m.effect, value: m.testedValue });
      continue;
    }
    // "+# to all Attributes", "+# to Strength and Dexterity": covered by the single attribute totals.
    if (/^\+?# to (all attributes|(strength|dexterity|intelligence) and (strength|dexterity|intelligence))$/.test(t)) continue;

    if (armourSlot) {
      const d = localDefences(text);
      if (d) {
        // % increased only in the exact variant of the base, flat only for a defence the base has.
        if (d.kind === 'percent' ? !sameSet(d.set, ctx.defences!) : !within(d.set, ctx.defences!)) continue;
      }
    }
    out.push({ id: m.id, label: labelOf(text), effect: m.effect, value: m.testedValue });
  }

  for (const e of ELEMENTS) {
    const r = res.get(e);
    if (!r) continue;
    const value = r.value !== null ? Math.floor(r.value * RES_SHARE) : null;
    out.push({ id: `pseudo.pseudo_total_${e}_resistance`, label: `${cap(e)} resistance`, effect: r.effect, value });
  }
  out.push(...totals.values());

  out.sort((a, b) => b.effect - a.effect);
  // The same stat as implicit and explicit (e.g. "% of Damage is taken from Mana before Life"): keep the
  // more valuable one – an item needs it once, not twice.
  const seen = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    if (seen.has(out[i].label)) out.splice(i--, 1);
    else seen.add(out[i].label);
  }
  // A base type's own implicit (e.g. Runic Ward on some body armours) does not set the bar – otherwise
  // it would push out every stat that can actually roll.
  const top = out.find((s) => !s.id.startsWith('implicit.'))?.effect ?? out[0]?.effect ?? 0;
  return out.filter((s) => s.effect >= top * RELEVANT_SHARE).slice(0, MAX_SEARCH_STATS);
}

/** Trade site equipment filter keeping the search on bases with the same defences (armour slots only). */
export function defenceFilters(slot: string, defences: Defences | null): Record<string, { min: number }> | null {
  if (!ARMOUR_SLOTS.has(slot) || !defences) return null;
  const f: Record<string, { min: number }> = {};
  if (defences.armour) f.ar = { min: 1 };
  if (defences.evasion) f.ev = { min: 1 };
  if (defences.energyShield) f.es = { min: 1 };
  return Object.keys(f).length ? f : null;
}
