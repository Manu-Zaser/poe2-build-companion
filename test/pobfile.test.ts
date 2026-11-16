import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeBuildCode, encodeBuildCode, normalizeBuildCode } from '../src/shared/buildcode';
import { describeBuildHead, findBuildsDir, listBuildFiles, readBuildFile, watchBuildFile } from '../src/main/pobfile';

const xml = decodeBuildCode(readFileSync(join(__dirname, 'fixtures/deadeye.code'), 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'companion-pobfile-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('encodeBuildCode', () => {
  it('round-trips with decodeBuildCode and is a valid code', () => {
    const code = encodeBuildCode(xml);
    expect(normalizeBuildCode(code)).toBe(code);
    expect(decodeBuildCode(code)).toBe(xml);
  });
});

describe('PoB build files', () => {
  const docs = join(root, 'Documents');
  const builds = join(docs, 'Path of Building (PoE2)', 'Builds');
  mkdirSync(join(builds, 'Leagues'), { recursive: true });
  writeFileSync(join(builds, 'Deadeye.xml'), xml);
  writeFileSync(join(builds, 'Leagues', 'Old.xml'), xml.replace('level="100"', 'level="42"'));
  writeFileSync(join(builds, 'PoE1.xml'), '<?xml version="1.0"?><PathOfBuilding><Build level="90"/></PathOfBuilding>');
  writeFileSync(join(builds, 'notes.txt'), 'hello');
  utimesSync(join(builds, 'Leagues', 'Old.xml'), new Date('2026-01-01'), new Date('2026-01-01'));

  it('finds the default folder and a folder set in PoB', () => {
    expect(findBuildsDir(docs)).toBe(builds);
    const custom = join(root, 'MyBuilds');
    mkdirSync(custom);
    writeFileSync(join(docs, 'Path of Building (PoE2)', 'Settings.xml'), `<PathOfBuilding><Misc buildPath="${custom}\\" /></PathOfBuilding>`);
    expect(findBuildsDir(docs)).toBe(custom);
    rmSync(join(docs, 'Path of Building (PoE2)', 'Settings.xml'));
  });

  it('lists PoE2 builds incl. sub-folders, newest first', () => {
    const list = listBuildFiles(builds);
    expect(list.map((f) => [f.name, f.level, f.className])).toEqual([
      ['Deadeye', 100, 'Deadeye'],
      ['Old', 42, 'Deadeye'],
    ]);
  });

  it('reads the head of a build', () => {
    expect(describeBuildHead('<PathOfBuilding2><Build level="7" className="Witch" ascendClassName="None">')).toEqual({ level: 7, className: 'Witch' });
    expect(describeBuildHead('<PathOfBuilding><Build level="7">')).toBeNull();
  });

  it('reads a build and explains wrong or half-written files', () => {
    expect(readBuildFile(join(builds, 'Deadeye.xml')).xml).toBe(xml);
    expect(() => readBuildFile(join(builds, 'PoE1.xml'))).toThrow(/Path of Exile 1/);
    expect(() => readBuildFile(join(builds, 'notes.txt'))).toThrow(/\.xml/);
    expect(() => readBuildFile(join(builds, 'missing.xml'))).toThrow(/no longer exists/);
    writeFileSync(join(builds, 'Half.xml'), xml.slice(0, 2000));
    expect(() => readBuildFile(join(builds, 'Half.xml'))).toThrow(/incomplete/);
  });

  it('notices when PoB saves the file', async () => {
    const file = join(builds, 'Deadeye.xml');
    let calls = 0;
    const stop = watchBuildFile(file, () => calls++, 100);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(file, xml.replace('level="100"', 'level="99"'));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await new Promise((r) => setTimeout(r, 600));
    stop();
    expect(calls).toBe(1);
  });
});
