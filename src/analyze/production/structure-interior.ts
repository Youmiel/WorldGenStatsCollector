import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ChunkRef } from "minecraft-block-reader"
import type { Analyzer, AnalyzerContext, AnalyzerModule, ChunkHandle } from "../types.js"
import { dimensionDirs } from "../../lib/server.js"
import { readRegionChunkNbt } from "../chunk-nbt.js"
import { readJarJsonEntry } from "../../lib/jar.js"
import { loadStructureSets, type StructureSetIndex } from "../../lib/structure-sets.js"
import { clusterPoints, centroid, summariseNN, type Point } from "../nn.js"
import { archaeologyOwner, landmarkOwnerOf, landmarkSetId, LANDMARK_CLUSTER_RADIUS } from "./landmarks.js"

/**
 * 结构内部：把一个结构起点展开成它的全部片段（`structures.starts[id].Children`），
 * 统计片段构成、真实占地（BB 并集）、占地内的方块/容器/战利品表/生物。
 *
 * 数据来源：
 * - `structures.starts` 只在起点区块存在，含该实例的全部 `Children`（每项带体素包围盒 `BB`）
 * - `structures.References` 在**所有被片段覆盖的区块**存在，值是 (结构 id → 起点 ChunkPos)，
 *   所以任意区块都能反查出自己参与的结构实例；起点在别的 region 时按目录直接读那个 region。
 * - 方块从 `chunkGrid` 取（与其它分析器共享 memo），容器/刷怪笼从 `block_entities` 取，
 *   生物从实体文件取（`ChunkHandle.entities`）。
 *
 * 口径：
 * - 片段频率按结构 id 分组（一个起点 = 一个实例），`perStart` 是「每个实例平均有几个这种片段」
 * - 方块/体素按 BB 去重：同一实例的重叠片段只计一次；不同结构各自统计（重叠处各自计入）
 * - BB 端点按 Minecraft `BoundingBox` 语义视为闭区间（实测末地城 111/115 只潜影贝落在闭区间内）
 * - 容器只认已知容器 id；战利品表独立统计（含 `vault` 的 `config.loot_table`）
 * - 刷怪笼按「刷的怪物」分：`mob_spawner` 取 `SpawnData.entity.id`，
 *   `trial_spawner` 取 config 路径的倒数第二段（`melee/zombie/normal` → `zombie`）
 *
 * params:
 *   topBlocks?: number  每个结构保留的方块种类上限（按数量降序，默认 200）
 */

type BB = [number, number, number, number, number, number]

interface ParsedPiece { id: string, bb: BB, tpl: string | null }
interface ParsedStart { structure: string, sx: number, sz: number, pieces: ParsedPiece[] }

/** 未能归入任何片段 BB 的方块实体，留到 finalize 做就近补归属 */
interface PendingBe {
  id: string | null
  loot: string | null
  spawner: string | null
  /** 刷怪笼的生成参数（原版 mob_spawner 的 NBT）；trial_spawner 没有这些数字 */
  caps: SpawnerCaps | null
  x: number
  y: number
  z: number
}

/** 刷怪笼的「上限」类参数：MaxNearbyEntities / SpawnCount / SpawnRange */
interface SpawnerCaps {
  maxNearbyEntities: number | null
  spawnCount: number | null
  spawnRange: number | null
}

/** 某个刷怪笼键（方块|怪物）的实测取值范围 */
interface CapsAgg {
  samples: number
  maxNearbyEntities: { min: number, max: number } | null
  spawnCount: { min: number, max: number } | null
  spawnRange: { min: number, max: number } | null
}

/** 地牢（monster room）：不是 jigsaw 结构，以结构外的刷怪笼为锚点聚合 */
interface Dungeon {
  x: number
  y: number
  z: number
  kind: string
  containers: Map<string, number>
  lootTables: Map<string, number>
}

/**
 * 地形特征（placed feature）里的地标：不是结构，没有 start 与 BB，
 * 只能靠可疑方块实体上的考古战利品表识别。
 * 典型例子是沙漠水井（`desert_well`），它靠 `rarity_filter` + 高度图放置。
 */
interface Landmark {
  id: string
  /** 该地标的可疑方块数 */
  blocks: number
  blockTypes: Map<string, number>
  lootTables: Map<string, number>
  /** 实为容器、但挂着该地标考古表的方块（沙漠水井为 0） */
  containers: Map<string, number>
  /** 可疑方块坐标，用于把方块聚成实例 */
  points: Point[]
}

interface Stat {
  structure: string
  set: string | null
  starts: number
  pieces: number
  pieceKinds: Map<string, number>
  /** 含该 piece 的实例数（同一实例里重复出现只计一次），用于「每处几个」 */
  pieceStarts: Map<string, number>
  /** 模板路径 → 次数；只有 jigsaw/Template 类部件有，硬编码部件（矿井、要塞）没有 */
  templates: Map<string, number>
  /** 含该模板的实例数（同一实例里重复出现只计一次） */
  templateStarts: Map<string, number>
  piecesWithoutTemplate: number
  coveredChunks: number
  cells: number
  blockTotal: number
  blocks: Map<string, number>
  containers: Map<string, number>
  lootTables: Map<string, number>
  /** 键是 `方块 id\u0000怪物类别`，一块刷怪笼同时按方块类型与怪物类别分开 */
  spawners: Map<string, number>
  /** 刷怪笼的 SpawnCount / MaxNearbyEntities / SpawnRange 实测取值范围 */
  spawnerCaps: Map<string, CapsAgg>
  entities: Map<string, number>
  /** 片段 BB 伸出扫描边界的实例数：这些实例的容器只统计到一部分 */
  truncatedStarts: number
}

interface RawPiece { id?: unknown, BB?: unknown, Template?: unknown, pool_element?: { location?: unknown } }

const KEY = "structure-interior"
const COLUMNS = 256

/** 容器：有物品栏、能被翻找的方块实体；vault 也算（它是试炼密室的奖励容器） */
const CONTAINERS = new Set([
  "minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel",
  "minecraft:dispenser", "minecraft:dropper", "minecraft:hopper",
  "minecraft:furnace", "minecraft:blast_furnace", "minecraft:smoker",
  "minecraft:brewing_stand", "minecraft:shulker_box", "minecraft:decorated_pot",
  "minecraft:crafter", "minecraft:ender_chest", "minecraft:vault",
  "minecraft:chiseled_bookshelf",
])

const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback)
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const shortId = (id: string): string => id.replace(/^minecraft:/, "")
const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n)

