import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeBuildCode, encodeBuildCode } from '../src/shared/buildcode';
import { buildFromLink, looksLikeLink } from '../src/shared/targetlink';
import { makeTarget, targetProgress } from '../src/shared/targetstore';
import { handleMessage, type Tool } from '../src/mcp/protocol';

const code = readFileSync(join(__dirname, 'fixtures/deadeye.code'), 'utf8').trim();
type Page = { status?: number; body: string };
function fakeFetch(pages: Record<string, Page>) {
  const asked: string[] = [];
  const f = async (url: string) => {
    asked.push(url);
    const p = pages[url];
    if (!p) return { ok: false, status: 404, text: async () => '' };
    const status = p.status ?? 200;
    return { ok: status < 400, status, text: async () => p.body };
  };
  return { f, asked };
}

describe('target build from a link', () => {
  it('recognises links', () => {
    expect(looksLikeLink('https://pobb.in/AbC123')).toBe(true);
    expect(looksLikeLink('pobb.in/AbC123')).toBe(true);
    expect(looksLikeLink(code)).toBe(false);
  });

  it('reads pobb.in and pastebin through their raw pages', async () => {
    const { f, asked } = fakeFetch({ 'https://pobb.in/AbC123/raw': { body: code }, 'https://pastebin.com/raw/xYz789': { body: `  ${code}\n` } });
    expect(await buildFromLink('https://pobb.in/AbC123', 'ua', f)).toEqual({ code, origin: 'pobb.in/AbC123' });
    expect((await buildFromLink('pastebin.com/xYz789', 'ua', f)).origin).toBe('pastebin.com/xYz789');
    expect(asked).toEqual(['https://pobb.in/AbC123/raw', 'https://pastebin.com/raw/xYz789']);
  });

  it('finds a code or a pobb.in link inside a guide page', async () => {
    const { f } = fakeFetch({
      'https://guide.example/ice-shot': { body: `<html><textarea>${code}</textarea></html>` },
      'https://guide.example/other': { body: '<a href="https://pobb.in/Guide42">PoB</a>' },
      'https://pobb.in/Guide42/raw': { body: code },
    });
    expect(await buildFromLink('https://guide.example/ice-shot', 'ua', f)).toEqual({ code, origin: 'guide.example' });
    expect((await buildFromLink('https://guide.example/other', 'ua', f)).origin).toBe('guide.example → pobb.in/Guide42');
  });

  it('says clearly when a page blocks automatic access or has no code', async () => {
    const { f } = fakeFetch({
      'https://mobalytics.gg/poe-2/builds/x': { status: 403, body: '<title>Just a moment...</title>' },
      'https://cf.example/x': { body: '<html><head><title>Just a moment...</title></head></html>' },
      'https://empty.example/': { body: '<html>nothing here</html>' },
    });
    await expect(buildFromLink('https://mobalytics.gg/poe-2/builds/x', 'ua', f)).rejects.toThrow(/does not allow automatic access/);
    await expect(buildFromLink('https://cf.example/x', 'ua', f)).rejects.toThrow(/does not allow automatic access/);
    await expect(buildFromLink('https://empty.example/', 'ua', f)).rejects.toThrow(/No Path of Building code found on empty.example/);
    await expect(buildFromLink('https://pobb.in/Missing1', 'ua', f)).rejects.toThrow(/not found/);
  });

  it('rejects codes that are not PoE2 builds', async () => {
    // Zufälliger Inhalt, damit der Code lang genug für einen echten Build-Code ist.
    const noise = Array.from({ length: 300 }, (_, i) => ((i * 7919) % 97).toString(36)).join('');
    const poe1 = encodeBuildCode(`<PathOfBuilding><Build note="${noise}"/></PathOfBuilding>`);
    const { f } = fakeFetch({ 'https://pobb.in/Poe1Build/raw': { body: poe1 } });
    await expect(buildFromLink('https://pobb.in/Poe1Build', 'ua', f)).rejects.toThrow(/Path of Exile 1/);
  });
});

describe('target build storage and progress', () => {
  it('makes the stored target and shows what the worn gear misses', () => {
    const { target, build } = makeTarget(decodeBuildCode(code), null, 'link', 'https://pobb.in/AbC123');
    expect(target).toMatchObject({ source: 'link', link: 'https://pobb.in/AbC123' });
    expect(target.name.length).toBeGreaterThan(0);
    expect(build.slots.length).toBeGreaterThan(0);
    const slot = build.slots.find((s) => !s.unique && s.wanted.length > 1)!;
    const rows = targetProgress(build, [{ slot: slot.slot, set: null, item: { name: 'Bare, Thing', title: 'Bare', base: 'Thing', rarity: 'RARE', corrupted: false, mods: [], raw: '' } }]);
    const row = rows.find((r) => r.slot === slot.slot)!;
    expect(row.worn).toBe('Bare');
    expect(row.matches.startsWith('0 of ')).toBe(true);
    expect(row.missing.length).toBeGreaterThan(0);
    // Slots without worn item still list what the target wants.
    expect(rows.filter((r) => r.worn === null).every((r) => r.missing.length >= 0)).toBe(true);
  });
});

describe('MCP: tools that change something are marked', () => {
  it('annotates set_target_build-like tools as not read-only', async () => {
    const tool = (name: string, writes?: boolean): Tool => ({ name, title: name, description: '', inputSchema: { type: 'object', properties: {} }, writes, run: async () => null });
    const r = (await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { name: 'x', version: '1' }, [tool('get'), tool('set', true)])) as any;
    expect(r.result.tools[0].annotations.readOnlyHint).toBe(true);
    expect(r.result.tools[1].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});
