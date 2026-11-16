import { deflateSync, inflateSync } from 'node:zlib';

/** Upper bound for a pasted or downloaded code (real codes are 5–40 KB). */
export const MAX_CODE_LENGTH = 500_000;

/**
 * Cleans up a pasted build code: trims whitespace and accepts a full pobb.in / poe.ninja-style
 * copy that has line breaks in it. Returns null if it cannot be a build code.
 */
export function normalizeBuildCode(text: string): string | null {
  const code = text.replace(/\s+/g, '');
  if (code.length < 100 || code.length > MAX_CODE_LENGTH) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(code)) return null;
  return code;
}

/**
 * Path of Building code → XML. The code is base64 (URL-safe: "-" and "_" instead of "+" and "/")
 * of zlib-compressed XML with a <PathOfBuilding2> root.
 */
export function decodeBuildCode(code: string): string {
  const b64 = code.trim().replace(/-/g, '+').replace(/_/g, '/');
  let xml: string;
  try {
    xml = inflateSync(Buffer.from(b64, 'base64'), { maxOutputLength: 20_000_000 }).toString('utf8');
  } catch {
    throw new Error('This is not a Path of Building code.');
  }
  if (!/<PathOfBuilding2[\s>]/.test(xml)) {
    if (/<PathOfBuilding[\s>]/.test(xml)) throw new Error('This is a Path of Exile 1 build code. Use a code from Path of Building for PoE2.');
    throw new Error('This is not a Path of Building code.');
  }
  return xml;
}

/** XML → Path of Building code (the same format PoB's Export → Generate produces). */
export function encodeBuildCode(xml: string): string {
  return deflateSync(Buffer.from(xml, 'utf8'), { level: 9 }).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}
