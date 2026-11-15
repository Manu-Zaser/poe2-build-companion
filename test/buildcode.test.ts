import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBuildCode, normalizeBuildCode } from '../src/shared/buildcode';

const code = readFileSync(join(__dirname, 'fixtures/deadeye.code'), 'utf8');
const encode = (xml: string) => deflateSync(xml).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

describe('normalizeBuildCode', () => {
  it('accepts a real code and strips whitespace and line breaks', () => {
    const broken = `  ${code.slice(0, 60)}\r\n${code.slice(60)}\n`;
    expect(normalizeBuildCode(broken)).toBe(code.trim());
  });

  it('rejects text that cannot be a code', () => {
    expect(normalizeBuildCode('Item Class: Rings\nRarity: Rare')).toBeNull();
    expect(normalizeBuildCode('abc')).toBeNull();
    expect(normalizeBuildCode('')).toBeNull();
  });
});

describe('decodeBuildCode', () => {
  it('decodes a PoE2 build code to XML', () => {
    const xml = decodeBuildCode(code);
    expect(xml).toContain('<PathOfBuilding2>');
    expect(xml).toContain('ascendClassName="Deadeye"');
  });

  it('explains a PoE1 code', () => {
    expect(() => decodeBuildCode(encode('<?xml version="1.0"?><PathOfBuilding><Build/></PathOfBuilding>'))).toThrow(/Path of Exile 1/);
  });

  it('rejects data that is not a build', () => {
    expect(() => decodeBuildCode(encode('<html></html>'))).toThrow(/not a Path of Building code/);
    expect(() => decodeBuildCode('A'.repeat(200))).toThrow(/not a Path of Building code/);
  });
});