/** 点到包围盒的欧氏距离（盒内为 0） */
function boxDist(bb: BB, x: number, y: number, z: number): number {
  const dx = x < bb[0] ? bb[0] - x : x > bb[3] ? x - bb[3] : 0
  const dy = y < bb[1] ? bb[1] - y : y > bb[4] ? y - bb[4] : 0
  const dz = z < bb[2] ? bb[2] - z : z > bb[5] ? z - bb[5] : 0
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * 两类就近归属的距离上限。
 *
 * 实测漏在 BB 外的方块实体都在 1~7 格内：海洋废墟的可疑方块与箱子因为在海床上
 * 被下移/贴底放置，落到了模板包围盒下方；刷怪笼不会被结构「放歪」，所以给更紧的上限。
 */
const NEAR_STRUCTURE = 12
const NEAR_SPAWNER = 4
const DUNGEON_RADIUS = 8
/** 按战利品表找归属结构时的搜索半径：箱子必然落在结构占地内或紧邻 */
const NEAR_LOOT = 16

/**
 * 结构生成时由**代码**放出来的实体（不是刷怪笼、也不会出现在实体存档里）。
 *
 * 这类实体和模板/数据包无关，是原版 `postProcess` 里直接 `addFreshEntity` 放的：
 * 数据包 JSON 没有对应字段，而预生成时这些实体也不落盘（实测扫遍全部 277 个
 * 实体文件、27,096 个实体，海底神殿周围一只守卫者都没有），所以**扫不到**。
 * 只能按结构定义里的固定数量给出——这是版本事实，不是测量值。
 *
 * 来源（26.3 `net/minecraft/world/level/levelgen/structure/structures/OceanMonumentPieces.java`）：
 * - `OceanMonumentCoreRoom.postProcess`：`spawnElder(level, chunkBB, 6, 1, 6)`  → 1
 * - `OceanMonumentWingRoom.postProcess`（mainDesign 0）：`spawnElder(..., 11, 2, 16)` → 1
 * - `OceanMonumentWingRoom.postProcess`（mainDesign 1）：`spawnElder(..., 11, 5, 13)` → 1
 *   每座神殿左右翼房各一只，合计 **3 只**。
 *
 * 输出写在 `structures[].spawnedPerStart` / `.spawnedTotal`，与实测的 `entities`
 * 分开：`entities` 是扫出来的，这里是从结构定义推出来的，两者的可信度不同，不能混。
 *
 * **本表的准入条件：数量必须是结构级常量，与模板/数据包无关。**
 * 只满足「代码生成、扫不到」还不够——数量若随拼装变化就不能写死，见下面的反例。
 *
 * 反例：海洋废墟的溺尸（`OceanRuinPieces.handleDataMarker`，marker id 为 `drowned`）。
 * 它也是代码生成、也扫不到，但数量由**模板里的 data marker 个数**决定：
 * 26.3 的 48 个 `underwater_ruin/*` 模板各含 1~5 个 `structure_block[mode=data]`，
 * 且同一模板里还混着 `chest` marker。RA 的 `template_blocks.jsonl` 只导出
 * `count` 与 `state`，**没有 marker id**，因此分不出哪几个是溺尸、哪几个是箱子。
 * 写死一个数会引入不可量化的误差（可能 0 也可能 5），违背「不猜」的口径，
 * 所以**不收进本表**。要精确统计需要先拿到 marker id：
 * 或让 RA 在 `template_blocks.jsonl` 里补 `marker` 字段，或在采集侧解析
 * jar 内模板 NBT 的方块实体 `metadata`。
 *
 * 随版本新增同类结构时在这里补一行，并写清源码出处与「数量为何是常量」。
 */
const STRUCTURE_SPAWNED: Record<string, Record<string, number>> = {
  "minecraft:monument": { "minecraft:elder_guardian": 3 },
}

/**
 * 战利品表 → 归属结构（结构 id 前缀）。
 *
 * 箱子挂哪张表由结构的模板/processor 决定，是**数据事实**，比「离哪个结构近」可靠：
 * 海底神殿没有战利品箱，但海洋废墟的箱子可能落在神殿的包围盒内，按距离就会算给神殿。
 *
 * 键是去掉 `minecraft:` 的表路径。值是结构 id 前缀（多个变体共表时写共同前缀，
 * 如 `ocean_ruin` 覆盖 cold/warm，落点由实际生成的实例决定）。
 *
 * 未收录的表不猜归属，直接进 `unmappedLootTables`——随数据包新增表时去那里补。
 * 考古表例外：`archaeology/*` 对不上任何结构时就是地形特征地标（沙漠水井）。
 *
 * `chests/simple_dungeon` 同时被矿井与地牢使用，这里只写矿井；地牢由刷怪笼锚点单独处理，
 * 且优先于本表。
 */
const LOOT_OWNERS: Record<string, readonly string[]> = {
  "archaeology/desert_pyramid": ["desert_pyramid"],
  "archaeology/ocean_ruin_cold": ["ocean_ruin_cold"],
  "archaeology/ocean_ruin_warm": ["ocean_ruin_warm"],
  "archaeology/trail_ruins_common": ["trail_ruins"],
  "archaeology/trail_ruins_rare": ["trail_ruins"],
  "barrels/abandoned_camp_barrel": ["abandoned_camp"],
  "chests/abandoned_camp_common_chest": ["abandoned_camp"],
  "chests/abandoned_camp_secret_chest": ["abandoned_camp"],
  "chests/ancient_city": ["ancient_city"],
  "chests/ancient_city_ice_box": ["ancient_city"],
  "chests/bastion_bridge": ["bastion_remnant"],
  "chests/bastion_hoglin_stable": ["bastion_remnant"],
  "chests/bastion_other": ["bastion_remnant"],
  "chests/bastion_treasure": ["bastion_remnant"],
  "chests/buried_treasure": ["buried_treasure"],
  "chests/desert_pyramid": ["desert_pyramid"],
  "chests/end_city_treasure": ["end_city"],
  "chests/igloo_chest": ["igloo"],
  "chests/jungle_temple": ["jungle_pyramid"],
  "chests/jungle_temple_dispenser": ["jungle_pyramid"],
  "chests/nether_bridge": ["fortress"],
  "chests/pillager_outpost": ["pillager_outpost"],
  "chests/ruined_portal": ["ruined_portal"],
  "chests/shipwreck_map": ["shipwreck"],
  "chests/shipwreck_supply": ["shipwreck"],
  "chests/shipwreck_treasure": ["shipwreck"],
  "chests/simple_dungeon": ["mineshaft"],
  "chests/stronghold_corridor": ["stronghold"],
  "chests/stronghold_crossing": ["stronghold"],
  "chests/stronghold_library": ["stronghold"],
  "chests/trial_chambers/corridor": ["trial_chambers"],
  "chests/trial_chambers/entrance": ["trial_chambers"],
  "chests/trial_chambers/intersection": ["trial_chambers"],
  "chests/trial_chambers/intersection_barrel": ["trial_chambers"],
  "chests/trial_chambers/reward": ["trial_chambers"],
  "chests/trial_chambers/reward_ominous": ["trial_chambers"],
  "chests/trial_chambers/supply": ["trial_chambers"],
  "chests/underwater_ruin_big": ["ocean_ruin"],
  "chests/underwater_ruin_small": ["ocean_ruin"],
  "chests/village/village_armorer": ["village"],
  "chests/village/village_cartographer": ["village"],
  "chests/village/village_desert_house": ["village_desert"],
  "chests/village/village_fisher": ["village"],
  "chests/village/village_fletcher": ["village"],
  "chests/village/village_mason": ["village"],
  "chests/village/village_plains_house": ["village_plains"],
  "chests/village/village_savanna_house": ["village_savanna"],
  "chests/village/village_snowy_house": ["village_snowy"],
  "chests/village/village_taiga_house": ["village_taiga"],
  "chests/village/village_tannery": ["village"],
  "chests/village/village_temple": ["village"],
  "chests/village/village_toolsmith": ["village"],
  "chests/village/village_weaponsmith": ["village"],
  "chests/woodland_mansion": ["mansion"],
  "dispensers/trial_chambers/chamber": ["trial_chambers"],
  "dispensers/trial_chambers/corridor": ["trial_chambers"],
  "pots/trial_chambers/corridor": ["trial_chambers"],
}

/** 战利品表 → 结构 id 前缀；未收录返回 null */
function lootOwnersOf(loot: string): readonly string[] | null {
  return LOOT_OWNERS[loot.replace(/^minecraft:/, "")] ?? null
}

/**
 * 一张表被多种结构共用、无法据此判定归属的表。
 *
 * `chests/simple_dungeon` 同时是矿井的主表和地牢的箱子：地牢靠刷怪笼锚点先判，
 * 剩下对不上的退回就近归属，不能一律算成矿井。
 */
const AMBIGUOUS_LOOT = new Set(["chests/simple_dungeon"])

/** 结构 id 是否命中任一前缀（`minecraft:ocean_ruin_cold` 命中 `ocean_ruin`） */
function structureMatches(owners: readonly string[], structure: string): boolean {
  const id = structure.replace(/^minecraft:/, "")
  return owners.some(o => id === o || id.startsWith(`${o}_`))
}

/** 刷怪笼的 SpawnCount / MaxNearbyEntities / SpawnRange；缺字段写 null，不猜默认值 */
function spawnerCapsOf(be: Record<string, unknown>): SpawnerCaps | null {
  if (str(be.id) !== "minecraft:mob_spawner") return null
  const short = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null
  return {
    maxNearbyEntities: short(be.MaxNearbyEntities),
    spawnCount: short(be.SpawnCount),
    spawnRange: short(be.SpawnRange),
  }
}

/** 把一次刷怪笼观测并入统计（次数 + 上限参数的范围） */
function recordSpawner(stat: Stat, key: string, caps: SpawnerCaps | null): void {
  bump(stat.spawners, key)
  if (!caps) return
  let agg = stat.spawnerCaps.get(key)
  if (!agg) {
    agg = { samples: 0, maxNearbyEntities: null, spawnCount: null, spawnRange: null }
    stat.spawnerCaps.set(key, agg)
  }
  agg.samples++
  const span = (cur: { min: number, max: number } | null, v: number | null) =>
    v === null ? cur : cur ? { min: Math.min(cur.min, v), max: Math.max(cur.max, v) } : { min: v, max: v }
  agg.maxNearbyEntities = span(agg.maxNearbyEntities, caps.maxNearbyEntities)
  agg.spawnCount = span(agg.spawnCount, caps.spawnCount)
  agg.spawnRange = span(agg.spawnRange, caps.spawnRange)
}

/**
 * 地标每个实例含几个可疑方块：读 jar 里该 feature 的定义，数「模板是 suspicious_*」的子特征数。
 *
 * 每个这样的子特征通过 `randomly_selected` 选一处位置放一块 1x1x1 模板，所以条目数就是每实例方块数。
 * 读不到（没有 jar、数据包改了结构）时返回 null，不猜。
 */
async function suspiciousPerInstance(jarPath: string | null, id: string): Promise<number | null> {
  if (!jarPath) return null
  const json = await readJarJsonEntry(`data/minecraft/worldgen/feature/${id}.json`, jarPath) as
    { features?: { feature?: { templates?: { data?: { id?: unknown } }[] } }[] } | null
  const features = json?.features
  if (!Array.isArray(features)) return null
  let n = 0
  for (const f of features) {
    const tpls = f?.feature?.templates
    if (!Array.isArray(tpls)) continue
    if (tpls.some(t => String(t?.data?.id ?? "").includes("suspicious"))) n++
  }
  return n > 0 ? n : null
}

function parseBB(v: unknown): BB | null {
  if (!v || typeof v !== "object") return null
  const a = v as ArrayLike<unknown>
  if (typeof a.length !== "number" || a.length < 6) return null
  const out: number[] = []
  for (let i = 0; i < 6; i++) {
    const n = Number(a[i])
    if (!Number.isFinite(n)) return null
    out.push(n)
  }
  return out as BB
}

function pieceIdOf(p: RawPiece): string {
  return str(p.id) ?? str(p.Template) ?? str(p.pool_element?.location) ?? "unknown"
}

/**
 * 片段的模板路径。两种存法（实测互不重叠，没有单独的 `TPL` 字段）：
 * - 拼图结构（试炼密室、村庄、遗迹小径、废弃营地）：`pool_element.location`
 * - 模板结构（冰屋、沉船、海底废墟、废弃传送门）：`Template`
 *
 * 硬编码部件结构（矿井、要塞、下界複合体、堡垒遗迹）两者都没有，返回 null。
 */
function pieceTemplateOf(p: RawPiece): string | null {
  return str(p.pool_element?.location) ?? str(p.Template)
}

/**
 * 实例的全部片段 BB 是否都落在本维度已扫描的区块内。
 *
 * 跨边界的实例（起点在范围内、片段伸到范围外，或反过来）只能统计到一部分容器，
 * 仍计入 `starts`（它确实存在），但单独用 `truncatedStarts` 报出来，
 * 让下游知道 `containersPerStart` 对这类结构会偏低。
 * 覆盖超过 1024 个区块的异常 BB（`registerBB` 也会跳过）不做判定，按跨界处理。
 */
function coversAllChunks(s: ParsedStart, scanned: Set<string>): boolean {
  for (const piece of s.pieces) {
    const bb = piece.bb
    const cx0 = bb[0] >> 4, cx1 = bb[3] >> 4
    const cz0 = bb[2] >> 4, cz1 = bb[5] >> 4
    if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 1024) return false
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        if (!scanned.has(`${cx},${cz}`)) return false
      }
    }
  }
  return true
}

