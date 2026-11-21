import { describe, expect, it } from 'vitest';
import { handleMessage, PROTOCOL_VERSION, type Tool } from '../src/mcp/protocol';
import { characterSummary, comparisonSummary, pickStats, statsSummary } from '../src/mcp/tools';
import type { Comparison, Overview } from '../src/shared/types';

const info = { name: 'poe2-build-companion', version: '1.2.3', instructions: 'Read-only.' };
const echo: Tool = {
  name: 'echo',
  title: 'Echo',
  description: 'Returns its input',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  run: async (args) => ({ said: args.text }),
};
const broken: Tool = { ...echo, name: 'broken', inputSchema: { type: 'object', properties: {} }, run: async () => { throw new Error('The AI connection is turned off.'); } };
const call = (msg: object) => handleMessage(JSON.stringify({ jsonrpc: '2.0', ...msg }), info, [echo, broken]);

describe('MCP protocol', () => {
  it('answers initialize with the tools capability and instructions', async () => {
    const r = (await call({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } } })) as any;
    expect(r.id).toBe(1);
    expect(r.result.protocolVersion).toBe('2025-03-26');
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.result.serverInfo).toEqual({ name: 'poe2-build-companion', version: '1.2.3' });
    expect(r.result.instructions).toBe('Read-only.');
    expect(((await call({ id: 2, method: 'initialize', params: {} })) as any).result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('ignores notifications and lists read-only tools', async () => {
    expect(await call({ method: 'notifications/initialized' })).toBeNull();
    const r = (await call({ id: 'a', method: 'tools/list' })) as any;
    expect(r.result.tools.map((t: any) => t.name)).toEqual(['echo', 'broken']);
    expect(r.result.tools[0].annotations.readOnlyHint).toBe(true);
    expect(r.result.tools[0].run).toBeUndefined();
  });

  it('runs a tool and returns its result as JSON text', async () => {
    const r = (await call({ id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })) as any;
    expect(r.result.isError).toBe(false);
    expect(JSON.parse(r.result.content[0].text)).toEqual({ said: 'hi' });
  });

  it('reports tool problems so the AI can explain them', async () => {
    const off = (await call({ id: 4, method: 'tools/call', params: { name: 'broken', arguments: {} } })) as any;
    expect(off.result).toEqual({ content: [{ type: 'text', text: 'The AI connection is turned off.' }], isError: true });
    const missing = (await call({ id: 5, method: 'tools/call', params: { name: 'echo', arguments: {} } })) as any;
    expect(missing.result.content[0].text).toBe('Missing argument: text');
    expect(((await call({ id: 6, method: 'tools/call', params: { name: 'nope' } })) as any).error.code).toBe(-32602);
  });

  it('rejects broken input and unknown methods', async () => {
    expect(((await handleMessage('{oops', info, [])) as any).error.code).toBe(-32700);
    expect(((await call({ id: 7, method: 'resources/list' })) as any).error.code).toBe(-32601);
    expect(((await call({ id: 8, method: 'ping' })) as any).result).toEqual({});
  });
});

const item = (title: string, base: string, mods: string[]) => ({ name: `${title}, ${base}`, title, base, rarity: 'RARE' as const, corrupted: false, mods: mods.map((text) => ({ text, kind: 'explicit' as const })), raw: '' });
const overview: Overview = {
  className: 'Ranger',
  ascendancy: 'Deadeye',
  level: 94,
  mainSkill: 'Ice Shot',
  weaponSet: 1,
  stats: { Life: 1457, EnergyShield: 2150.4, ColdResist: 79, CombinedDPS: 1234567.89, SomethingElse: 5 },
  skills: [
    { group: 1, name: 'Ice Shot', dps: 1234567.89, stats: { Speed: 2.345 }, main: true },
    { group: 2, name: 'Tornado Shot', dps: 222222, stats: {} },
  ],
  gemGroups: [{ index: 1, label: null, slot: 'Weapon 1', enabled: true, main: true, gems: [{ name: 'Ice Shot', level: 20, quality: 20, support: false, enabled: true }, { name: 'Fork', support: true, enabled: false }] }],
  passives: { points: 123, weaponSetPoints: 24, ascendancyPoints: 8, nodes: [{ name: 'Endless Munitions', kind: 'ascendancy', lines: [] }] },
  gear: [
    { slot: 'Helmet', set: null, item: item('Corpse Cowl', 'Ancestral Tiara', ['+67 to maximum Energy Shield']) },
    { slot: 'Gloves', set: null, item: null },
  ],
  jewels: [],
};

describe('MCP tools: what the AI sees', () => {
  it('summarises the character with gear, gems and keystones', () => {
    const c = characterSummary(overview, 'Path of Building file "ZaserRanger"');
    expect(c).toMatchObject({ class: 'Ranger', ascendancy: 'Deadeye', level: 94, mainSkill: 'Ice Shot' });
    expect(c.gear).toEqual([{ slot: 'Helmet', name: 'Corpse Cowl', base: 'Ancestral Tiara', rarity: 'RARE', mods: ['+67 to maximum Energy Shield'] }]);
    expect(c.skills[0].gems).toEqual(['Ice Shot 20/20%', 'Fork (support) (off)']);
    expect(c.passives.ascendancyAndKeystones).toEqual(['Endless Munitions']);
  });

  it('keeps the stats that matter, rounded, and the strongest skills', () => {
    expect(pickStats(overview.stats)).toEqual({ Life: 1457, EnergyShield: 2150, ColdResist: 79, CombinedDPS: 1234568 });
    const s = statsSummary(overview);
    expect(s.skills.map((x) => x.name)).toEqual(['Ice Shot', 'Tornado Shot']);
    expect(s.skills[0]).toMatchObject({ dps: 1234568, main: true, stats: { Speed: 2.35 } });
  });

  it('turns a PoB comparison into changes in % per slot', () => {
    const c: Comparison = {
      item: item('Hate Spiral', 'Topaz Ring', ['+30% to Lightning Resistance']),
      before: { CombinedDPS: 1000, TotalEHP: 20000 },
      slots: [{ slot: 'Ring 2', replaces: 'Armageddon Hold', after: { CombinedDPS: 1040, TotalEHP: 20900 }, delta: { CombinedDPS: 40, TotalEHP: 900, LightningResist: 3, Unrelated: 1 } }],
    };
    expect(comparisonSummary(c).slots[0]).toEqual({ slot: 'Ring 2', replaces: 'Armageddon Hold', dpsChangePct: 4, ehpChangePct: 4.5, changes: { CombinedDPS: 40, TotalEHP: 900, LightningResist: 3 } });
  });
});
