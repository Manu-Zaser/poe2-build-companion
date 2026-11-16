import type { ItemIcon, NinjaCharacter } from './types';

/**
 * poe.ninja character lookup. poe.ninja publishes characters with public profiles, including the
 * Path of Building code its own PoB calculated – the same data PoB uses for its poe.ninja import.
 * These endpoints are poe.ninja's (not GGG's) and not an official API, so failures are expected
 * and the app always offers pasting a code as the fallback.
 */

const BASE = 'https://poe.ninja/poe2';

const PREFIX = String.raw`^(?:https?:\/\/)?(?:www\.)?poe\.ninja\/poe2\/`;
const SEG = String.raw`([^/?#\s]+)`;
const SUFFIX = String.raw`\/?(?:[?#].*)?$`;
/** Builds page: /poe2/builds/<league>/character/<account>/<character> */
const BUILDS_LINK = new RegExp(`${PREFIX}builds\\/([a-z0-9-]+)\\/character\\/${SEG}\\/${SEG}${SUFFIX}`, 'i');
/** Profile page: /poe2/profile/<account>/<league>/character/<character> */
const PROFILE_LINK = new RegExp(`${PREFIX}profile\\/${SEG}\\/([a-z0-9-]+)\\/character\\/${SEG}${SUFFIX}`, 'i');

/**
 * Accepts a poe.ninja character link from the builds page or from the profile page, e.g.
 * https://poe.ninja/poe2/builds/forbiddenrites/character/Name-1234/MyCharacter
 * https://poe.ninja/poe2/profile/Name-1234/forbiddenrites/character/MyCharacter
 * (query string, hash and trailing slash are ignored).
 */
export function parseCharacterLink(text: string): NinjaCharacter | null {
  const t = text.trim();
  let league: string, account: string, character: string;
  const b = t.match(BUILDS_LINK);
  const p = b ? null : t.match(PROFILE_LINK);
  if (b) [, league, account, character] = b;
  else if (p) [, account, league, character] = p;
  else return null;
  try {
    return { league: league.toLowerCase(), account: decodeURIComponent(account), character: decodeURIComponent(character) };
  } catch {
    return null;
  }
}

export function characterLink(c: NinjaCharacter): string {
  return `${BASE}/profile/${encodeURIComponent(c.account)}/${c.league}/character/${encodeURIComponent(c.character)}`;
}

export interface NinjaBuild {
  code: string;
  /** When poe.ninja last checked the character (ISO). */
  checkedAt?: string;
  /** When the character last changed according to poe.ninja (ISO). */
  updatedAt?: string;
  level?: number;
  className?: string;
  /** League display name, e.g. "Forbidden Rites". */
  leagueName?: string;
  /** Item pictures (only images on GGG's CDN are kept). */
  icons?: ItemIcon[];
}

const ICON_HOST = 'https://web.poecdn.com/';

/** Item pictures from poe.ninja's profile data (equipment, flasks/charms, jewels). */
export function iconsFromModel(model: Record<string, unknown>): ItemIcon[] {
  const icons: ItemIcon[] = [];
  for (const key of ['items', 'flasks', 'jewels']) {
    const list = model[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const d = (entry as { itemData?: Record<string, unknown> })?.itemData;
      if (!d) continue;
      const url = str(d.icon);
      const typeLine = str(d.typeLine);
      const inventoryId = str(d.inventoryId);
      if (!url || !url.startsWith(ICON_HOST) || !typeLine || !inventoryId) continue;
      const name = str(d.name);
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const base = str(d.baseType);
      const unique = /^(Unique|Relic)$/i.test(str(d.frameTypeId) ?? '') || d.frameType === 3;
      icons.push({ name: name ? `${name}, ${typeLine}` : typeLine, ...(base ? { base } : {}), ...(unique ? { unique: true } : {}), inventoryId, x: num(d.x), w: num(d.w), h: num(d.h), url });
    }
  }
  return icons;
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

async function get(fetchImpl: FetchLike, url: string, userAgent: string): Promise<string> {
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': userAgent } });
  } catch {
    throw new Error('poe.ninja could not be reached. Check your internet connection.');
  }
  if (res.status === 404) throw new Error('poe.ninja does not know this character. Check the link, and that your profile is public.');
  if (!res.ok) throw new Error(`poe.ninja answered with error ${res.status}. Try again later or paste a build code.`);
  return res.text();
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Character path as poe.ninja's profile pages use it: <account>/<league>/<character> */
const profilePath = (c: NinjaCharacter) => `${encodeURIComponent(c.account)}/${encodeURIComponent(c.league)}/${encodeURIComponent(c.character)}`;

async function fetchProfileModel(c: NinjaCharacter, userAgent: string, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const model = JSON.parse(await get(fetchImpl, `${BASE}/api/profile/characters/${profilePath(c)}/model/60`, userAgent)) as { charModel?: Record<string, unknown> };
  return model.charModel ?? {};
}

/** Only the item pictures of a character's poe.ninja profile (for builds loaded from a PoB file or code). */
export async function fetchNinjaIcons(c: NinjaCharacter, userAgent: string, fetchImpl: FetchLike = fetch): Promise<ItemIcon[]> {
  return iconsFromModel(await fetchProfileModel(c, userAgent, fetchImpl));
}

/**
 * Loads a character's Path of Building code from its poe.ninja profile – the same address PoB uses when
 * importing from a poe.ninja profile page. The profile is kept fresher than the build snapshots and also works for characters outside them.
 * Timestamps come from the profile data; if that request fails, the code is still returned.
 */
export async function fetchNinjaBuild(c: NinjaCharacter, userAgent: string, fetchImpl: FetchLike = fetch): Promise<NinjaBuild> {
  const code = (await get(fetchImpl, `${BASE}/pob/raw/profile/code/${profilePath(c)}`, userAgent)).trim();
  if (!code) throw new Error('poe.ninja has no Path of Building code for this character.');

  let meta: Record<string, unknown> = {};
  try {
    meta = await fetchProfileModel(c, userAgent, fetchImpl);
  } catch {
    // Timestamps are optional – the app then shows when the code was loaded.
  }
  return {
    code,
    checkedAt: str(meta.lastCheckedUtc),
    updatedAt: str(meta.updatedUtc),
    level: typeof meta.level === 'number' ? meta.level : undefined,
    className: str(meta.class),
    leagueName: str(meta.league),
    ...(Object.keys(meta).length ? { icons: iconsFromModel(meta) } : {}),
  };
}
