# PoE2 Build Companion

Desktop tool for Path of Exile 2 that knows your character and the build you follow, and answers one question
for an item you just found: *is it better than what I wear, and does it fit my build?*

Status: **Phase 1 (character overview) – done.** Next: phase 2, item check per hotkey.

> This product isn't affiliated with or endorsed by Grinding Gear Games in any way.
> Uses [Path of Building PoE2](https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2) (MIT, © David Gowor)
> as its calculation engine, unchanged, as a git submodule.

## What it does (phase 1)

The character page is laid out like a character profile on poe.ninja:

- **Header:** league, character, level and class, account, when poe.ninja last fetched the character, buttons to
  copy the build code for Path of Building, paste a code or refresh.
- **Equipment** in the in-game arrangement with item pictures (from the poe.ninja profile; with a pasted code the
  item names are shown instead), weapon set I/II toggle, flasks and charms, jewels. Hovering an item shows its
  modifiers like the in-game tooltip.
- **Stats column:** character (attributes, movement speed, rarity, charges), defensive (life, ES, mana, spirit,
  armour, evasion, deflection, resistances, effective HP, max hit per damage type), recovery (regen, leech,
  ES recharge) and main skills (DPS, attack rate, crit, hit chance, projectiles, radius). Warnings for resistances
  below the cap, unmet attribute requirements and over-reserved spirit.
- **Skills** with their gems (level, quality, supports), main skill highlighted.
- **Ascendancy & keystones** with their effects and point counts.
- **DPS per skill** is calculated as if each skill were the main skill (the number PoB shows when you select it).
- **Build source:**
  - **poe.ninja** (recommended): paste your character link (profile or builds page) once, then *Refresh* loads the latest state with one
    click. Requires a public profile; the state is as fresh as poe.ninja's last check, which is shown.
  - **Path of Building code:** *Paste build code* reads the clipboard once, on click – works with private profiles.
- Shows how old the loaded state is and suggests refreshing after three days.

Nothing is sent to the game, no hotkeys yet, the clipboard is never read in the background. PoB's OAuth client id is
never used and no GGG API is called; the only connection to GGG is loading the item pictures from their public image
CDN (web.poecdn.com), with the links poe.ninja provides.

## Running from source

```bash
git submodule update --init --depth 1
npm install
npm start
```

Other scripts: `npm test` (vitest), `npm run typecheck`, `npm run engine-check` (engine without window: load a
build code, print stats, compare items). Invisible UI test (hidden window, own profile, fixture clipboard):

```bash
npm run build
npx electron scripts/run-hidden.cjs scripts/ui-check.cjs <output folder>
```

## Layout

```
vendor/PathOfBuilding-PoE2   PoB PoE2, unchanged (git submodule)
src/engine/host.ts           Engine process: loads PoB's own LuaJIT (runtime/lua51.dll) via koffi; JSON lines on
                             stdin/stdout. Started by the app as Electron in Node mode – no extra runtime.
src/engine/bridge.lua        Lua side: boots PoB headless; commands "load", "overview", "compare"
src/main/                    Electron main process: window, storage, engine client, poe.ninja refresh
src/shared/                  Build code decoding, poe.ninja lookup, shared types
src/renderer/                Character and build source pages
```

Settings and the last build are stored in `%APPDATA%\poe2-build-companion\companion.json`.

## Phase 0 results (November 2026, PoB PoE2 v0.23.1)

| Question | Result |
| --- | --- |
| Does PoB PoE2 run headless on Windows? | Yes. No separate `luajit.exe` needed: PoB ships LuaJIT as a 64-bit `lua51.dll`, loaded via koffi (same FFI library as Price Check). Only two shims: `arg = {}` and keeping HeadlessWrapper from reading stdin on startup errors. |
| Do the numbers match PoB? | Yes, **exactly**. All 30 checked values (Life, ES, Mana, Spirit, Evasion, Armour, resistances incl. overcap, max hit per type, EHP, Combined/Total DPS, attributes and requirements) are identical to the `PlayerStat` values poe.ninja's PoB stored in the code. |
| Item swap and recalculation | Uses PoB's own tooltip comparison (`calcsTab:GetMiscCalculator()` with `repSlotName`/`repItem`), so the build is never modified. An equipped item checked against itself gives zero difference in every slot tested. Rings are checked in both slots, weapons only in the active weapon set. Item text copied in game (incl. advanced copy with tiers) parses directly. |
| Speed | PoB startup **~2.4 s** (once per app start), build load **~0.8 s** (once per build code), item check **10–40 ms**. Target of < 1 s per item check is easily met. |

### Findings for the next phases

- **Build code decoding** (`-`/`_` → base64 → zlib → XML) happens in Node; PoB's headless `Inflate` stub returns an
  empty string, so it must not be used for that.
- **FullDPS** is 0 unless skills are flagged for it in the build; use `CombinedDPS` of the main skill as default.
- The build's **active weapon set** matters (`mainEnv.weaponSet`); the test build fights from weapon set 2, so a bow
  is compared against `Weapon 1 Swap`. The overlay must say which set/slot it compared against.
- PoB prints "missing node …" warnings for the passive tree when headless; harmless for calculations.
- PoB's own stdout output must stay off the JSON channel; `bridge.lua` redirects `print` to stderr.

## License

MIT for this project's code. Path of Building is MIT-licensed (see `vendor/PathOfBuilding-PoE2/LICENSE.md`).
Game data contained in PoB belongs to Grinding Gear Games.
