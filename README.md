# PoE2 Build Companion

Desktop tool for Path of Exile 2 that knows your character and the build you follow, and answers one question
for an item you just found: *is it better than what I wear, and does it fit my build?*

Status: **Phase 3 (target build) – done.** Phases 0–3 of the concept are complete; next: a distributable exe.

> This product isn't affiliated with or endorsed by Grinding Gear Games in any way.
> Uses [Path of Building PoE2](https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2) (MIT, © David Gowor)
> as its calculation engine, unchanged, as a git submodule.

## Upgrades

On the *Upgrades* page, set a budget per item (Divine or Exalted), how much damage vs. defence counts, and the slots
to search. One click on **Find upgrades** then, per slot:

1. Path of Building weighs every mod that can roll on the slot by what it adds to your build (its own trade
   search generator).
2. Those weights become a short list of stats that matter: variants of the same stat are merged into the trade
   site's totals (single, hybrid and all-resistance mods → "total Cold Resistance"; life, mana, attributes), defence
   mods count only in the variant that works on your base (and the search stays on bases with the same defences),
   and stats worth less than 30 % of the best one are left out. The page shows what was searched for.
3. The trade site is searched **anonymously** – no login, no POESESSID, never PoB's OAuth token. A weighted search
   is too complex without login, so this is a "count" search (at least 4 of the stats with a good roll, one less
   and 70 % of the roll if that finds too little), priced up to the budget. Boots keep at least your current
   movement speed.
4. 30 listings (the cheapest ones plus a spread up to the budget) are calculated one by one in your build, exactly
   like the item check.
5. The page lists the best per slot with price, DPS, effective HP and overall gain. Items that newly drop a
   resistance below the cap, miss an attribute requirement, overdraw spirit or lose movement speed are never shown
   as upgrades.

**At least what you wear** (switch) sets each searched stat's minimum to the value on your worn item, so only items
that beat yours stat by stat are found.

Damage means your main skill's DPS. If the main skill selected in Path of Building does no damage (e.g. an aura
group), the skill with the highest DPS is used instead – for the item check too – and the page says so.

Buying stays with you: click a listing to open the trade site with that listing on top (each slot also links its
whole search). **Weighted search** opens Path of Building's own weighted search for the slot in your browser – every
mod weighted for your build, only items scoring higher than the worn one, within the budget, best first. It is too
complex for anonymous requests, but the trade site runs it when you are signed in there; the app sends nothing. Listings above the budget are left out even if the trade site lets them through – it converts
prices with its own exchange rate. The search waits for the trade site's rate
limits and stops (keeping what it found) if a limit would be exceeded. Prices are converted with poe.ninja's
exchange rates.

## AI connection (MCP, optional)

An AI assistant on the same computer (Claude Desktop, Claude Code, Codex CLI, Gemini CLI, VS Code, LM Studio … – anything
that speaks MCP) can read the build and let Path of Building calculate items. **Off by default**: turn it on under
*AI connection* ("Allow AI assistants to read my build"); while it is off, every call answers that it is off.

The page shows the entry to add to the AI program (`mcpServers` JSON and a `claude mcp add …` line) with Copy buttons.
The AI program starts the server itself: this app's exe in Node mode (`ELECTRON_RUN_AS_NODE=1`) with `dist/mcp.js` –
the app does not need to be open. Local only (stdio, no network port), no login; nothing is sent to the game or the
trade site. The only thing an assistant can change is the target build (a running app takes it over right away).

| Tool | Returns |
|---|---|
| `get_character` | Class, ascendancy, level, main skill, equipped items with mods, jewels, skill gems, keystones |
| `get_stats` | Life, ES, mana, spirit, evasion, resistances, maximum hits, EHP, attributes, DPS of the strongest skills |
| `evaluate_item` | For an item text: DPS and EHP change in % per slot it fits, and the changed stats |
| `get_target` | The target build and, per slot, which of its stats the worn item has and which are missing |
| `set_target_build` | Sets the target build from a PoB code or a link (pobb.in, pastebin, poe.ninja, a page with a PoB code) |

The build is the one loaded in the app – the watched PoB file is read fresh on every call, so a save in PoB is seen
right away.

## Target build (phase 3)

On the *Target build* page, set the build you follow – paste its Path of Building code (e.g. from a guide), use a
build saved in Path of Building 2, or paste a **link**: pobb.in, pastebin, a poe.ninja character, or a guide page that
contains a PoB code or a pobb.in link (read once, when you click). Pages behind bot checks – e.g. Mobalytics – cannot be
read automatically; copy the code from their "Path of Building" button instead. Each slot's item becomes a short list of target stats (boots: movement speed, life,
resistances …; a unique: that unique).

