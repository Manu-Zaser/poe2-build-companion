# PoE2 Build Companion

Desktop tool for Path of Exile 2 that knows your character and the build you follow, and answers one question
for an item you just found: *is it better than what I wear, and does it fit my build?*

Status: **Phase 0 (feasibility) – done.** See results below.

> This product isn't affiliated with or endorsed by Grinding Gear Games in any way.
> Uses [Path of Building PoE2](https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2) (MIT, © David Gowor)
> as its calculation engine, unchanged, as a git submodule.

## Layout

```
vendor/PathOfBuilding-PoE2   PoB PoE2, unchanged (git submodule)
spike/pob-host.mjs           Runs PoB headless in Node: loads PoB's own LuaJIT (runtime/lua51.dll) via koffi,
                             JSON lines on stdin/stdout, PoB console output on stderr
spike/bridge.lua             Lua side: boots HeadlessWrapper.lua, commands "load" and "compare"
spike/run.mjs                Phase 0 test: spawns the host, loads a build code, checks items, prints timings
spike/fixtures/deadeye.code  Public build code (poe.ninja) used for the test
```

## Running the spike

```bash
git submodule update --init --depth 1
npm install
npm run spike
# or with your own build code and item texts (Ctrl+C in game):
node spike/run.mjs my-build.code item1.txt item2.txt
```

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
