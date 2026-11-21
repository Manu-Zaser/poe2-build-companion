/**
 * Target build from a link: pobb.in, pastebin, poe.ninja characters, or any page that contains a Path of
 * Building code or a pobb.in link. Only on the user's (or their AI assistant's) request; pages that block
 * automatic access (bot checks, sign-in) are reported, never worked around.
 */
import { decodeBuildCode, MAX_CODE_LENGTH, normalizeBuildCode } from './buildcode';
import { fetchNinjaBuild, parseCharacterLink, type FetchLike } from './ninja';

export interface LinkedBuild {
  code: string;
  /** Short origin for the page, e.g. "pobb.in/AbC123" or "poe.ninja: MyCharacter". */
  origin: string;
}

const POBB = /^(?:https?:\/\/)?(?:www\.)?pobb\.in\/(?:u\/[^/]+\/)?([A-Za-z0-9_-]{4,40})\/?(?:[?#].*)?$/i;
const PASTEBIN = /^(?:https?:\/\/)?(?:www\.)?pastebin\.com\/(?:raw\/)?([A-Za-z0-9]{4,20})\/?(?:[?#].*)?$/i;
/** A PoB code in a page: long base64 that starts like zlib data ("eN…"). */
const CODE_IN_PAGE = /eN[A-Za-z0-9+/=_-]{200,}/g;
const POBB_IN_PAGE = /https?:\/\/(?:www\.)?pobb\.in\/[A-Za-z0-9_-]{4,40}/gi;

/** Is this text a link the app can try (http/https)? */
export function looksLikeLink(text: string): boolean {
  return /^(?:https?:\/\/|www\.|pobb\.in\/|pastebin\.com\/|poe\.ninja\/)/i.test(text.trim());
}

/** A code that really is a PoE2 build (throws with a user-facing message otherwise). */
function checkedCode(raw: string): string {
  const code = normalizeBuildCode(raw);
  if (!code) throw new Error('The link did not return a Path of Building code.');
  decodeBuildCode(code); // wirft bei PoE1-Codes und Unsinn
  return code;
}

async function getText(fetchImpl: FetchLike, url: string, userAgent: string): Promise<string> {
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': userAgent } });
  } catch {
    throw new Error(`${new URL(url).host} could not be reached. Check your internet connection.`);
  }
  if (res.status === 404) throw new Error('This link was not found. Check that it is complete.');
  if (res.status === 403 || res.status === 503) {
    throw new Error(`${new URL(url).host} does not allow automatic access to this page. Open it in your browser and copy the Path of Building code instead.`);
  }
  if (!res.ok) throw new Error(`${new URL(url).host} answered with error ${res.status}. Try again later or paste a build code.`);
  const text = await res.text();
  return text.length > MAX_CODE_LENGTH * 10 ? text.slice(0, MAX_CODE_LENGTH * 10) : text;
}

/**
 * Loads the build behind a link. pobb.in and pastebin have a raw version of the code; poe.ninja characters
 * go through poe.ninja's PoB export; any other page is searched for a code or a pobb.in link (one level deep).
 */
export async function buildFromLink(link: string, userAgent: string, fetchImpl: FetchLike = fetch): Promise<LinkedBuild> {
  const t = link.trim();
  const pobb = t.match(POBB);
  if (pobb) return { code: checkedCode(await getText(fetchImpl, `https://pobb.in/${pobb[1]}/raw`, userAgent)), origin: `pobb.in/${pobb[1]}` };
  const paste = t.match(PASTEBIN);
  if (paste) return { code: checkedCode(await getText(fetchImpl, `https://pastebin.com/raw/${paste[1]}`, userAgent)), origin: `pastebin.com/${paste[1]}` };
  const ninja = parseCharacterLink(t);
  if (ninja) return { code: checkedCode((await fetchNinjaBuild(ninja, userAgent, fetchImpl)).code), origin: `poe.ninja: ${ninja.character}` };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    throw new Error('This is not a valid link.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('This is not a valid link.');
  const page = await getText(fetchImpl, url.href, userAgent);
  if (/<title>\s*Just a moment/i.test(page) || /cf-chl|challenge-platform/i.test(page)) {
    throw new Error(`${url.host} does not allow automatic access to this page. Open it in your browser and copy the Path of Building code instead.`);
  }
  for (const m of page.match(CODE_IN_PAGE) ?? []) {
    try {
      return { code: checkedCode(m), origin: url.host };
    } catch {
      // nächster Kandidat
    }
  }
  for (const m of new Set(page.match(POBB_IN_PAGE) ?? [])) {
    try {
      const found = await buildFromLink(m, userAgent, fetchImpl);
      return { ...found, origin: `${url.host} → ${found.origin}` };
    } catch {
      // nächster Link
    }
  }
  throw new Error(`No Path of Building code found on ${url.host}. Links from pobb.in, pastebin or poe.ninja work, or paste the code from the guide's "Path of Building" button.`);
}