function parseStart(structure: string, raw: Record<string, unknown>, fallbackX: number, fallbackZ: number): ParsedStart {
  const pieces: ParsedPiece[] = []
  const children = raw.Children
  if (Array.isArray(children)) {
    for (const p of children) {
      if (!p || typeof p !== "object") continue
      const bb = parseBB((p as RawPiece).BB)
      if (!bb) continue
      pieces.push({ id: pieceIdOf(p as RawPiece), bb, tpl: pieceTemplateOf(p as RawPiece) })
    }
  }
  return { structure, sx: num(raw.ChunkX, fallbackX), sz: num(raw.ChunkZ, fallbackZ), pieces }
}

/**
 * `References[id]` 是一个 **ChunkPos 列表**：`[x0, z0, x1, z1, ...]`（每对是低 32 位 x、高 32 位 z）。
 *
 * 一个区块可能同时被**多个同类型结构实例**覆盖（试炼密室半径很大），这时长度是 4.
 * 只取前两个会漏掉后面的实例，把它们的方块实体误判成「不在结构内」。
 * 同时兼容 bigint / number（打包成一个 long）的写法。
 */
function chunkPosList(raw: unknown): [number, number][] {
  const one = (lo: number, hi: number): [number, number] => [lo | 0, hi | 0]
  if (typeof raw === "bigint") return [one(Number(raw & 0xffffffffn), Number((raw >> 32n) & 0xffffffffn))]
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return []
    return [one(raw >>> 0, Math.floor(raw / 4294967296) >>> 0)]
  }
  if (raw && typeof raw === "object" && typeof (raw as ArrayLike<unknown>).length === "number") {
    const a = raw as ArrayLike<unknown>
    const out: [number, number][] = []
    for (let i = 0; i + 1 < a.length; i += 2) {
      out.push(one(Number(a[i]) >>> 0, Number(a[i + 1]) >>> 0))
    }
    return out
  }
  return []
}

/** 刷怪笼刷什么：返回 `方块 id\u0000怪物类别`（均为去命名空间的短 id） */
function spawnerKey(be: Record<string, unknown>): string | null {
  const id = str(be.id)
  if (!id) return null
  if (id === "minecraft:mob_spawner") {
    const data = be.SpawnData as { entity?: { id?: unknown } } | undefined
    return `${shortId(id)}\u0000${shortId(str(data?.entity?.id) ?? "unknown")}`
  }
  if (id === "minecraft:trial_spawner") {
    const cfg = str(be.normal_config) ?? str(be.ominous_config)
    // minecraft:trial_chamber/small_melee/baby_zombie/normal → baby_zombie
    const seg = cfg ? cfg.split("/") : []
    const kind = seg.length >= 2 ? seg[seg.length - 2] : "unknown"
    return `${shortId(id)}\u0000${kind}`
  }
  return null
}

function lootTableOf(be: Record<string, unknown>): string | null {
  const direct = str(be.LootTable)
  if (direct) return direct
  const cfg = be.config as { loot_table?: unknown } | undefined
  return str(cfg?.loot_table)
}

