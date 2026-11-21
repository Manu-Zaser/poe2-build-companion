/**
 * Creating a target build from PoB XML – shared by the app and the MCP server, so both check and store it
 * the same way.
 */
import { encodeBuildCode, normalizeBuildCode } from './buildcode';
import { fitCount, fitForSlot, parseTargetBuild, type TargetBuild } from './targets';
import type { GearSlot, StoredTarget } from './types';

export const targetName = (b: TargetBuild) => [b.ascendancy ?? b.className, b.level ? `level ${b.level}` : ''].filter(Boolean).join(' ') || 'Target build';

/** Checks the build and makes the stored form. Throws with a user-facing message. */
export function makeTarget(xml: string, name: string | null, source: StoredTarget['source'], link?: string): { target: StoredTarget; build: TargetBuild } {
  const build = parseTargetBuild(xml);
  if (build.slots.length === 0) throw new Error('This build has no equipment to compare with. Use a build that has items, e.g. from a guide.');
  const code = normalizeBuildCode(encodeBuildCode(xml));
  if (!code) throw new Error('This build is too large.');
  const target: StoredTarget = { code, name: (name ?? targetName(build)).slice(0, 200), source, ...(link ? { link: link.slice(0, 500) } : {}), importedAt: new Date().toISOString() };
  return { target, build };
}

/** The player's gear against the target, slot by slot (what the AI and the progress card show). */
export function targetProgress(build: TargetBuild, gear: GearSlot[]) {
  return build.slots
    .filter((t) => t.wanted.length > 0)
    .map((t) => {
      const worn = gear.find((g) => g.slot === t.slot && g.item)?.item ?? null;
      const fit = worn ? fitForSlot(build, t.slot, worn) : null;
      const count = fit ? fitCount(fit) : { have: 0, total: t.wanted.filter((w) => !w.minor).length };
      return {
        slot: t.slot,
        target: t.unique ? `${t.name} (unique)` : `${t.name}, ${t.base}`,
        wanted: t.wanted.map((w) => `${w.label}${w.value !== undefined ? ` (guide: ${w.value})` : ''}${w.minor ? ' – minor' : ''}`),
        worn: worn ? (worn.title ?? worn.name) : null,
        matches: `${count.have} of ${count.total}`,
        missing: fit ? fit.missing.filter((w) => !w.minor).map((w) => w.label) : t.wanted.filter((w) => !w.minor).map((w) => w.label),
      };
    });
}
