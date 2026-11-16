import { describe, expect, it } from 'vitest';
import { characterLink, fetchNinjaBuild, fetchNinjaIcons, iconsFromModel, parseCharacterLink } from '../src/shared/ninja';

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
  const model = JSON.stringify({ type: 'found', charModel: {
    lastCheckedUtc: '2026-11-15T21:35:10Z',
    updatedUtc: '2026-11-15T20:43:14Z',
    level: 94,
    class: 'Deadeye',
    league: 'Forbidden Rites',
    items: [
      { itemData: { inventoryId: 'Weapon', name: 'Morbid Stinger', typeLine: 'Obliterator Bow', icon: 'https://web.poecdn.com/gen/image/bow.png', w: 2, h: 4 } },
      { itemData: { inventoryId: 'Helm', name: 'Evil', typeLine: 'Cap', icon: 'https://evil.example/x.png' } },
    ],
    flasks: [{ itemData: { inventoryId: 'Flask', name: '', typeLine: 'Opaque Ultimate Life Flask of the Surgeon', icon: 'https://web.poecdn.com/f.png', x: 0 } }],
  } });

  it('loads the code from the profile and adds the timestamps', async () => {
    const { f, urls } = fakeFetch({ body: 'eNrtCODE\n' }, { body: model });
    expect(await fetchNinjaBuild(me, 'test', f)).toEqual({
      code: 'eNrtCODE',
      checkedAt: '2026-11-15T21:35:10Z',
      updatedAt: '2026-11-15T20:43:14Z',
      level: 94,
      className: 'Deadeye',
      leagueName: 'Forbidden Rites',
      icons: [
        { name: 'Morbid Stinger, Obliterator Bow', inventoryId: 'Weapon', x: undefined, w: 2, h: 4, url: 'https://web.poecdn.com/gen/image/bow.png' },
        { name: 'Opaque Ultimate Life Flask of the Surgeon', inventoryId: 'Flask', x: 0, w: undefined, h: undefined, url: 'https://web.poecdn.com/f.png' },
      ],
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

describe('item pictures', () => {
  it('keeps base and marks uniques', () => {
    const icons = iconsFromModel({
      items: [
        { itemData: { inventoryId: 'Gloves', name: 'Grim Claw', typeLine: 'Barbed Bracers', baseType: 'Barbed Bracers', frameTypeId: 'Rare', icon: 'https://web.poecdn.com/g.png' } },
        { itemData: { inventoryId: 'Belt', name: 'Headhunter', typeLine: 'Heavy Belt', baseType: 'Heavy Belt', frameTypeId: 'Unique', icon: 'https://web.poecdn.com/hh.png' } },
      ],
    });
    expect(icons.map((i) => [i.name, i.base, i.unique])).toEqual([
      ['Grim Claw, Barbed Bracers', 'Barbed Bracers', undefined],
      ['Headhunter, Heavy Belt', 'Heavy Belt', true],
    ]);
  });

  it('loads only the profile data for pictures', async () => {
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ charModel: { items: [{ itemData: { inventoryId: 'Helm', name: '', typeLine: 'Cap', icon: 'https://web.poecdn.com/c.png' } }] } }) };
    };
    const icons = await fetchNinjaIcons({ league: 'forbiddenrites', account: 'A-1', character: 'B' }, 't', f);
    expect(icons.map((i) => i.name)).toEqual(['Cap']);
    expect(urls).toEqual(['https://poe.ninja/poe2/api/profile/characters/A-1/forbiddenrites/B/model/60']);
  });
});