const analyzer: AnalyzerModule = {
  name: KEY,
  description: "按结构起点展开片段：片段频率、真实占地、占地内方块/容器/战利品表/刷怪笼/生物分布",
  units: {
    perStart: "per_start",
    share: "percent",
    volume: "block",
    covered: "chunk",
    containersPerDungeon: "per_dungeon",
    containerTotal: "count",
    containersPerStart: "per_start",
    containersPerCoveredChunk: "per_chunk",
    landmarkBlocks: "count",
    landmarkInstances: "count",
    landmarkDensity: "per_chunk",
  },
  splitByDimension: true,
  parallelCost: 4.9,
  // 与 structure-spacing 读同一批原始 NBT（structures + block_entities）：
  // 同组才能共享 ChunkHandle 的 memo，否则各解一遍全量区块
  parallelGroup: "structure-raw-nbt",
  create(params): Analyzer {
    const p = (params[KEY] ?? {}) as { topBlocks?: unknown }
    const topBlocks = Math.max(1, num(p.topBlocks, 200))

    const stats = new Map<string, Stat>()
    /** 未能归入任何 BB 的方块实体，finalize 时按距离补归属或聚成地牢 */
    const pending: PendingBe[] = []
    /**
     * BB 的区块空间索引：键 = `cx,cz`，值是跨越该区块的全部片段包围盒。
     * 一个结构实例只注册一次（与片段频率共用 countedStarts）。
     */
    const bbIndex = new Map<string, { stat: Stat, bb: BB }[]>()
    /**
     * 已计过片段频率（且已注册 BB）的实例：key = `结构@x,z`，值是实例本身。
     * References 会让同一实例在多个区块被看到，靠 key 去重；finalize 还要用实例的
     * 片段 BB 判断它是否完整落在扫描范围内。
     */
    const countedStarts = new Map<string, ParsedStart>()
    /** 本维度真正分析过的区块（extent 非空），用于判断结构实例是否跨出扫描边界 */
    const scanned = new Set<string>()
    let chunks = 0
    /** 有地形的区块数（extent 非空）：piece 级密度的分母，与 structure-spacing 的 chunks 同口径 */
    let terrainChunks = 0
    let dimension = "overworld"
    let worldDir = ""
    let setIndex: StructureSetIndex | null = null
    let setIndexPromise: Promise<StructureSetIndex> | null = null

    /* ---------------- 跨 region 读起点 ---------------- */

    const dirCache = new Map<string, string | null>()
    const regionBytes = new Map<string, Uint8Array | null>()
    const startCache = new Map<string, ParsedStart | null>()

    const regionDirOf = (): string | null => {
      const hit = dirCache.get(dimension)
      if (hit !== undefined) return hit
      for (const d of dimensionDirs(worldDir, dimension)) {
        if (existsSync(d)) { dirCache.set(dimension, d); return d }
      }
      dirCache.set(dimension, null)
      return null
    }

    /** region 文件字节缓存（跨 region 反查 Children 用）；LRU 4 个文件 */
    const bytesOf = async (rx: number, rz: number): Promise<Uint8Array | null> => {
      const key = `${dimension}|${rx},${rz}`
      const hit = regionBytes.get(key)
      if (hit !== undefined) return hit
      const dir = regionDirOf()
      let out: Uint8Array | null = null
      if (dir) {
        try { out = new Uint8Array(await readFile(join(dir, `r.${rx}.${rz}.mca`))) } catch { out = null }
      }
      regionBytes.set(key, out)
      if (regionBytes.size > 4) {
        const oldest = regionBytes.keys().next().value
        if (oldest !== undefined && oldest !== key) regionBytes.delete(oldest)
      }
      return out
    }

    const loadStart = async (structure: string, cx: number, cz: number): Promise<ParsedStart | null> => {
      const key = `${structure}@${cx},${cz}`
      const hit = startCache.get(key)
      if (hit !== undefined) return hit
      let out: ParsedStart | null = null
      const bytes = await bytesOf(cx >> 5, cz >> 5)
      if (bytes) {
        const nbt = await readRegionChunkNbt(bytes, { cx, cz } as ChunkRef, ["structures"])
        const st = (nbt?.structures as { starts?: Record<string, Record<string, unknown>> } | undefined)?.starts
        const raw = st?.[structure]
        if (raw) out = parseStart(structure, raw, cx, cz)
      }
      startCache.set(key, out)
      if (startCache.size > 2048) {
        let n = 1024
        for (const k of startCache.keys()) {
          startCache.delete(k)
          if (--n <= 0) break
        }
      }
      return out
    }

    /* ---------------- 全局方块编号 ---------------- */

    const blockIds = new Map<string, number>()
    const blockNames: string[] = []
    const blockCounts = new Map<string, Uint32Array>()
    const idOf = (id: string): number => {
      let i = blockIds.get(id)
      if (i === undefined) { i = blockNames.length; blockIds.set(id, i); blockNames.push(id) }
      return i
    }

    /** 结构 → 计数数组；长度不够时扩容 */
    const countsOf = (structure: string, need: number): Uint32Array => {
      let arr = blockCounts.get(structure)
      if (!arr) { arr = new Uint32Array(Math.max(64, need + 1)); blockCounts.set(structure, arr); return arr }
      if (arr.length <= need) {
        const next = new Uint32Array(Math.max(need + 1, arr.length * 2))
        next.set(arr)
        blockCounts.set(structure, next)
        return next
      }
      return arr
    }

    const statOf = (structure: string): Stat => {
      let s = stats.get(structure)
      if (!s) {
        s = {
          structure,
          set: setIndex?.byStructure.get(structure)?.id ?? null,
          starts: 0,
          pieces: 0,
          pieceKinds: new Map(),
          pieceStarts: new Map(),
          templates: new Map(),
          templateStarts: new Map(),
          piecesWithoutTemplate: 0,
          coveredChunks: 0,
          cells: 0,
          blockTotal: 0,
          blocks: new Map(),
          containers: new Map(),
          lootTables: new Map(),
          spawners: new Map(),
          spawnerCaps: new Map(),
          entities: new Map(),
          truncatedStarts: 0,
        }
        stats.set(structure, s)
      }
      return s
    }

    /** BB 覆盖标记：复用同一块内存，靠 token 区分轮次，避免每区块清零。
     * `mask[idx]` = 该格最后写入的 token，`tokenOwner` 把它映射回结构。
     * 多结构重叠时格子归最后一次写入的结构（方块计数不受影响，因为计数在写入时就完成）。
     */
    let mask = new Int32Array(0)
    let maskToken = 0
    const tokenOwner = new Map<number, Stat>()

    /** 把一个片段的 BB 注册进区块空间索引；过大或异常的盒子跳过 */
    const registerBB = (stat: Stat, bb: BB) => {
      const cx0 = bb[0] >> 4, cx1 = bb[3] >> 4
      const cz0 = bb[2] >> 4, cz1 = bb[5] >> 4
      if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 1024) return
      const entry = { stat, bb }
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const k = `${cx},${cz}`
          const a = bbIndex.get(k)
          if (a) a.push(entry)
          else bbIndex.set(k, [entry])
        }
      }
    }

    /** 找距该点最近的结构实例；超出 maxDist 返回 null */
    const nearestStructure = (x: number, y: number, z: number, maxDist: number): Stat | null => {
      const cx = x >> 4, cz = z >> 4
      const r = Math.ceil(maxDist / 16)
      let best = maxDist + 1e-9
      let found: Stat | null = null
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const a = bbIndex.get(`${cx + dx},${cz + dz}`)
          if (!a) continue
          for (let i = 0; i < a.length; i++) {
            const d = boxDist(a[i].bb, x, y, z)
            if (d < best) { best = d; found = a[i].stat }
          }
        }
      }
      return found
    }

    /**
     * 找距该点最近的**指定结构**实例；超出 maxDist 或没有命中前缀的结构则返回 null。
     *
     * 用于按战利品表归属：表说明箱子属于哪一种结构，这里只在该结构的实例里挑最近的，
     * 不会因为别的结构恰好更近（例如海洋废墟的箱子落在海底神殿的 BB 内）就算错。
     */
    const nearestStructureOf = (
      x: number, y: number, z: number, maxDist: number, owners: readonly string[],
    ): Stat | null => {
      const cx = x >> 4, cz = z >> 4
      const r = Math.ceil(maxDist / 16)
      let best = maxDist + 1e-9
      let found: Stat | null = null
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const a = bbIndex.get(`${cx + dx},${cz + dz}`)
          if (!a) continue
          for (let i = 0; i < a.length; i++) {
            if (!structureMatches(owners, a[i].stat.structure)) continue
            const d = boxDist(a[i].bb, x, y, z)
            if (d < best) { best = d; found = a[i].stat }
          }
        }
      }
      return found
    }

    /** 方块实体既不属于任何 BB、也不在 mask 里：留到 finalize 处理 */
    const holdPending = (be: Record<string, unknown>) => {
      const x = num(be.x, NaN), y = num(be.y, NaN), z = num(be.z, NaN)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
      const spawner = spawnerKey(be)
      pending.push({
        id: str(be.id), loot: lootTableOf(be), spawner,
        caps: spawner ? spawnerCapsOf(be) : null,
        x, y, z,
      })
    }

    return {
      name: KEY,

      onRegion(session) {
        dimension = session.dimension
      },

      async onChunk(c: ChunkHandle, ctx: AnalyzerContext) {
        // 先登记「这个区块在扫描范围内」再判 extent：末地大量区块是纯虚空，
        // extent 为 null 不代表没扫到，否则会被误判成跨边界
        scanned.add(`${c.x},${c.z}`)
        const ext = await c.extent()
        if (!ext) return
        terrainChunks++
        // token 全局递增，mask 里的旧 token 永远小于新 token，所以只需清映射表
        tokenOwner.clear()
        worldDir = worldDir || ctx.runtime.worldDir
        setIndexPromise ??= loadStructureSets(ctx.runtime.serverJar)
        setIndex ??= await setIndexPromise

        const nbt = await c.rawNbt(["structures"])
        const st = nbt?.structures as {
          starts?: Record<string, Record<string, unknown>>
          References?: Record<string, unknown>
        } | undefined

        const beNbt = await c.rawNbt(["block_entities"])
        const beRaw = beNbt?.block_entities
        const bes: Record<string, unknown>[] = Array.isArray(beRaw)
          ? beRaw.filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === "object")
          : []

        if (!st) {
          // 没有 structures 根键也可能有地牢刷怪笼/容器
          for (const be of bes) holdPending(be)
          return
        }

        // 本区块涉及的实例：作为起点（starts）或只含片段（References）
        const local = new Map<string, ParsedStart>()
        if (st.starts) {
          for (const [structure, raw] of Object.entries(st.starts)) {
            const s = parseStart(structure, raw, c.x, c.z)
            local.set(`${structure}@${s.sx},${s.sz}`, s)
          }
        }
        const involved: ParsedStart[] = [...local.values()]
        const seen = new Set<string>(local.keys())
        if (st.References) {
          for (const [structure, raw] of Object.entries(st.References)) {
            // 同一区块可被多个同类型实例覆盖（References 里是 ChunkPos 列表，不是单个）
            for (const pos of chunkPosList(raw)) {
              const key = `${structure}@${pos[0]},${pos[1]}`
              if (seen.has(key)) continue
              seen.add(key)
              const s = await loadStart(structure, pos[0], pos[1])
              if (s) involved.push(s)
            }
          }
        }
        if (!involved.length) {
          for (const be of bes) holdPending(be)
          return
        }
        chunks++

        /* -------- 1. 片段频率 + BB 注册（每个实例只算一次） -------- */

        for (const s of involved) {
          const key = `${s.structure}@${s.sx},${s.sz}`
          if (countedStarts.has(key)) continue
          countedStarts.set(key, s)
          const stat = statOf(s.structure)
          stat.starts++
          stat.pieces += s.pieces.length
          // 同一实例里同一 piece/模板出现多次时，`instances` 只记一次——它回答
          // 「多少比例的实例带这段」，与 piece 总数不是一回事。
          const seenPieces = new Set<string>()
          const seenTemplates = new Set<string>()
          for (const piece of s.pieces) {
            bump(stat.pieceKinds, piece.id)
            if (!seenPieces.has(piece.id)) {
              seenPieces.add(piece.id)
              bump(stat.pieceStarts, piece.id)
            }
            if (piece.tpl) {
              bump(stat.templates, piece.tpl)
              if (!seenTemplates.has(piece.tpl)) {
                seenTemplates.add(piece.tpl)
                bump(stat.templateStarts, piece.tpl)
              }
            } else stat.piecesWithoutTemplate++
            registerBB(stat, piece.bb)
          }
        }

        /* -------- 2. 占地 + 方块 + 容器 + 生物 -------- */

        const bottom = ext.bottom
        const top = ext.top
        const h = top - bottom + 1
        if (h <= 0) return
        const total = h * COLUMNS
        if (mask.length < total) mask = new Int32Array(total)

        const g = await c.grid({ yMin: ext.bottom, yMax: ext.top })
        if (!g || g.grid.length !== total) return
        const src = g.grid

        // 色板 → 全局方块编号（每区块建一次，供全部结构复用）
        const palMap = new Int32Array(g.palette.length + 1)
        let maxBlockId = -1
        for (let i = 0; i < g.palette.length; i++) {
          const gi = idOf(g.palette[i].id)
          palMap[i + 1] = gi
          if (gi > maxBlockId) maxBlockId = gi
        }

        const baseX = c.x * 16
        const baseZ = c.z * 16
        const covered = new Set<Stat>()

        for (const s of involved) {
          const stat = statOf(s.structure)
          const arr = countsOf(s.structure, maxBlockId)
          let cells = 0
          for (const piece of s.pieces) {
            const bb = piece.bb
            const x0 = Math.max(bb[0], baseX)
            const x1 = Math.min(bb[3], baseX + 15)
            const y0 = Math.max(bb[1], bottom)
            const y1 = Math.min(bb[4], top)
            const z0 = Math.max(bb[2], baseZ)
            const z1 = Math.min(bb[5], baseZ + 15)
            if (x0 > x1 || y0 > y1 || z0 > z1) continue

            const token = ++maskToken
            tokenOwner.set(token, stat)
            covered.add(stat)
            for (let y = y0; y <= y1; y++) {
              const rowBase = (y - bottom) * COLUMNS
              for (let z = z0; z <= z1; z++) {
                const colBase = rowBase + (z - baseZ) * 16
                for (let x = x0; x <= x1; x++) {
                  const idx = colBase + (x - baseX)
                  if (mask[idx] === token) continue
                  mask[idx] = token
                  cells++
                  const code = src[idx]
                  if (!code) continue
                  arr[palMap[code]]++
                }
              }
            }
          }
          stat.cells += cells
        }

        if (!covered.size) {
          for (const be of bes) holdPending(be)
          return
        }
        // 区块被某结构真正覆盖过一次就记一次（不是按片段数）
        for (const stat of covered) stat.coveredChunks++

        /* ---------------- 容器 / 刷怪笼 / 战利品表 ---------------- */

        for (const be of bes) {
          const bx = num(be.x, NaN)
          const by = num(be.y, NaN)
          const bz = num(be.z, NaN)
          if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)) continue
          const lx = bx - baseX, lz = bz - baseZ
          if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue
          const yi = by - bottom
          if (yi < 0 || yi >= h) continue
          const here = mask[yi * COLUMNS + lz * 16 + lx]
          const stat = here ? tokenOwner.get(here) : undefined
          const loot = lootTableOf(be)
          // 有战利品表的方块实体一律留到 finalize：归属由「表 → 结构」决定，
          // 而不是「落在谁的 BB 里」。海底神殿没有战利品箱，海洋废墟的箱子却可能落在它的 BB 内，
          // 按 BB 归属会把这些箱子算给神殿。
          if (loot && (lootOwnersOf(loot) || loot.replace(/^minecraft:/, "").startsWith("archaeology/"))) {
            holdPending(be)
            continue
          }
          if (!stat) {
            // BB 外（地牢、海洋废墟下移的可疑方块、少量漏归的结构方块实体）
            holdPending(be)
            continue
          }

          const id = str(be.id)
          if (id && CONTAINERS.has(id)) bump(stat.containers, id)
          if (loot) bump(stat.lootTables, loot)
          const spawner = spawnerKey(be)
          if (spawner) recordSpawner(stat, spawner, spawnerCapsOf(be))
        }

        /* ---------------- 生物 ---------------- */

        const entities = await c.entities()
        if (entities.length) {
          for (const e of entities) {
            const ex = Math.floor(e.pos[0])
            const ey = Math.floor(e.pos[1])
            const ez = Math.floor(e.pos[2])
            const lx = ex - baseX, lz = ez - baseZ
            if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue
            const yi = ey - bottom
            if (yi < 0 || yi >= h) continue
            const here = mask[yi * COLUMNS + lz * 16 + lx]
            if (!here) continue
            const stat = tokenOwner.get(here)
            if (!stat) continue
            const id = str((e.nbt as Record<string, unknown> | undefined)?.id)
            if (id) bump(stat.entities, id)
          }
        }
      },

      async finalize(ctx) {
        /* ---------------- 跨边界的实例 ---------------- */

        // 片段 BB 伸出已扫描区块的实例，容器只统计到一部分；仍计入 starts，单独报出
        for (const s of countedStarts.values()) {
          const stat = stats.get(s.structure)
          if (!stat) continue
          if (!coversAllChunks(s, scanned)) stat.truncatedStarts++
        }

        /* ---------------- 未归属方块实体的补归属 ---------------- */

        // 刷怪笼离 BB 很近时说明是结构自己漏出来的（结构不会把刷怪笼放到 BB 外十几格），
        // 否则它就是地牢的锚点：monster room 不是 jigsaw 结构，没有 start 也没有 BB。
        const dungeonAnchors: Dungeon[] = []
        const rest: PendingBe[] = []
        for (const be of pending) {
          if (!be.spawner) { rest.push(be); continue }
          const near = nearestStructure(be.x, be.y, be.z, NEAR_SPAWNER)
          if (near) {
            recordSpawner(near, be.spawner, be.caps)
            continue
          }
          dungeonAnchors.push({
            x: be.x, y: be.y, z: be.z,
            kind: be.spawner.split("\u0000")[1] ?? "unknown",
            containers: new Map(),
            lootTables: new Map(),
          })
        }

        // 地牢锚点的区块空间索引，供其余方块实体就近查询
        const dungeonIndex = new Map<string, Dungeon[]>()
        const dungeonCell = (cx: number, cz: number) => `${cx},${cz}`
        for (const d of dungeonAnchors) {
          const k = dungeonCell(d.x >> 4, d.z >> 4)
          const a = dungeonIndex.get(k)
          if (a) a.push(d)
          else dungeonIndex.set(k, [d])
        }
        const nearestDungeon = (x: number, y: number, z: number, maxDist: number): Dungeon | null => {
          const cx = x >> 4, cz = z >> 4
          const r = Math.ceil(maxDist / 16)
          let best = maxDist + 1e-9
          let found: Dungeon | null = null
          for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
              const a = dungeonIndex.get(dungeonCell(cx + dx, cz + dz))
              if (!a) continue
              for (const d of a) {
                const ddx = x - d.x, ddy = y - d.y, ddz = z - d.z
                const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)
                if (dist < best) { best = dist; found = d }
              }
            }
          }
          return found
        }

        const unassigned = { containers: new Map<string, number>(), lootTables: new Map<string, number>(), spawners: new Map<string, number>() }
        /** 地形特征类地标（无 start、无 BB），靠考古战利品表识别 */
        const landmarks = new Map<string, Landmark>()
        /** 战利品表说明属于某结构、但本范围内没有该结构的实例 */
        const missingOwnerLoot = new Map<string, number>()

        for (const be of rest) {
          // 战利品表能确定「这属于哪种结构」，优先于距离与地牢判定。
          // 唯一例外是地牢：`chests/simple_dungeon` 与矿井共用，地牢的箱子在刷怪笼 8 格内，
          // 先判地牢才不会被算成矿井。
          const dug = nearestDungeon(be.x, be.y, be.z, DUNGEON_RADIUS)
          if (dug) {
            if (be.id && CONTAINERS.has(be.id)) bump(dug.containers, be.id)
            if (be.loot) bump(dug.lootTables, be.loot)
            continue
          }

          const rawLoot = be.loot?.replace(/^minecraft:/, "") ?? null
          const owners = be.loot ? lootOwnersOf(be.loot) : null
          const ambiguous = rawLoot !== null && AMBIGUOUS_LOOT.has(rawLoot)

          if (owners && !ambiguous) {
            // 只在该结构的实例里找最近的，避免算给更近的别的结构
            const stat = nearestStructureOf(be.x, be.y, be.z, NEAR_LOOT, owners)
            if (stat) {
              if (be.id && CONTAINERS.has(be.id)) bump(stat.containers, be.id)
              if (be.loot) bump(stat.lootTables, be.loot)
              if (be.spawner) recordSpawner(stat, be.spawner, be.caps)
            } else {
              // 该结构的实例不在扫描范围内：报出来，别静默丢
              if (be.loot) bump(missingOwnerLoot, be.loot)
            }
            continue
          }

          if (rawLoot?.startsWith("archaeology/")) {
            // 考古表对不上任何结构 → 地形特征（placed feature，如沙漠水井）
            const owner = landmarkOwnerOf(be.loot!) ?? archaeologyOwner(be.loot!) ?? rawLoot.slice("archaeology/".length)
            let lm = landmarks.get(owner)
            if (!lm) {
              lm = {
                id: `minecraft:${owner}`, blocks: 0,
                blockTypes: new Map(), lootTables: new Map(), containers: new Map(), points: [],
              }
              landmarks.set(owner, lm)
            }
            lm.blocks++
            lm.points.push({ x: be.x, z: be.z })
            if (be.id && CONTAINERS.has(be.id)) bump(lm.containers, be.id)
            if (be.id) bump(lm.blockTypes, be.id)
            bump(lm.lootTables, be.loot!)
            continue
          }

          // 没有战利品表（或表未收录）：退回就近归属
          const near = nearestStructure(be.x, be.y, be.z, NEAR_STRUCTURE)
          if (near) {
            if (be.id && CONTAINERS.has(be.id)) bump(near.containers, be.id)
            if (be.loot) bump(near.lootTables, be.loot)
            if (be.spawner) bump(near.spawners, be.spawner)
            continue
          }
          if (be.id && CONTAINERS.has(be.id)) bump(unassigned.containers, be.id)
          if (be.loot) bump(unassigned.lootTables, be.loot)
          if (be.spawner) bump(unassigned.spawners, be.spawner)
        }

        const mapObj = (m: Map<string, number>) =>
          Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))

        /** 计数 → 每实例均值；starts 为 0 时返回 null（无定义，不填 0） */
        const perStartMap = (m: Map<string, number>, starts: number) => starts > 0
          ? Object.fromEntries(
              [...m.entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([k, n]) => [k, n / starts]),
            )
          : null

        /**
         * 实测实体 + 结构定义里的固定实体，合并成一份「每处几只」。
         *
         * 同一 id 在两边都出现时取**较大值**：`entities` 扫到的是已经生成的那几只，
         * 但结构定义给的是每处总量（例如神殿一定放 3 只远古守卫者），实测可能因为
         * 只扫到一部分而偏少。取大不取和，避免把同一批生物数两遍。
         */
        const perStartCombined = (
          m: Map<string, number>,
          spawned: Record<string, number>,
          starts: number,
        ): Record<string, number> | null => {
          if (starts <= 0) return null
          const out = new Map<string, number>()
          for (const [id, n] of m) out.set(id, n / starts)
          for (const [id, per] of Object.entries(spawned)) {
            out.set(id, Math.max(out.get(id) ?? 0, per))
          }
          return Object.fromEntries(
            [...out.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
          )
        }

        const rows = [...stats.values()]
          .sort((a, b) => b.cells - a.cells || a.structure.localeCompare(b.structure))
          .map(stat => {
            const perStart = (n: number) => (stat.starts > 0 ? n / stat.starts : 0)
            /** 该结构的「代码生成实体」定义；没有就是 undefined */
            const spawnedDef = STRUCTURE_SPAWNED[stat.structure]
            const pieceKinds = [...stat.pieceKinds.entries()]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([piece, count]) => ({
                piece,
                count,
                /** 含这段的实例数（同一实例重复出现只计一次） */
                instances: stat.pieceStarts.get(piece) ?? 0,
                perStart: perStart(count),
                share: stat.pieces > 0 ? count / stat.pieces : 0,
                /** 每覆盖一个区块出现几次：piece 级的游荡密度 */
                perCoveredChunk: stat.coveredChunks > 0 ? count / stat.coveredChunks : null,
                /** 每 1000 个已扫描（有地形）区块出现几次：与结构集合级密度同口径 */
                densityPer1000Chunks: terrainChunks > 0 ? count / terrainChunks * 1000 : null,
              }))

            // 模板分组：templates[模板路径] = 每实例出现次数，可直接乘以该模板的单份内容算产出
            const tplTotal = stat.pieces - stat.piecesWithoutTemplate
            const templates = [...stat.templates.entries()]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([template, count]) => ({
                template,
                count,
                /** 含这个模板的实例数（同一实例重复出现只计一次） */
                instances: stat.templateStarts.get(template) ?? 0,
                perStart: perStart(count),
                share: tplTotal > 0 ? count / tplTotal : 0,
                perCoveredChunk: stat.coveredChunks > 0 ? count / stat.coveredChunks : null,
                densityPer1000Chunks: terrainChunks > 0 ? count / terrainChunks * 1000 : null,
              }))

            const counts = blockCounts.get(stat.structure)
            const containerTotal = [...stat.containers.values()].reduce((a, b) => a + b, 0)
            let blockTotal = 0
            const all: { id: string, count: number }[] = []
            if (counts) {
              for (let i = 0; i < counts.length; i++) {
                const n = counts[i]
                if (!n) continue
                blockTotal += n
                all.push({ id: blockNames[i], count: n })
              }
            }
            all.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))

            const mapToObj = (m: Map<string, number>) =>
              Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
            const spawners = Object.fromEntries(
              [...stat.spawners.entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([k, n]) => {
                  const [block, kind] = k.split("\u0000")
                  return [`${block}|${kind}`, n]
                }),
            )
            const out: Record<string, unknown> = {
              structure: stat.structure,
              set: stat.set,
              starts: stat.starts,
              pieces: stat.pieces,
              piecesPerStart: perStart(stat.pieces),
              pieceKinds,
              /** 模板路径分组（拼图/模板类部件）；硬编码部件结构的项数为 0 */
              templates,
              /** 没有模板路径的片段数（矿井、要塞这类硬编码部件） */
              piecesWithoutTemplate: stat.piecesWithoutTemplate,
              coveredChunks: stat.coveredChunks,
              volume: stat.cells,
              volumePerStart: perStart(stat.cells),
              blockTotal,
              blockKinds: all.length,
              blocks: Object.fromEntries(all.slice(0, topBlocks).map(b => [b.id, b.count])),
              containers: mapToObj(stat.containers),
              /** 容器总数（`containers` 各类型之和） */
              containerTotal,
              /**
               * 专程口径：每处该结构平均能开几个容器（分母 = starts）。
               * starts = 0 时无定义，写 null。
               */
              containersPerStart: stat.starts > 0 ? containerTotal / stat.starts : null,
              /**
               * 游荡口径：该结构每覆盖一个区块平均有几个容器（分母 = coveredChunks）。
               * 与 containersPerStart 相差「每处平均覆盖区块数」倍，大结构可达 30 倍。
               */
              containersPerCoveredChunk: stat.coveredChunks > 0 ? containerTotal / stat.coveredChunks : null,
              /** 片段 BB 伸出扫描边界的实例数；这些实例的容器只统计到一部分 */
              truncatedStarts: stat.truncatedStarts,
              /** 容器统计完整的实例数（starts - truncatedStarts），供判断样本量 */
              containerSampleStarts: stat.starts - stat.truncatedStarts,
              lootTables: mapToObj(stat.lootTables),
              spawners,
              /**
               * 刷怪笼的「上限」类参数：`方块|怪物 → { samples, maxNearbyEntities, spawnCount, spawnRange }`。
               * 每项是实测的 `{min,max}` 区间；trial_spawner 没有这些数字，不出现在这里。
               */
              spawnerCaps: Object.fromEntries(
                [...stat.spawnerCaps.entries()]
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([k, v]) => {
                    const [block, kind] = k.split("\u0000")
                    return [`${block}|${kind}`, v]
                  }),
              ),
              entities: mapToObj(stat.entities),
              /** 每处该结构里已生成好的实体数（分母 starts）；与下游 entities_per_start 同口径 */
              entitiesPerStart: perStartMap(stat.entities, stat.starts),
              /**
               * 结构生成时由代码放出来、**扫不到**的实体：`实体 → 每处只数`。
               *
               * 与 `entities` 分开是刻意的：那是实测扫描值，这是结构定义里的固定数量
               * （见 `STRUCTURE_SPAWNED` 的出处）。海底神殿的远古守卫者属于这一类——
               * 预生成不会把它们写进实体存档，扫遍全图一只都没有。
               * 定义里没有这类实体的结构不出这个键。
               */
              ...(spawnedDef ? {
                spawnedPerStart: { ...spawnedDef },
                spawnedTotal: Object.fromEntries(
                  Object.entries(spawnedDef).map(([id, per]) => [id, per * stat.starts]),
                ),
                /** 合并口径：实测 + 结构定义，供「这个结构里一共有什么生物」直接取用 */
                entitiesPerStartCombined: perStartCombined(
                  stat.entities,
                  spawnedDef,
                  stat.starts,
                ),
              } : {}),
            }
            if (all.length > topBlocks) out.blocksTruncated = all.length - topBlocks
            return out
          })

        const totalStarts = rows.reduce((a, r) => a + (r.starts as number), 0)
        const spawnerRows = (m: Map<string, number>) => Object.fromEntries(
          [...m.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([k, n]) => {
              const [block, kind] = k.split("\u0000")
              return [`${block}|${kind}`, n]
            }),
        )

        /* ---------------- 地牢汇总 ---------------- */

        // 原版有两个地牢结构：monster_room（y >= 0，石砖）与 monster_room_deep（y < 0，深板岩）。
        // 两者都不写 structures.starts，只能靠刷怪笼锚点区分，所以按锚点高度拆开——
        // 「找一处地牢要搜多远」的分子往往只取某一层的洞穴体积，深浅合并会让口径对不上。
        const dungeonSummary = (list: Dungeon[]) => {
          const byKind = new Map<string, number>()
          const containerTypes = new Map<string, number>()
          const lootTables = new Map<string, number>()
          let containers = 0
          for (const d of list) {
            bump(byKind, d.kind)
            for (const [k, n] of d.containers) { bump(containerTypes, k, n); containers += n }
            for (const [k, n] of d.lootTables) bump(lootTables, k, n)
          }
          return {
            count: list.length,
            containers,
            /** 每间的容器数；没有样本时无定义，写 null */
            containersPerDungeon: list.length > 0 ? containers / list.length : null,
            byKind: mapObj(byKind),
            containerTypes: mapObj(containerTypes),
            lootTables: mapObj(lootTables),
          }
        }
        const shallowDungeons = dungeonAnchors.filter(d => d.y >= 0)
        const deepDungeons = dungeonAnchors.filter(d => d.y < 0)
        const dungeons = dungeonSummary(dungeonAnchors)

        /* ---------------- 地标（地形特征）汇总 ---------------- */

        // 每个实例含几个可疑方块从 jar 的 feature 定义里读；读不到就用实测聚类结果
        const landmarkRows: Record<string, unknown>[] = []
        /** 地标同时以「结构行」写出，下游 structure_content 才能像普通结构一样读取 */
        const landmarkStructureRows: Record<string, unknown>[] = []
        for (const lm of [...landmarks.values()].sort((a, b) => b.blocks - a.blocks)) {
          const perInstance = await suspiciousPerInstance(ctx.runtime.serverJar, shortId(lm.id))
          const centers = clusterPoints(lm.points, LANDMARK_CLUSTER_RADIUS).map(centroid)
          const starts = centers.length
          const nn = summariseNN(centers)
          const coveredChunks = new Set(lm.points.map(p => `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`)).size
          const containerTotal = [...lm.containers.values()].reduce((a, b) => a + b, 0)
          const setId = landmarkSetId(shortId(lm.id))
          const blocksPerInstance = perInstance ?? (starts > 0 ? lm.blocks / starts : null)
          const density = terrainChunks > 0 ? starts / terrainChunks * 1000 : null

          landmarkRows.push({
            id: lm.id,
            set: setId,
            /** 实例数：可疑方块按 LANDMARK_CLUSTER_RADIUS 聚类后的组数（实测） */
            count: starts,
            /** 实测到的可疑方块数 */
            blocks: lm.blocks,
            /** 每个实例含几个可疑方块：优先读 jar 的 feature 定义，读不到用 blocks / count */
            blocksPerInstance,
            /** 每处平均可疑方块数（分母 count） */
            blocksPerStart: starts > 0 ? lm.blocks / starts : null,
            /** 每处平均容器数（沙漠水井为 0）；分母 count */
            containersPerStart: starts > 0 ? containerTotal / starts : null,
            containers: mapObj(lm.containers),
            /**
             * 每 1000 个已扫描（有地形）区块的实例数，与结构集合级同口径。
             */
            densityPer1000Chunks: density,
            /**
             * 每区块平均可疑方块数。分母是**有地形的区块数**，不是 chunks——
             * 后者只数「涉及结构的区块」，没结构的区块不进分母。
             */
            blocksPerChunk: terrainChunks > 0 ? lm.blocks / terrainChunks : null,
            /** 最近邻距离分布：实例中心之间的最近距离（与 structure-spacing 同口径） */
            nearest: {
              meanNNBlocks: nn.meanNNBlocks,
              medianNNBlocks: nn.medianNNBlocks,
              quantiles: nn.quantiles,
              varianceNN: nn.varianceNN,
              minNNBlocks: nn.minNNBlocks,
              maxNNBlocks: nn.maxNNBlocks,
              reliable: nn.reliable,
              densityPer1000Chunks: density,
            },
            blockTypes: mapObj(lm.blockTypes),
            lootTables: mapObj(lm.lootTables),
          })

          landmarkStructureRows.push({
            structure: lm.id,
            set: setId,
            /** 实例数（聚类组数）。地标没有 structure start，starts 是实测实例数 */
            starts,
            pieces: starts,
            piecesPerStart: 1,
            pieceKinds: [],
            templates: [],
            piecesWithoutTemplate: starts,
            coveredChunks,
            volume: null,
            volumePerStart: null,
            blockTotal: lm.blocks,
            blockKinds: lm.blockTypes.size,
            blocks: mapObj(lm.blockTypes),
            containers: mapObj(lm.containers),
            containerTotal,
            containersPerStart: starts > 0 ? containerTotal / starts : null,
            containersPerCoveredChunk: coveredChunks > 0 ? containerTotal / coveredChunks : null,
            truncatedStarts: 0,
            containerSampleStarts: starts,
            lootTables: mapObj(lm.lootTables),
            spawners: {},
            spawnerCaps: {},
            entities: {},
            entitiesPerStart: null,
            /** 地形特征：没有片段 BB、没有 structure start */
            source: "feature",
            blocksPerStart: starts > 0 ? lm.blocks / starts : null,
            suspiciousPerInstance: perInstance,
            nearest: {
              meanNNBlocks: nn.meanNNBlocks,
              medianNNBlocks: nn.medianNNBlocks,
              quantiles: nn.quantiles,
              varianceNN: nn.varianceNN,
              minNNBlocks: nn.minNNBlocks,
              maxNNBlocks: nn.maxNNBlocks,
              reliable: nn.reliable,
              densityPer1000Chunks: density,
            },
          })
        }

        return {
          chunks,
          /** 有地形的区块数：piece 级密度与地标密度的分母 */
          scannedChunks: terrainChunks,
          structures: [...rows, ...landmarkStructureRows],
          dungeons: {
            ...dungeons,
            /**
             * 按锚点高度拆分：`shallow` 是 y >= 0 的 monster_room，`deep` 是 y < 0 的
             * monster_room_deep。两组的 count 相加等于顶层 count。
             */
            byDepth: {
              shallow: dungeonSummary(shallowDungeons),
              deep: dungeonSummary(deepDungeons),
            },
            /**
             * 每间地牢的占地体积：地牢不是结构，没有 `structures.starts` 与片段 BB，
             * 锚点只有刷怪笼坐标，扫不到房间边界，故未测。字段留着表示「口径适用但没测到」。
             */
            avgVolume: null,
          },
          unassigned: {
            containers: mapObj(unassigned.containers),
            lootTables: mapObj(unassigned.lootTables),
            spawners: spawnerRows(unassigned.spawners),
          },
          /**
           * 战利品表能确定属于某种结构、但该结构在本范围内没有实例的方块数。
           * 出现在这里通常意味着统计范围没覆盖到那座结构（或范围边界切掉了它），不是归属失败。
           */
          missingOwnerLoot: mapObj(missingOwnerLoot),
          /** 地形特征类地标（无 start、无 BB），靠可疑方块的考古战利品表识别 */
          landmarks: landmarkRows,
          note: "体积为 BB 并集内的方体数（重叠片段只计一次）；方块按 BB 与区块求交归属到结构，多结构重叠处各自计入；容器/战利品表/刷怪笼的归属优先看战利品表（表由结构模板与 processor 决定，是数据事实），在表所指结构里取最近实例；有表但表未收录、或表被多种结构共用的（chests/simple_dungeon 同时是矿井与地牢的箱子），退回就近归属；刷怪笼按「方块|怪物」分开统计；dungeons 是地牢（monster room，非 jigsaw 结构、没有 start 与 BB），以结构外的刷怪笼为锚点、8 格内的容器归入同一间（地牢判定优先于战利品表归属）；dungeons.byDepth 按锚点高度拆分（shallow = y >= 0 的 monster_room，deep = y < 0 的 monster_room_deep），两组的 count 相加等于顶层 count；地牢没有片段 BB，扫不到房间边界，故 avgVolume 为 null（口径适用但未测）；landmarks 是地形特征（placed feature，如沙漠水井），不写 structures.starts、没有 BB，只能靠考古战利品表识别；同一批数据也以 structure 行写入 structures（source=feature，starts 是可疑方块按 LANDMARK_CLUSTER_RADIUS 聚类出的实例数，nearest 是实例中心之间的最近邻分布），让下游与普通结构同口径读取；blocks 是实测方块数、blocksPerInstance 读自 jar 的 feature 定义、count 是实测实例数；missingOwnerLoot 是「表说明属于某结构、但该结构在本范围内没有实例」的方块数，通常意味着范围没覆盖到那座结构；unassigned 是连就近归属都失败的部分。容器有两种分母：containersPerStart 的分母是 starts（专程去一处），containersPerCoveredChunk 的分母是 coveredChunks（游荡撞见），两者相差每处平均覆盖区块数倍，不可混用；truncatedStarts 是片段伸出扫描边界的实例数，它们的容器只统计到一部分，会使 containersPerStart 偏低",
          totals: {
            structures: rows.length + landmarkStructureRows.length,
            starts: totalStarts + landmarkStructureRows.reduce((a, r) => a + (r.starts as number), 0),
            pieces: rows.reduce((a, r) => a + (r.pieces as number), 0)
              + landmarkStructureRows.reduce((a, r) => a + (r.pieces as number), 0),
            volume: rows.reduce((a, r) => a + ((r.volume as number | null) ?? 0), 0),
          },
        }
      },
    }
  },

  format(result) {
    const r = result as {
      chunks: number
      structures: {
        structure: string, starts: number, pieces: number, piecesPerStart: number,
        volume: number, volumePerStart: number, blockKinds: number, coveredChunks: number,
        containers: Record<string, number>, containerTotal: number,
        containersPerStart: number | null, containersPerCoveredChunk: number | null,
        truncatedStarts: number,
        lootTables: Record<string, number>,
        spawners: Record<string, number>, entities: Record<string, number>,
        spawnedPerStart?: Record<string, number>
      }[]
      dungeons: {
        count: number, containers: number, containersPerDungeon: number | null,
        byKind: Record<string, number>,
        byDepth?: Record<string, {
          count: number, containers: number, containersPerDungeon: number | null,
          byKind: Record<string, number>
        }>
      }
      landmarks?: {
        id: string, blocks: number, blocksPerInstance: number | null,
        count: number | null, blocksPerChunk: number | null
      }[]
    }
    if (!r.structures.length && !r.landmarks?.length) return ["没有结构片段"]
    const lines = [`结构 ${r.structures.length} 种，涉及区块 ${r.chunks}`]
    const fx = (v: number) => String(Number(v.toFixed(2)))
    for (const s of r.structures.slice(0, 12)) {
      const lootTop = Object.entries(s.lootTables).sort((a, b) => b[1] - a[1])[0]
      const entTop = Object.entries(s.entities).sort((a, b) => b[1] - a[1])[0]
      const spawnTop = Object.entries(s.spawners).sort((a, b) => b[1] - a[1])[0]
      lines.push(
        `  ${s.structure.replace("minecraft:", "").padEnd(24)}`
        + ` 起点 ${String(s.starts).padStart(4)}  片段 ${String(s.pieces).padStart(5)}（${fx(s.piecesPerStart)}/起）`
        + `  体积 ${String(s.volume).padStart(9)}（${fx(s.volumePerStart)}/起）  方块种 ${String(s.blockKinds).padStart(3)}`,
      )
      const parts: string[] = []
      if (lootTop) parts.push(`战利品 ${lootTop[0].replace("minecraft:", "")}×${lootTop[1]}`)
      if (spawnTop) parts.push(`刷怪 ${spawnTop[0].replace("|", ":")}×${spawnTop[1]}`)
      if (entTop) parts.push(`生物 ${entTop[0].replace("minecraft:", "")}×${entTop[1]}`)
      // 代码生成、扫不到的实体（海底神殿的远古守卫者）：单列并以 /处 为单位
      if (s.spawnedPerStart) {
        const list = Object.entries(s.spawnedPerStart)
          .sort((a, b) => b[1] - a[1])
          .map(([id, per]) => `${id.replace("minecraft:", "")}×${fx(per)}/处`)
          .join("、")
        parts.push(`结构生成 ${list}`)
      }
      const containerCount = s.containerTotal
      if (containerCount) {
        const perStart = s.containersPerStart === null ? "-" : fx(s.containersPerStart)
        const perChunk = s.containersPerCoveredChunk === null ? "-" : s.containersPerCoveredChunk.toFixed(3)
        parts.push(`容器 ${containerCount}（${perStart}/起，${perChunk}/区块）`)
      }
      if (parts.length) lines.push(`      ${parts.join("  ")}`)
    }
    if (r.structures.length > 12) lines.push(`  …另有 ${r.structures.length - 12} 种`)
    if (r.dungeons?.count) {
      const kinds = Object.entries(r.dungeons.byKind).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}×${n}`).join(" ")
      const per = r.dungeons.containersPerDungeon === null ? "-" : fx(r.dungeons.containersPerDungeon)
      lines.push(
        `  ${`地牢(monster_room)`.padEnd(24)} 间数 ${String(r.dungeons.count).padStart(4)}`
        + `  箱子 ${String(r.dungeons.containers).padStart(5)}（${per}/间）`
        + `  ${kinds}`,
      )
      // 浅层 y>=0 与深层 y<0 是两个原版结构，合并后的间距口径不可用
      for (const [depth, label] of [["shallow", "浅层 y>=0"], ["deep", "深层 y<0"]] as const) {
        const d = r.dungeons.byDepth?.[depth]
        if (!d?.count) continue
        const dp = d.containersPerDungeon === null ? "-" : fx(d.containersPerDungeon)
        const dk = Object.entries(d.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(" ")
        lines.push(
          `    ${label.padEnd(12)} 间数 ${String(d.count).padStart(4)}  箱子 ${String(d.containers).padStart(5)}（${dp}/间）  ${dk}`,
        )
      }
    }
    if (r.landmarks?.length) {
      for (const lm of r.landmarks) {
        const per = lm.blocksPerInstance === null ? "-" : String(lm.blocksPerInstance)
        const cnt = lm.count === null ? "-" : fx(lm.count)
        const dens = lm.blocksPerChunk === null ? "-" : lm.blocksPerChunk.toFixed(6)
        lines.push(
          `  ${shortId(lm.id).padEnd(24)} 可疑方块 ${String(lm.blocks).padStart(4)}`
          + `（${per}/处）  处数 ${cnt}  密度 ${dens}/区块`,
        )
      }
    }
    return lines
  },
}

export default analyzer
