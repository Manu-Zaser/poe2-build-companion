import { describe, expect, it } from 'vitest';
import { characterLink, fetchNinjaBuild, parseCharacterLink } from '../src/shared/ninja';

describe('parseCharacterLink', () => {
  it('reads league, account and character', () => {
    expect(parseCharacterLink('https://poe.ninja/poe2/builds/forbiddenrites/character/Some-1234/MyChar?i=0&search=class%3DDeadeye')).toEqual({
      league: 'forbiddenrites',
      account: 'Some-1234',
      character: 'MyChar',
    });
  });

  it('reads a profile page link', () => {
    expect(parseCharacterLink('https://poe.ninja/poe2/profile/Some-1234/forbiddenrites/character/MyChar')).toEqual({
      league: 'forbiddenrites',
      account: 'Some-1234',
      character: 'MyChar',
    });
  });

  it('decodes escaped names and accepts links without protocol', () => {
    expect(parseCharacterLink(' poe.ninja/poe2/builds/standard/character/A-1/Bowber%C3%A0/ ')).toEqual({
      league: 'standard',
      account: 'A-1',
      character: 'Bowberà',
    });
  });

  it('rejects other links', () => {
    expect(parseCharacterLink('https://poe.ninja/poe2/builds/forbiddenrites')).toBeNull();
    expect(parseCharacterLink('https://poe.ninja/builds/settlers/character/A-1/B')).toBeNull();
    expect(parseCharacterLink('https://example.com/poe2/builds/x/character/A-1/B')).toBeNull();
  });

  it('round-trips through characterLink', () => {
    const c = { league: 'forbiddenrites', account: 'A-1', character: 'Bowberà' };
    expect(parseCharacterLink(characterLink(c))).toEqual(c);
  });
});

describe('fetchNinjaBuild', () => {
  type Reply = { status?: number; body?: string; throws?: boolean };
  const fakeFetch = (code: Reply, model: Reply) => {
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      const r = url.includes('/pob/raw/') ? code : model;
      if (r.throws) throw new Error('offline');
      const status = r.status ?? 200;
      return { ok: status === 200, status, text: async () => r.body ?? '' };
    };
    return { f, urls };
  };
  const me = { league: 'forbiddenrites', account: 'A-1', character: 'My Char' };
  const model = JSON.stringify({ type: 'found', charModel: { lastCheckedUtc: '2026-11-15T21:35:10Z', updatedUtc: '2026-11-15T20:43:14Z', level: 94, class: 'Deadeye' } });

  it('loads the code from the profile and adds the timestamps', async () => {
    const { f, urls } = fakeFetch({ body: 'eNrtCODE\n' }, { body: model });
    expect(await fetchNinjaBuild(me, 'test', f)).toEqual({
      code: 'eNrtCODE',
      checkedAt: '2026-11-15T21:35:10Z',
      updatedAt: '2026-11-15T20:43:14Z',
      level: 94,
      className: 'Deadeye',
    });
    expect(urls).toEqual([
      'https://poe.ninja/poe2/pob/raw/profile/code/A-1/forbiddenrites/My%20Char',
      'https://poe.ninja/poe2/api/profile/characters/A-1/forbiddenrites/My%20Char/model/60',
    ]);
  });

  it('still returns the code when the profile data fails', async () => {
    expect(await fetchNinjaBuild(me, 't', fakeFetch({ body: 'eNrtCODE' }, { status: 500 }).f)).toEqual({ code: 'eNrtCODE' });
    expect(await fetchNinjaBuild(me, 't', fakeFetch({ body: 'eNrtCODE' }, { body: 'not json' }).f)).toMatchObject({ code: 'eNrtCODE' });
  });

  it('explains an unknown character, an empty code and network errors', async () => {
    await expect(fetchNinjaBuild(me, 't', fakeFetch({ status: 404 }, {}).f)).rejects.toThrow(/does not know this character/);
    await expect(fetchNinjaBuild(me, 't', fakeFetch({ body: ' ' }, {}).f)).rejects.toThrow(/no Path of Building code/);
    await expect(fetchNinjaBuild(me, 't', fakeFetch({ throws: true }, {}).f)).rejects.toThrow(/could not be reached/);
  });
});
