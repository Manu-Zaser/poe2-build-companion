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
		local v = round(output[k], 1)
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

-- Equipped items in PoB's slot order. Only visible, active slots of the active weapon set.
local function equipped()
	local itemsTab = build.itemsTab
	local weaponSet = build.calcsTab.mainEnv and build.calcsTab.mainEnv.weaponSet or 1
	local gear, jewels = {}, {}
	for _, slot in ipairs(itemsTab.orderedSlots) do
		local name = slot.slotName
		local item = itemsTab.items[slot.selItemId]
		if isJewelSlot(name) then
			if item then
				jewels[#jewels + 1] = { slot = name, item = describeItem(item) }
			end
		elseif (not slot.weaponSet or slot.weaponSet == weaponSet) and (slot.weaponSet or not slot.shown or slot.shown())
			and (item or CORE_SLOTS[name:gsub(" Swap$", "")]) then
			gear[#gear + 1] = { slot = name, item = item and describeItem(item) or JSON_NULL }
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
			if dps > 0 and active.activeEffect and active.activeEffect.grantedEffect then
				res[#res + 1] = {
					name = active.activeEffect.grantedEffect.name,
					part = active.skillPartName,
					dps = round(dps, 1),
					main = i == build.mainSocketGroup or nil,
				}
			end
		end
	end
	table.sort(res, function(a, b) return a.dps > b.dps end)
	return res
end

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
		weaponSet = build.calcsTab.mainEnv and build.calcsTab.mainEnv.weaponSet or 1,
		stats = pickStats(build.calcsTab.mainOutput),
		skills = skillDps(),
		gear = gear,
		jewels = jewels,
	}
end

local handlers = {}

function handlers.load(req)
	loadBuildFromXML(req.xml, req.name or "")
	if not build.calcsTab.mainOutput then
		error("The build could not be calculated")
	end
	return overview()
end

function handlers.overview()
	return overview()
end

-- Compares an item (game copy text) against what is equipped, in every slot it fits.
function handlers.compare(req)
	local item = new("Item"):Item(req.itemText)
	if not item.base then
		return { error = "Path of Building does not know this item base" }
	end
	item:NormaliseQuality()
	item:BuildModList()

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
