-- Bridge between the engine host and Path of Building PoE2 (headless).
-- Runs inside PoB's own LuaJIT (runtime/lua51.dll) with the working directory set to PoB's src/.
-- The host calls the global function __bridge(requestJson) and gets a JSON string back.
-- PoB itself stays unchanged; everything here only uses its public objects (build, itemsTab, calcsTab).

-- stdout belongs to the JSON protocol; everything PoB prints goes to stderr.
function print(...)
	local parts = {}
	for i = 1, select("#", ...) do
		parts[#parts + 1] = tostring((select(i, ...)))
	end
	io.stderr:write(table.concat(parts, "\t"), "\n")
end

package.path = "../runtime/lua/?.lua;../runtime/lua/?/init.lua;" .. package.path
package.cpath = "../runtime/?.dll;" .. package.cpath

-- PoB's Main.lua reads command-line arguments; the standalone interpreter would set this.
arg = {}

-- On a startup error HeadlessWrapper waits for Enter on stdin, which is our protocol channel.
local ioRead = io.read
io.read = function() return nil end
dofile("HeadlessWrapper.lua")
io.read = ioRead
if __mainObject__.promptMsg then
	error("PoB startup failed: " .. tostring(__mainObject__.promptMsg))
end

local dkjson = require("dkjson")
local JSON_NULL = dkjson.null

local function round(v, digits)
	if type(v) ~= "number" or v ~= v or v == math.huge or v == -math.huge then
		return nil
	end
	local m = 10 ^ (digits or 1)
	return math.floor(v * m + 0.5) / m
end

-- Values shown in the overview and compared in item checks. Names are PoB output keys.
local STATS = {
	"Life", "EnergyShield", "Mana", "Spirit", "SpiritUnreserved", "Evasion", "Armour",
	"DeflectChance", "DeflectionRating", "EffectiveMovementSpeedMod",
	"TotalEHP", "PhysicalMaximumHitTaken", "FireMaximumHitTaken", "ColdMaximumHitTaken",
	"LightningMaximumHitTaken", "ChaosMaximumHitTaken",
	"CombinedDPS", "TotalDPS", "FullDPS",
	"Str", "Dex", "Int", "ReqStr", "ReqDex", "ReqInt",
	-- character / defence / recovery details for the stats column
	"EffectiveLootRarityMod", "EnduranceChargesMax", "FrenzyChargesMax", "PowerChargesMax",
	"EvadeChance", "PhysicalDamageReduction", "EffectiveBlockChance", "Ward",
	"LifeRegenRecovery", "ManaRegenRecovery", "EnergyShieldRegenRecovery",
	"LifeLeechGainRate", "ManaLeechGainRate", "EnergyShieldLeechGainRate",
	"EnergyShieldRecharge", "EnergyShieldRechargeDelay",
}

-- Per-skill values shown under "Main skills".
local SKILL_STATS = {
	"CombinedDPS", "TotalDPS", "Speed", "HitSpeed", "HitChance", "CritChance", "CritMultiplier",
	"ProjectileCount", "AreaOfEffectRadiusMetres",
}
local ELEMENTS = { "Fire", "Cold", "Lightning", "Chaos" }
for _, e in ipairs(ELEMENTS) do
	STATS[#STATS + 1] = e .. "Resist"
	STATS[#STATS + 1] = e .. "ResistTotal"
	STATS[#STATS + 1] = e .. "ResistOverCap"
	STATS[#STATS + 1] = "Missing" .. e .. "Resist"
end

local function pickStats(output)
	local res = {}
	for _, k in ipairs(STATS) do
		local v = round(output[k], 3)
		if v ~= nil then
			res[k] = v
		end
	end
	return res
end

-- Item text lines as the game shows them, grouped by kind.
local function modLines(item)
	local lines = {}
	local function add(list, kind)
		for _, ml in ipairs(list or {}) do
			if ml.line and ml.line ~= "" then
				lines[#lines + 1] = { text = ml.line, kind = kind, inactive = ml.modList == nil or nil }
			end
		end
	end
	add(item.enchantModLines, "enchant")
	add(item.runeModLines, "rune")
	add(item.implicitModLines, "implicit")
	add(item.explicitModLines, item.rarity == "UNIQUE" and "unique" or "explicit")
	return lines
end

local function describeItem(item)
	return {
		name = item.name,
		title = item.title,
		base = item.baseName,
		rarity = item.rarity,
		corrupted = item.corrupted or false,
		quality = item.quality,
		itemLevel = item.itemLevel,
		mods = modLines(item),
		raw = item:BuildRaw(),
	}
end

-- Slots shown even when empty; other slots (charms, flasks, special slots) only when filled.
local CORE_SLOTS = {
	["Weapon 1"] = true, ["Weapon 2"] = true, Helmet = true, ["Body Armour"] = true, Gloves = true,
	Boots = true, Amulet = true, ["Ring 1"] = true, ["Ring 2"] = true, Belt = true,
}

local function isJewelSlot(slotName)
	return slotName:find("^Jewel") or slotName:find("Socket") ~= nil
end

-- Equipped items in PoB's slot order: both weapon sets (set = 1 or 2), other visible slots, jewels.
local function equipped()
	local itemsTab = build.itemsTab
	local gear, jewels = {}, {}
	for _, slot in ipairs(itemsTab.orderedSlots) do
		local name = slot.slotName
		local item = itemsTab.items[slot.selItemId]
		if isJewelSlot(name) then
			if item then
				jewels[#jewels + 1] = { slot = name, item = describeItem(item) }
			end
		elseif (slot.weaponSet or not slot.shown or slot.shown()) and (item or CORE_SLOTS[name:gsub(" Swap$", "")]) then
			gear[#gear + 1] = { slot = name, set = slot.weaponSet or JSON_NULL, item = item and describeItem(item) or JSON_NULL }
		end
	end
	return gear, jewels
end

-- DPS of every enabled skill group, each calculated as if it were the main skill – the same number
-- PoB shows when that skill is selected. Uses PoB's calculator overrides, so the build is unchanged.
local function skillDps()
	local calcFunc = build.calcsTab:GetMiscCalculator()
	local res = {}
	for i, group in ipairs(build.skillsTab.socketGroupList) do
		local skills = group.displaySkillList
		if group.enabled ~= false and skills and #skills > 0 then
			local active = skills[group.mainActiveSkill or 1] or skills[1]
			local ok, out = pcall(calcFunc, { mainSocketGroup = i, weaponSet = group.usingSkillSet })
			local dps = ok and out and (out.CombinedDPS or out.TotalDPS) or 0
			if dps >= 1 and active.activeEffect and active.activeEffect.grantedEffect then
				local stats = {}
				for _, k in ipairs(SKILL_STATS) do
					stats[k] = round(out[k], 2)
				end
				res[#res + 1] = {
					group = i,
					name = active.activeEffect.grantedEffect.name,
					part = active.skillPartName,
					dps = round(dps, 1),
					stats = stats,
					main = i == build.mainSocketGroup or nil,
				}
			end
		end
	end
	table.sort(res, function(a, b) return a.dps > b.dps end)
	return res
end

-- Skill groups with their gems, as in PoB's Skills tab.
local function gemGroups()
	local res = {}
	for i, group in ipairs(build.skillsTab.socketGroupList) do
		local gems = {}
		for _, gem in ipairs(group.gemList or {}) do
			local granted = gem.gemData and gem.gemData.grantedEffect
			gems[#gems + 1] = {
				name = gem.nameSpec ~= "" and gem.nameSpec or (granted and granted.name) or "?",
				level = gem.level,
				quality = gem.quality,
				support = granted and granted.support or false,
				enabled = gem.enabled ~= false,
			}
		end
		if #gems > 0 then
			res[#res + 1] = {
				index = i,
				label = group.label ~= "" and group.label or JSON_NULL,
				slot = group.slot or JSON_NULL,
				fromItem = group.source ~= nil or nil,
				enabled = group.enabled ~= false,
				main = i == build.mainSocketGroup or nil,
				gems = gems,
			}
		end
	end
	return res
end

-- Allocated keystones and ascendancy nodes, plus point counts as PoB counts them.
local function passives()
	local spec = build.spec
	if not spec then
		return { points = 0, weaponSetPoints = 0, ascendancyPoints = 0, nodes = {} }
	end
	local nodes = {}
	for _, node in pairs(spec.allocNodes) do
		local kind = node.ascendancyName and not node.isAscendancyStart and (node.type == "Notable" or node.isNotable) and "ascendancy"
			or (not node.ascendancyName and node.type == "Keystone" and "keystone")
		if kind then
			nodes[#nodes + 1] = { name = node.dn, kind = kind, lines = node.sd or {} }
		end
	end
	table.sort(nodes, function(a, b)
		if a.kind ~= b.kind then return a.kind == "ascendancy" end
		return a.name < b.name
	end)
	local used, ascUsed, _, _, ws1, ws2 = spec:CountAllocNodes()
	-- Weapon set points are spent twice (once per set) but count once, as in game.
	return { points = used - ws1 - ws2 + math.max(ws1, ws2), weaponSetPoints = math.max(ws1, ws2), ascendancyPoints = ascUsed, nodes = nodes }
end

-- true when ensureMainSkill (below) had to pick the main skill because PoB's selection does no damage.
local mainSkillAuto = false

local function mainSkillName()
	local env = build.calcsTab.mainEnv
	local skill = env and env.player and env.player.mainSkill
	if skill and skill.activeEffect and skill.activeEffect.grantedEffect then
		return skill.activeEffect.grantedEffect.name
	end
end

local function overview()
	local gear, jewels = equipped()
	return {
		className = build.spec and build.spec.curClassName,
		ascendancy = build.spec and build.spec.curAscendClassName,
		level = build.characterLevel,
		mainSkill = mainSkillName(),
		mainSkillAuto = mainSkillAuto or nil,
		weaponSet = build.calcsTab.mainEnv and build.calcsTab.mainEnv.weaponSet or 1,
		stats = pickStats(build.calcsTab.mainOutput),
		skills = skillDps(),
		gemGroups = gemGroups(),
		passives = passives(),
		gear = gear,
		jewels = jewels,
	}
end

local handlers = {}

-- Item from text copied in game (or PoB's own item text). Errors if PoB does not know the base.
local function parseItem(text)
	local item = new("Item"):Item(text)
	if not item.base then
		error("Path of Building does not know this item base", 0)
	end
	item:NormaliseQuality()
	item:BuildModList()
	return item
end

-- Puts items into slots of the loaded build, like equipping them in PoB, and recalculates.
-- Returns one result per entry: { ok = true } or { error = "..." }.
local function applyEquips(equips)
	local itemsTab = build.itemsTab
	local results = {}
	for i, e in ipairs(equips or {}) do
		local ok, err = pcall(function()
			local slot = itemsTab.slots[e.slot]
			if not slot then
				error("unknown slot " .. tostring(e.slot), 0)
			end
			local item = parseItem(e.itemText)
			if not itemsTab:IsItemValidForSlot(item, e.slot) then
				error("this item does not fit into " .. e.slot, 0)
			end
			itemsTab:AddItem(item, true)
			slot:SetSelItemId(item.id)
		end)
		results[i] = ok and { ok = true } or { error = tostring(err) }
	end
	if #results > 0 then
		itemsTab:PopulateSlots()
		build.buildFlag = true
		runCallback("OnFrame")
	end
	return results
end

-- If the main skill selected in PoB does no damage (e.g. a buff or aura group is selected), all DPS
-- changes would be 0. Then the skill group with the highest DPS becomes the main skill – in this copy only.
local function ensureMainSkill()
	mainSkillAuto = false
	local out = build.calcsTab.mainOutput
	if not out or (out.CombinedDPS or 0) >= 1 or (out.TotalDPS or 0) >= 1 then
		return
	end
	local best = skillDps()[1]
	if not best then
		return
	end
	build.mainSocketGroup = best.group
	build.buildFlag = true
	runCallback("OnFrame")
	mainSkillAuto = true
end

function handlers.load(req)
	loadBuildFromXML(req.xml, req.name or "")
	if not build.calcsTab.mainOutput then
		error("The build could not be calculated")
	end
	local equips = applyEquips(req.equips)
	ensureMainSkill()
	local res = overview()
	res.equips = #equips > 0 and equips or JSON_NULL
	return res
end

function handlers.overview()
	return overview()
end

-- Equips one item in the loaded build ("Equip in my build").
function handlers.equip(req)
	local r = applyEquips({ { slot = req.slot, itemText = req.itemText } })[1]
	if r.error then
		error(r.error, 0)
	end
	return overview()
end

-- Compares an item (game copy text) against what is equipped, in every slot it fits.
function handlers.compare(req)
	local item = parseItem(req.itemText)

	local itemsTab = build.itemsTab
	local calcFunc, base = build.calcsTab:GetMiscCalculator()
	local weaponSet = build.calcsTab.mainEnv and build.calcsTab.mainEnv.weaponSet or 1
	local before = pickStats(base)
	local results = {}
	for slotName, slot in pairs(itemsTab.slots) do
		if itemsTab:IsItemValidForSlot(item, slotName) and not slot.inactive
			and (not slot.weaponSet or slot.weaponSet == weaponSet)
			and (slot.weaponSet or not slot.shown or slot.shown()) then
			local current = itemsTab.items[slot.selItemId]
			local after = pickStats(calcFunc({ repSlotName = slotName, repItem = item }, req.fullDps))
			local delta = {}
			for k, v in pairs(after) do
				if before[k] and v ~= before[k] then
					delta[k] = round(v - before[k], 1)
				end
			end
			results[#results + 1] = {
				slot = slotName,
				replaces = current and current.name or JSON_NULL,
				after = after,
				delta = delta,
			}
		end
	end
	return { item = describeItem(item), slots = results, before = before }
end

-- "What if": adds mod lines as PoB custom modifiers (like PoB's Config tab), recalculates, removes them
-- again. The build itself stays as it was. Lines PoB does not understand are returned, not applied.
function handlers.whatIf(req)
	local configTab = build.configTab
	local set = configTab.configSets[configTab.activeConfigSetId]
	set.customModsList = set.customModsList or {}
	local lines, unknown = {}, {}
	for _, line in ipairs(req.mods or {}) do
		local stripped = tostring(line):match("^%s*(.-)%s*$")
		if stripped ~= "" then
			local mods, extra = modLib.parseMod(stripped)
			if mods and #mods > 0 and not extra then
				lines[#lines + 1] = stripped
			else
				unknown[#unknown + 1] = stripped
			end
		end
	end
	local before = pickStats(build.calcsTab.mainOutput)
	local after = before
	if #lines > 0 then
		local block = { title = "Build Companion what-if", enabled = true, text = table.concat(lines, "\n") }
		table.insert(set.customModsList, block)
		local ok, err = pcall(function()
			configTab:BuildModList()
			build.buildFlag = true
			runCallback("OnFrame")
			after = pickStats(build.calcsTab.mainOutput)
		end)
		for i = #set.customModsList, 1, -1 do
			if set.customModsList[i] == block then
				table.remove(set.customModsList, i)
			end
		end
		configTab:BuildModList()
		build.buildFlag = true
		runCallback("OnFrame")
		if not ok then
			error(err, 0)
		end
	end
	return { applied = lines, unknown = unknown, before = before, after = after }
end

-- Upgrade search, step 2: puts each candidate (PoB item text built from a trade listing) into ONE slot
-- and recalculates. The build itself is never modified. A candidate that fails to parse or does not fit
-- the slot gets an error instead of numbers.
function handlers.evaluate(req)
	local itemsTab = build.itemsTab
	local slot = itemsTab.slots[req.slot]
	if not slot then
		error("unknown slot " .. tostring(req.slot), 0)
	end
	local calcFunc, base = build.calcsTab:GetMiscCalculator()
	local current = itemsTab.items[slot.selItemId]
	local results = {}
	for _, entry in ipairs(req.items or {}) do
		local ok, res = pcall(function()
			local item = parseItem(entry.itemText)
			if not itemsTab:IsItemValidForSlot(item, req.slot) then
				error("does not fit " .. req.slot, 0)
			end
			return { key = entry.key, item = describeItem(item), after = pickStats(calcFunc({ repSlotName = req.slot, repItem = item }, req.fullDps)) }
		end)
		results[#results + 1] = ok and res or { key = entry.key, error = tostring(res) }
	end
	return { slot = req.slot, replaces = current and current.name or JSON_NULL, before = pickStats(base), results = results }
end

-- Upgrade search, step 1: PoB's own weighted trade query for one slot (TradeQueryGenerator), run
-- headless. PoB tests every mod that can roll on the slot's item category against the build and turns
-- the gain in DPS / effective HP into weights; the price limit becomes a trade price filter.
-- Only the query is built here – PoB's own trade requests (and its OAuth token) are never used.
function handlers.upgradeQuery(req)
	local slot = build.itemsTab.slots[req.slot]
	if not slot then
		error("unknown slot " .. tostring(req.slot), 0)
	end
	local gen = new("TradeQueryGenerator"):TradeQueryGenerator({ itemsTab = build.itemsTab })
	-- 1 = instant buyout only ("securable"), 2 = instant buyout and in person ("available")
	gen.tradeTypeIndex = req.instantOnly == false and 2 or 1
	local result
	gen.requesterCallback = function(_, query, err)
		result = { query = query, error = err }
	end
	gen.requesterContext = {}
	gen:StartQuery(slot, {
		statWeights = {
			-- The main skill's DPS, as the item check and the ranking use it (PoB's "FullDPS" only counts
			-- skills ticked "Include in Full DPS", which many builds have none of).
			{ stat = "CombinedDPS", weightMult = req.dpsWeight or 1.0 },
			{ stat = "TotalEHP", weightMult = req.ehpWeight or 0.5 },
		},
		maxPrice = req.maxPrice,
		maxPriceType = req.maxPriceType,
		includeCorrupted = req.includeCorrupted == true,
		includeRunes = false,
		includeMirrored = false,
	})
	if not gen.calcContext.co then
		error("this slot is not supported by the upgrade search", 0)
	end
	-- PoB normally advances the calculation once per frame; headless we simply run it to the end.
	while gen.calcContext.co do
		gen:OnFrame()
	end
	if not result then
		error("the upgrade search produced no query", 0)
	end
	if result.error then
		error(result.error, 0)
	end
	-- PoB sorted modWeights by their effect (meanStatDiff), most valuable first. weight = effect per point,
	-- so effect / weight = the roll PoB tested (midpoint of the mod's range on this item category).
	-- Trade stat id → its text ("#% to Cold Resistance"), to group mods that are alternatives.
	local texts = {}
	for _, list in pairs(gen.modData or {}) do
		for _, entry in pairs(list) do
			if entry.tradeMod and entry.tradeMod.id then
				texts[entry.tradeMod.id] = entry.tradeMod.text
			end
		end
	end
	local mods = {}
	for i, m in ipairs(gen.modWeights) do
		if i > 30 then
			break
		end
		mods[i] = {
			id = m.tradeModId,
			text = texts[m.tradeModId] or JSON_NULL,
			weight = m.weight,
			effect = m.meanStatDiff,
			testedValue = m.weight ~= 0 and round(m.meanStatDiff / m.weight, 2) or JSON_NULL,
		}
	end
	-- Defences of the worn base: local "% increased Evasion" etc. only work on a base that has them.
	local existing = build.itemsTab.items[slot.selItemId]
	local armour = existing and existing.base and existing.base.armour
	return {
		query = { query = result.query, sort = { ["statgroup.0"] = "desc" } },
		mods = mods,
		base = existing and existing.baseName or JSON_NULL,
		defences = armour and {
			armour = armour.Armour ~= nil,
			evasion = armour.Evasion ~= nil,
			energyShield = armour.EnergyShield ~= nil,
		} or JSON_NULL,
	}
end

function __bridge(requestJson)
	local req = dkjson.decode(requestJson)
	local handler = req and handlers[req.cmd]
	if not handler then
		return dkjson.encode({ error = "unknown command " .. tostring(req and req.cmd) })
	end
	local ok, res = pcall(handler, req)
	if not ok then
		return dkjson.encode({ error = tostring(res) })
	end
	return dkjson.encode(res)
end
