/**
 * Turns an item from the trade site's fetch response (/api/trade2/fetch) into Path of Building item text,
 * so PoB can calculate it like an item copied in game.
 *
 * Ported from Path of Building PoE2 (src/Classes/TradeQueryRequests.lua, fetch callback; MIT, © David Gowor)
 * – same lines and order. One addition: fractured, crafted and desecrated mods are kept (with PoB's own
 * {fractured}/{crafted} tags) instead of being dropped, so such items are not undervalued.
 */

export interface TradeModLine {
  description: string;
  flags?: Record<string, boolean>;
}

type ModList = (TradeModLine | string)[] | undefined;

export interface TradeItem {
  rarity?: string;
  name?: string;
  typeLine: string;
  baseType?: string;
  ilvl?: number;
  properties?: { name: string; values?: [string, number][] }[];
  requirements?: { name: string; values?: [string, number][] }[];
  sockets?: unknown[];
  enchantMods?: ModList;
  runeMods?: ModList;
  implicitMods?: ModList;
  explicitMods?: ModList;
  fracturedMods?: ModList;
  craftedMods?: ModList;
  desecratedMods?: ModList;
  mirrored?: boolean;
  corrupted?: boolean;
  doubleCorrupted?: boolean;
  sanctified?: boolean;
}

/** Removes the trade site's markup: "[EnergyShield|Energy Shield]" → "Energy Shield", "[Life]" → "Life". */
export function escapeGGG(text: string): string {
  return text
    .replace(/<[^>]+>\{([^}]+)\}/g, '$1')
    .replace(/\[([^|\]]+)\]/g, '$1')
    .replace(/\[[^|\]]+\|([^|\]]+)\]/g, '$1');
}

function lineOf(mod: TradeModLine | string, extraTags = ''): string {
  if (typeof mod === 'string') return extraTags + escapeGGG(mod);
  let tags = '';
  for (const [flag, on] of Object.entries(mod.flags ?? {})) if (on) tags += `{${flag}}`;
  return extraTags + tags + escapeGGG(mod.description);
}

const firstValue = (p: { values?: [string, number][] }) => p.values?.[0]?.[0];

export function tradeItemToPob(item: TradeItem): string {
  const props: Record<string, string | undefined> = {};
  for (const p of item.properties ?? []) props[escapeGGG(p.name)] = firstValue(p);

  const lines: string[] = [`Rarity: ${item.rarity ?? 'Rare'}`];
  // Rares: name + base; magic items: the full magic name is in typeLine and name is empty.
  if (item.name) lines.push(item.name);
  lines.push(item.typeLine);

  if (props['Charm Slots']) lines.push(`Charm Slots: ${props['Charm Slots']}`);
  if (props.Spirit) lines.push(`Spirit: ${props.Spirit}`);
  if (props.Armour) lines.push(`Armour: ${props.Armour}`);
  if (props['Evasion Rating']) lines.push(`Evasion: ${props['Evasion Rating']}`);
  if (props['Energy Shield']) lines.push(`Energy Shield: ${props['Energy Shield']}`);
  if (item.ilvl) lines.push(`Item Level: ${item.ilvl}`);
  if (props.Quality) lines.push(`Quality: ${props.Quality.replace(/^\+/, '').replace(/%$/, '')}`);
  if (item.sockets?.length) lines.push(`Sockets: ${item.sockets.map(() => 'S').join(' ')}`);
  const level = item.requirements?.find((r) => r.name === 'Level');
  if (level && firstValue(level)) lines.push(`LevelReq: ${firstValue(level)}`);
  if (props.Radius) lines.push(`Radius: ${props.Radius}`);
  if (props['Limited to']) lines.push(`Limited to: ${props['Limited to']}`);

  const enchant = item.enchantMods ?? [];
  const runes = item.runeMods ?? [];
  const implicit = item.implicitMods ?? [];
  lines.push(`Implicits: ${enchant.length + runes.length + implicit.length}`);
  for (const m of enchant) lines.push(lineOf(m, '{enchant}'));
  for (const m of runes) lines.push(lineOf(m, '{enchant}{rune}'));
  for (const m of implicit) lines.push(lineOf(m));
  for (const m of item.fracturedMods ?? []) lines.push(lineOf(m, '{fractured}'));
  for (const m of item.explicitMods ?? []) lines.push(lineOf(m));
  for (const m of item.desecratedMods ?? []) lines.push(lineOf(m));
  for (const m of item.craftedMods ?? []) lines.push(lineOf(m, '{crafted}'));

  if (item.mirrored) lines.push('Mirrored');
  if (item.doubleCorrupted) lines.push('Twice Corrupted');
  else if (item.corrupted) lines.push('Corrupted');
  if (item.sanctified) lines.push('Sanctified');
  return lines.join('\n');
}