- **Item check:** the overlay adds "Fits your build: 3 of 4 target stats" with a checklist (✓ has, ✗ missing, your
  roll next to the guide's). Rings are compared with both target rings; for a unique target it says whether this is
  that unique.
- **Progress:** the page shows your gear against the target per slot and in total ("5 of 24 target stats").
- An item counts as soon as it has the stat – the guide's values are shown for orientation, not as a minimum.
  "+x% to all Elemental Resistances" covers a single elemental resistance. Filler stats (item rarity, light radius,
  stun threshold, on-kill effects …) are shown in grey and do not count.

## Item check (phase 2)

Hover over an item in game and press the hotkey (default **Alt+D**, changeable on the *Item check* page). The
overlay answers within a fraction of a second:

- **Verdict:** better for your build, worse, a trade-off or about the same – from the change in DPS of your main skill
  and your effective health pool, calculated by Path of Building with the item in the slot.
- **Hard warnings first:** a resistance falls (further) below the cap, an attribute requirement is no longer met,
  spirit no longer covers your reservations. Any of these makes the verdict *Careful*.
- **Changes:** DPS, effective HP, life, energy shield, mana, resistances, max physical hit, evasion, armour,
  deflection, free spirit and attributes. Rings are checked in both slots (best first), weapons in the weapon set
  your build uses.
- **Equip in my build** puts the item into the local copy of your build – no new import needed. The character page
  shows "1 item changed since" with a *Reset* button; local items are applied on top of every load and kept after a
  poe.ninja refresh until poe.ninja has seen the change.
- **Find better … on the trade site** opens Path of Building's weighted search for that slot in your browser – every
  mod weighted for your build, only items scoring higher than what you wear, best first; weighting and budget as on
  the *Upgrades* page. Sign in on the trade site there; the app sends no trade request for it.

The overlay stays open until you close it (× or Esc), can be dragged from anywhere and remembers its position.

## Character page (phase 1)

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
  - **Path of Building 2 file** (always up to date): import your character in PoB 2 (*Items and Skills*, *Passive
    Tree and Jewels*) and save with Ctrl+S. Choose the build once on the *Build source* page – the app watches the
    file and reloads it on every save. PoB keeps its own API access; the app only reads the saved file on this
    computer. The build folder is found automatically (`Documents\Path of Building (PoE2)\Builds` or the folder set
    in PoB's options). PoB files contain no pictures: if a poe.ninja link is set, the item pictures come from that
    profile (at most one request every 10 minutes) – by item name, and for rare/magic items also by base type, since
    they look like their base. Uniques poe.ninja has not seen yet show their name.
  - **poe.ninja:** paste your character link (profile or builds page) once, then *Refresh* loads the latest state with one
    click. Requires a public profile; the state is as fresh as poe.ninja's last check, which is shown.
  - **Path of Building code:** *Paste build code* reads the clipboard once, on click – works with private profiles.
- Shows how old the loaded state is and suggests refreshing after three days.

**Game rules:** one hotkey press sends exactly one copy command (Ctrl+Alt+C) to the game and reads the clipboard
once; the previous clipboard content is restored. No memory reading, no automation, no game files touched. Otherwise
the clipboard is only read when you click *Paste build code*. PoB's OAuth client id is
never used and no GGG API is called; the only connection to GGG is loading the item pictures from their public image
CDN (web.poecdn.com), with the links poe.ninja provides.

## Running from source

Hotkey handling, the one-keystroke item copy, the Win32 helpers and logging come from the shared
[`@poe2/core`](https://github.com/Manu-Zaser/poe2-core) package (also used by PoE2 Price Check). Clone it **next to**
this repository – the tool references it as `../core`:

```bash
git clone https://github.com/Manu-Zaser/poe2-core.git core
git clone https://github.com/Manu-Zaser/poe2-build-companion.git build-check
cd build-check
git submodule update --init --depth 1
npm install
npm start
```

Other scripts: `npm test` (vitest), `npm run typecheck`, `npm run engine-check` (engine without window: load a
build code, print stats, compare items). Invisible UI test (hidden window, own profile, fixture clipboard):

```bash
npm run build
npx electron scripts/run-hidden.cjs scripts/ui-check.cjs <output folder>     # character page
npx electron scripts/run-hidden.cjs scripts/check-ui.cjs <output folder>     # item check and overlay
npx electron scripts/run-hidden.cjs scripts/target-ui.cjs <output folder>    # target build and fit checklist
npx electron scripts/run-hidden.cjs scripts/file-ui.cjs <output folder>      # PoB file source (own test folder)
npx electron scripts/run-hidden.cjs scripts/upgrades-ui.cjs <output folder>  # upgrades page (offline; UP_LIVE=1 searches the trade site)
```

The tests never register the global hotkey and never send keys; the item check is called with fixture texts.

## Layout

```
vendor/PathOfBuilding-PoE2   PoB PoE2, unchanged (git submodule)
src/engine/host.ts           Engine process: loads PoB's own LuaJIT (runtime/lua51.dll) via koffi; JSON lines on
                             stdin/stdout. Started by the app as Electron in Node mode – no extra runtime.
src/engine/bridge.lua        Lua side: boots PoB headless; commands "load", "overview", "compare", "equip",
                             "upgradeQuery" (PoB's mod weights for a slot), "evaluate" (many items in one slot)
src/main/                    Electron main process: window, storage, engine client, poe.ninja refresh, PoB build
                             files (pobfile.ts: find, list, read, watch), hotkey, overlay window
src/main/upgradesearch.ts    Upgrade search flow (PoB weights → trade search → fetch → PoB → ranking)
src/shared/                  Build code decoding, poe.ninja lookup, verdict and warnings, target build and fit
                             (targets.ts), trade listing → PoB item text (tradeitem.ts), upgrade search query and
                             ranking (upgrades.ts), types
src/renderer/                Character, build source and item check pages; overlay
src/mcp/                     Optional MCP server for AI assistants: protocol.ts (JSON-RPC over stdio, no
                             dependency), tools.ts (what the AI sees), server.ts (build loading, engine)
../core (@poe2/core)         Shared with Price Check: hotkey helpers, one copy keystroke (Ctrl+Alt+C) and window
                             focus, reading the item text, log file, trade client, poe.ninja exchange rates
```

Settings and the last build are stored in `%APPDATA%\PoE2 Build Companion\companion.json`; the log file
`companion.log` is in the same folder.

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
