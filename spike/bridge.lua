-- Bridge between the Node host and Path of Building PoE2 (headless).
-- Runs inside PoB's own LuaJIT (runtime/lua51.dll) with the working directory set to PoB's src/.
-- The host calls the global function __bridge(requestJson) and gets a JSON string back.

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

local function round(v, digits)
	if type(v) ~= "number" then
		return v
	end
	local m = 10 ^ (digits or 1)
	return math.floor(v * m + 0.5) / m
end

-- The values the companion cares about. Names are PoB output keys.
local STATS = {
	"Life", "EnergyShield", "Mana", "Spirit", "Evasion", "Armour",
	"FireResist", "ColdResist", "LightningResist", "ChaosResist",
	"FireResistOverCap", "ColdResistOverCap", "LightningResistOverCap", "ChaosResistOverCap",
	"TotalEHP", "PhysicalMaximumHitTaken", "FireMaximumHitTaken", "ColdMaximumHitTaken",
	"LightningMaximumHitTaken", "ChaosMaximumHitTaken",
	"FullDPS", "CombinedDPS", "TotalDPS",
	"Str", "Dex", "Int", "ReqStr", "ReqDex", "ReqInt", "SpiritUnreserved",
}

local function pickStats(output)
	local res = {}
	for _, k in ipairs(STATS) do
		if output[k] ~= nil then
			res[k] = round(output[k], 1)
		end
	end
	return res
end

local function mainSkillName()
	local env = build.calcsTab.mainEnv
	local skill = env and env.player and env.player.mainSkill
	if skill and skill.activeEffect and skill.activeEffect.grantedEffect then
		return skill.activeEffect.grantedEffect.name
	end
end

local function equipped()
	local res = {}
	for slotName, slot in pairs(build.itemsTab.slots) do
		local item = build.itemsTab.items[slot.selItemId]
		if item and not slotName:find("Socket") then
			res[slotName] = { name = item.name, base = item.baseName, rarity = item.rarity, raw = item:BuildRaw() }
		end
	end
	return res
end

local handlers = {}

function handlers.load(req)
	loadBuildFromXML(req.xml, req.name)
	return {
		className = build.spec and build.spec.curClassName,
		ascendancy = build.spec and build.spec.curAscendClassName,
		level = build.characterLevel,
		mainSkill = mainSkillName(),
		weaponSet = build.calcsTab.mainEnv and build.calcsTab.mainEnv.weaponSet,
		useSecondWeaponSet = build.itemsTab.activeItemSet.useSecondWeaponSet or false,
		stats = pickStats(build.calcsTab.mainOutput),
		equipped = equipped(),
	}
end

-- Compares an item (game copy text) against what is equipped, in every slot it fits.
function handlers.compare(req)
	local item = new("Item"):Item(req.itemText)
	if not item.base then
		return { error = "PoB did not recognise the item base" }
	end
	item:NormaliseQuality()
	item:BuildModList()

	local itemsTab = build.itemsTab
	local calcFunc, base = build.calcsTab:GetMiscCalculator()
	local weaponSet = build.calcsTab.mainEnv and build.calcsTab.mainEnv.weaponSet or 1
	local results = {}
	for slotName, slot in pairs(itemsTab.slots) do
		if itemsTab:IsItemValidForSlot(item, slotName) and not slot.inactive
			and (not slot.weaponSet or slot.weaponSet == weaponSet)
			and (slot.weaponSet or not slot.shown or slot.shown()) then -- e.g. hidden "Ring 3"
			local current = itemsTab.items[slot.selItemId]
			local output = calcFunc({ repSlotName = slotName, repItem = item }, req.fullDps)
			local before, after = pickStats(base), pickStats(output)
			local delta = {}
			for k, v in pairs(after) do
				if type(v) == "number" and type(before[k]) == "number" and v ~= before[k] then
					delta[k] = round(v - before[k], 1)
				end
			end
			results[#results + 1] = {
				slot = slotName,
				replaces = current and current.name or nil,
				after = after,
				delta = delta,
			}
		end
	end
	return { item = item.name, base = item.baseName, slots = results, before = pickStats(base) }
end

function __bridge(requestJson)
	local req = dkjson.decode(requestJson)
	local handler = handlers[req.cmd]
	if not handler then
		return dkjson.encode({ error = "unknown command " .. tostring(req.cmd) })
	end
	local ok, res = pcall(handler, req)
	if not ok then
		return dkjson.encode({ error = tostring(res) })
	end
	return dkjson.encode(res)
end
