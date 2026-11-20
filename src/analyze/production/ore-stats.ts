import type { World, ChunkRef } from "minecraft-block-reader"
import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"
import { packXZ } from "../terrain.js"

/**
 * 资源方块统计：一个分析器覆盖所有维度，同时给出
 * **群系密度**、**空气/水暴露**、**区段分布**三组数据。
 *
 * 统计对象不只是矿石：除了主世界/下界的矿，还含末地的资源方块
 * （紫颂植物、黑曜石），见 DEFAULT_ORES。
 *
 * 合并前的三个分析器（ore-exposure / biome-ore / biome-ore-nether）有实质重叠：
 * 都在遍历 grid 找矿石、算每区块密度、算区段分布，暴露判定还各写了一遍。
 * 真正不同的只有「群系归属口径」，而这个可以由**维度**决定，不需要多个分析器。
 *
 * 群系归属口径（biomeBasis）：
 * - `surface`（主世界 / 末地）：群系取该列地表（最高非空气方块）处的群系，
 *   与 biome-histogram / biome-patch 同口径。资源按所在 (x,z) 列的地表群系归属 ——
 *   「站在这个群系的表面往下挖能挖到什么」。分母 = 地表列数 / 256（面积份额）。
 * - `in-situ`（下界）：群系取资源**自身所在位置**的群系单元。下界群系按 4³ 单元
 *   三维分布，同一列从底到顶可能穿过多个群系，按列的口径在这里不成立。
 *   分母 = 该群系固体方块数 / 每区块平均固体方块数（等效满固体区块数），
 *   只数非空气方块，避免顶部空气与洞穴稀释密度。
 *
 * 选 surface 还是 in-situ 取决于该维度的群系怎么决定：群系由 2D 噪声决定
 * （每列一个群系）就用 surface，由 3D 噪声决定（同列可穿多个群系）就用 in-situ。
 * 当前只有下界是后者。
 *
 * 暴露判定（两个口径一致）：
 * - 6 面邻居里任意一个是空气 → 空气暴露；任意一个是水 → 水暴露；
 *   两者都有时同时计入并另记 both。
 * - 跨区块的邻居会去读相邻区块（同 region 内）；读不到记 unknownEdge，
 *   不当成「埋着」也不当成「露出」——否则贴 region 边界的矿石会被系统性误判。
 *
 * 可靠度分两层，互不影响：
 * - `reliable`（群系级）：chunks >= minChunks。管**密度**，因为密度是区域平均量，
 *   需要足够的区块面积。
 * - `reliableExposure`（资源级）：count >= minOreSamples。管**暴露率**，
 *   因为暴露率是方块级概率，样本是方块数 —— 一个只占 130 区块的小群系可能有上万个方块，
 *   它的暴露率很准，而它的密度并不可靠。
 *
 * 两类方块列表**独立维护**：
 * - `exposure`：需要逐面判定暴露的方块（默认原版全部矿石）。回答「挖矿时能不能看见」。
 * - `bulk`：只统计数量、不做暴露判定的方块（默认紫颂植物、黑曜石）。
 *   它们天生在开阔处（实测紫颂在所有群系暴露率都是 100%），算暴露没有信息量，
 *   却要为每个方块查 6 面邻居 —— 末地就有 40 万个紫颂方块，那笔开销不值得。
 *
 * 同一 id 同时出现在两个列表里时以 exposure 为准（暴露统计自带数量）。
 *
 * params:
 *   exposure?: string[]    暴露统计的方块（默认矿石，见 DEFAULT_EXPOSURE_BLOCKS）
 *   bulk?: string[]        只统计数量的方块（默认末地资源，见 DEFAULT_BULK_BLOCKS）
 *   yMin?, yMax?: number   只统计该高度范围内的资源
 *   minChunks?: number     密度可靠度阈值（默认 200 区块）
 *   minOreSamples?: number 暴露率可靠度阈值（默认 200 个方块）
 *   sections?: boolean     是否输出区段分布（默认 true）
 *   biomeBasis?: string    auto（默认，按维度决定）/ surface / in-situ
 *   top?: number           控制台摘要列出的群系数（默认 10）
 */

/**
 * 暴露统计的方块列表（默认：原版全部矿石）。
 *
 * 这些方块需要逐面查邻居算暴露率 —— 它回答「挖矿时能不能看见」。
 */
export const DEFAULT_EXPOSURE_BLOCKS = [
  "minecraft:coal_ore", "minecraft:deepslate_coal_ore",
  "minecraft:iron_ore", "minecraft:deepslate_iron_ore",
  "minecraft:copper_ore", "minecraft:deepslate_copper_ore",
  "minecraft:gold_ore", "minecraft:deepslate_gold_ore",
  "minecraft:redstone_ore", "minecraft:deepslate_redstone_ore",
  "minecraft:lapis_ore", "minecraft:deepslate_lapis_ore",
  "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore",
  "minecraft:emerald_ore", "minecraft:deepslate_emerald_ore",
  "minecraft:nether_gold_ore", "minecraft:nether_quartz_ore",
  "minecraft:ancient_debris",
]

/**
 * 只统计数量、不做暴露判定的方块列表（默认：末地资源）。
 *
 * 这两类方块天生就在开阔处 —— 实测紫颂植物在所有群系的暴露率都是 100%，
 * 黑曜石柱也是地表柱体 —— 算暴露率没有信息量，却要为每个方块查 6 面邻居。
 * 末地就有 40 万个紫颂方块，那笔开销不值得。
 */
export const DEFAULT_BULK_BLOCKS = [
  "minecraft:chorus_plant", "minecraft:chorus_flower",
  "minecraft:obsidian",
]

/** 老名字的兼容别名（曾有调用方按这个名导入） */
export const DEFAULT_ORES = DEFAULT_EXPOSURE_BLOCKS

/** deepslate_/nether_ 前缀归并到同一矿种，用于家族汇总 */
export function oreFamily(id: string): string {
  return id
    .replace(/^minecraft:/, "")
    .replace(/^deepslate_/, "")
    .replace(/^nether_gold_ore$/, "gold_ore")
    .replace(/^nether_quartz_ore$/, "quartz_ore")
    .replace(/^ancient_debris$/, "debris")
    // 紫颂植物整株算一类：果（花）与茎是同一资源的两种形态
    .replace(/^chorus_plant$/, "chorus")
    .replace(/^chorus_flower$/, "chorus")
}

const KEY = "ore-stats"
const DEFAULT_MIN_CHUNKS = 200
const DEFAULT_MIN_ORE_SAMPLES = 200
const DEFAULT_TOP = 10
/** 一列 = 1 方块²，一个区块 16×16 = 256 列 */
const COLUMNS_PER_CHUNK = 256

const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"])
const WATER = new Set(["minecraft:water", "minecraft:bubble_column"])
const DIRS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

/** 邻居查询用的方块分类码：0 保留给「邻区块读不到」，不与空气混用 */
const W_UNKNOWN = 0
const W_AIR = 1
const W_WATER = 2
const W_SOLID = 3

/**
 * 一个区块的方块数据（不拷贝）。
 * 查询时直接算 `pal[grid[idx]]`：两级数组读，比先拷一份分类码
 * （每块约 9.8 万次写入）便宜得多。
 */
interface ChunkCodes {
  grid: Uint16Array
  /** 调色板索引 → 分类码（1-based；0 位是空气） */
  pal: Uint8Array
  bottom: number
  h: number
  /** 本区块里需要统计的格子下标（只在自块建码时收集） */
  exposureIdx?: number[]
  bulkIdx?: number[]
}

interface Counts { total: number, air: number, water: number, both: number, buried: number, unknown: number }
const emptyCounts = (): Counts => ({ total: 0, air: 0, water: 0, both: 0, buried: 0, unknown: 0 })

/** 计入一个矿石。写成模块级函数而不是闭包：主世界有 650 万个矿石，闭包就是 650 万次分配 */
const addOne = (t: Counts, air: boolean, water: boolean, unknown: boolean) => {
  t.total++
  if (air) t.air++
  if (water) t.water++
  if (air && water) t.both++
  if (!air && !water) {
    if (unknown) t.unknown++
    else t.buried++
  }
}

interface OreStat {
  count: number
  /** 每等效区块平均；分母见 biomeBasis */
  avgPerChunk: number
  airExposed: number
  avgAirExposed: number
  waterExposed: number
  avgWaterExposed: number
  /** 同时接触空气与水 */
  both: number
  buried: number
  avgBuried: number
  /** 邻块读不到的数量（贴 region 边界）；不计入 buried */
  unknownEdge: number
  airPct: number
  waterPct: number
  /** 暴露率是否可采信（按矿石数判定，与群系的区块级 reliable 无关） */
  reliableExposure: boolean
}

interface SectionRow {
  yRange: [number, number]
  /** 本区段的资源方块总数（两类合计） */
  blocks: number
  exposure: Record<string, { count: number, avgPerChunk: number, share: number, airPct: number }>
  bulk: Record<string, { count: number, avgPerChunk: number, share: number }>
}

/** 只统计数量、不做暴露判定的条目 */
interface BulkStat {
  count: number
  avgPerChunk: number
}

const analyzer: AnalyzerModule = {
  name: KEY,
  description: "资源方块统计：按群系统计密度、空气/水暴露与区段分布（主世界/末地用地表群系，下界用原地群系单元）",
  // 主世界单个维度就有近 1MB（55 群系 × 12 区段 × 精确矿种），
  // 合并成一个文件不便按需读取，按维度拆开。
  splitByDimension: true,
  parallelCost: 7.9,
  units: { density: "per_chunk", sectionDensity: "per_chunk_per_section", share: "percent", area: "block^2" },
  create(params): Analyzer {
    const p = (params[KEY] ?? {}) as Record<string, unknown>
    const norm = (list: string[]) => list.map(o => (o.includes(":") ? o : `minecraft:${o}`))
    const exposureSet = new Set(norm((p.exposure as string[] | undefined) ?? DEFAULT_EXPOSURE_BLOCKS))
    const bulkSet = new Set(norm((p.bulk as string[] | undefined) ?? DEFAULT_BULK_BLOCKS))
    // 同一 id 出现在两个列表里时以暴露为准（暴露统计自带数量，不必再算一遍）
    for (const id of exposureSet) bulkSet.delete(id)

    const yMin = p.yMin as number | undefined
    const yMax = p.yMax as number | undefined
    const minChunks = Math.max(1, Math.trunc(Number(p.minChunks) || DEFAULT_MIN_CHUNKS))
    const minOreSamples = Math.max(1, Math.trunc(Number(p.minOreSamples) || DEFAULT_MIN_ORE_SAMPLES))
    const wantSections = p.sections !== false
    const wantTop = Math.max(1, Math.trunc(Number(p.top) || DEFAULT_TOP))
    const basisParam = String(p.biomeBasis ?? "auto")

    /** 家族预计算：oreFamily 要跑几个正则，方块上百万个，先按种类算一次 */
    const familyOf = new Map<string, string>()
    for (const id of [...exposureSet, ...bulkSet]) familyOf.set(id, oreFamily(id))

    /** 群系 id ↔ 内部编号（0 保留给「无群系数据」） */
    const palette = new Map<string, number>()
    const ids: string[] = [""]
    const idOf = (id: string): number => {
      let i = palette.get(id)
      if (i === undefined) {
        ids.push(id)
        i = ids.length - 1
        palette.set(id, i)
      }
      return i
    }

    let dimension = "overworld"
    let basis: "surface" | "in-situ" = "surface"

    // 群系级累计
    const biomeColumns = new Map<number, number>()
    const biomeSolid = new Map<number, number>()
    const biomeChunks = new Map<number, Set<number>>()
    /** 暴露统计：群系 → 方块 id → 计数 */
    const biomeOre = new Map<number, Map<string, Counts>>()
    /** 数量统计：群系 → 方块 id → 个数 */
    const biomeBulk = new Map<number, Map<string, number>>()
    const biomeOreSection = new Map<number, Map<number, Map<string, Counts>>>()
    const biomeBulkSection = new Map<number, Map<number, Map<string, number>>>()
    /** 全维度按家族 → 区段（不分群系）：看某种资源聚在哪一层 */
    const famSection = new Map<string, Map<number, Counts>>()

    let chunks = 0
    let scannedSolid = 0
    let totalColumns = 0
    let oreBlocks = 0
    /** 数量统计类的方块总数（不计暴露） */
    let bulkBlocks = 0
    let blocksWithoutBiome = 0

    // region 内跨区块邻居查询
    let world: World | null = null
    let refs = new Map<string, ChunkRef>()
    const cache = new Map<string, ChunkCodes | null>()
    const chunkKey = (cx: number, cz: number) => `${cx},${cz}`

    const classify = (id: string) => (AIR.has(id) ? W_AIR : WATER.has(id) ? W_WATER : W_SOLID)

    /**
     * 包装 chunkGrid 并顺手收集两类目标方块的位置。
     *
     * 用 grid 而不是 blocks：后者要为每个方块产出 [state,x,y,z] 四元组，实测 1.3ms/块；
     * grid 只给一份 Uint16Array 调色板索引，0.55ms/块。
     * 不拷分类码、不补边距，全部靠 `pal[grid[idx]]` 现算。
     */
    const packGrid = (
      g: { palette: { id: string }[], grid: Uint16Array },
      bottom: number,
      h: number,
      expOf?: Uint8Array,
      bulkOf?: Uint8Array,
    ): ChunkCodes | null => {
      if (!g || g.grid.length !== h * COLUMNS_PER_CHUNK) return null
      const pal = new Uint8Array(g.palette.length + 1)
      // grid 的 0 表示空气，映射表第 0 位必须是空气；调色板索引是 1-based
      pal[0] = W_AIR
      for (let i = 0; i < g.palette.length; i++) pal[i + 1] = classify(g.palette[i].id)

      let exposureIdx: number[] | undefined
      let bulkIdx: number[] | undefined
      if (expOf || bulkOf) {
        exposureIdx = expOf ? [] : undefined
        bulkIdx = bulkOf ? [] : undefined
        const src = g.grid
        for (let i = 0; i < src.length; i++) {
          const v = src[i]
          if (v === 0) continue
          if (expOf && expOf[v]) exposureIdx!.push(i)
          else if (bulkOf && bulkOf[v]) bulkIdx!.push(i)
        }
      }
      return { grid: g.grid, pal, bottom, h, exposureIdx, bulkIdx }
    }

    /** 取指定区块里某格的分类码；竖向越界就是空气（区块上下方没有方块） */
    const codeAt = (cs: ChunkCodes, lx: number, y: number, lz: number): number => {
      const yi = y - cs.bottom
      if (yi < 0 || yi >= cs.h) return W_AIR
      return cs.pal[cs.grid[yi * COLUMNS_PER_CHUNK + lz * 16 + lx]]
    }

    const codesAt = async (cx: number, cz: number): Promise<ChunkCodes | null> => {
      const k = chunkKey(cx, cz)
      const hit = cache.get(k)
      if (hit !== undefined) return hit
      const ref = refs.get(k)
      if (!ref || !world) { cache.set(k, null); return null }
      const ext = await world.chunkExtent(ref)
      const h = ext ? ext.top - ext.bottom + 1 : 0
      const entry = ext && h > 0
        ? packGrid(await world.chunkGrid(ref, { yMin: ext.bottom, yMax: ext.top }), ext.bottom, h)
        : null
      cache.set(k, entry)
      // 已处理过的区块由它自己的 onChunk 写进来，这条路只兜底被范围过滤掉的区块
      if (cache.size > 128) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined && oldest !== k) cache.delete(oldest)
      }
      return entry
    }

    const getCounts = (map: Map<string, Counts>, key: string): Counts => {
      let t = map.get(key)
      if (!t) { t = emptyCounts(); map.set(key, t) }
      return t
    }

    return {
      name: KEY,
      onRegion(session) {
        world = session.world
        refs = new Map(session.chunks.map(c => [chunkKey(c.cx, c.cz), c]))
        cache.clear()
        if (session.dimension !== dimension) {
          dimension = session.dimension
          // 群系归属口径按维度的群系生成方式决定：
          // - 主世界 / 末地：群系由 2D 噪声（或固定分布）决定，每列一个群系 → surface
          // - 下界：群系由 3D 噪声决定，同一列从底到顶可穿过多个群系 → in-situ
          basis = basisParam === "surface" || basisParam === "in-situ"
            ? basisParam
            : dimension === "the_nether" ? "in-situ" : "surface"
        }
      },
      async onChunk(c: ChunkHandle) {
        // 一次 ext + 一次 grid = 一次区块解码；grid 走 handle 的 memo，
        // 与 section-block-histogram / biome-histogram 等共享同一份结果
        const ext = await c.extent()
        if (!ext) return
        const h = ext.top - ext.bottom + 1
        if (h <= 0) return
        const g = await c.grid({ yMin: ext.bottom, yMax: ext.top })
        if (!g || g.grid.length !== h * COLUMNS_PER_CHUNK) return
        chunks++

        // 两类目标的判定表
        const isExp = new Uint8Array(g.palette.length + 1)
        const isBulk = new Uint8Array(g.palette.length + 1)
        let anyExp = false, anyBulk = false
        for (let i = 0; i < g.palette.length; i++) {
          const id = g.palette[i].id
          if (exposureSet.has(id)) { isExp[i + 1] = 1; anyExp = true }
          else if (bulkSet.has(id)) { isBulk[i + 1] = 1; anyBulk = true }
        }

        const self = packGrid(g, ext.bottom, h, anyExp ? isExp : undefined, anyBulk ? isBulk : undefined)
        if (!self) return
        cache.set(chunkKey(c.x, c.z), self)

        const bottom = ext.bottom
        const src = g.grid
        const total = h * COLUMNS_PER_CHUNK

        /* ---------------- 群系归属 ---------------- */

        // surface 口径：每列地表群系。in-situ 口径：直接用体素自己的群系。
        // 两者都归约成「索引 → 群系编号」的查询函数，主循环不必分支。
        let colBiome: Uint16Array | null = null
        let voxBiome: Int32Array | null = null

        if (basis === "surface") {
          colBiome = new Uint16Array(COLUMNS_PER_CHUNK)
          for (let col = 0; col < COLUMNS_PER_CHUNK; col++) {
            // 从高往低找第一个非空气方块（水算方块）
            let topOff = -1
            for (let yi = h - 1; yi >= 0; yi--) {
              if (src[yi * COLUMNS_PER_CHUNK + col] !== 0) { topOff = yi; break }
            }
            if (topOff < 0) continue
            const bIdx = g.biomes.grid[topOff * COLUMNS_PER_CHUNK + col]
            if (!bIdx) continue
            const bId = g.biomes.palette[bIdx - 1]
            if (!bId) continue
            colBiome[col] = idOf(bId)
          }
        } else {
          // 群系网格与方块网格必须同形，否则按索引归属会错位
          if (g.biomes.grid.length !== total) return
          const bPal = g.biomes.palette
          const toGlobal = new Int32Array(bPal.length + 1)
          for (let i = 0; i < bPal.length; i++) toGlobal[i + 1] = idOf(bPal[i])
          voxBiome = new Int32Array(total)
          const seenBiomes = new Set<number>()
          for (let i = 0; i < total; i++) {
            const b = toGlobal[g.biomes.grid[i]]
            if (!b) { blocksWithoutBiome++; continue }
            voxBiome[i] = b
            seenBiomes.add(b)
            if (src[i] !== 0) {
              biomeSolid.set(b, (biomeSolid.get(b) ?? 0) + 1)
              scannedSolid++
            }
          }
          // 一个区块内同一群系可能只占几个方块，但整块都要算进它的 chunks
          const key = packXZ(c.x, c.z)
          for (const b of seenBiomes) {
            let set = biomeChunks.get(b)
            if (!set) { set = new Set(); biomeChunks.set(b, set) }
            set.add(key)
          }
        }

        if (basis === "surface") {
          // 列数与地表面积份额
          const key = packXZ(c.x, c.z)
          for (let col = 0; col < COLUMNS_PER_CHUNK; col++) {
            const b = colBiome![col]
            if (!b) continue
            totalColumns++
            biomeColumns.set(b, (biomeColumns.get(b) ?? 0) + 1)
            let set = biomeChunks.get(b)
            if (!set) { set = new Set(); biomeChunks.set(b, set) }
            set.add(key)
          }
        }

        const biomeAt = (i: number): number => (colBiome ? colBiome[i & 255] : voxBiome![i])

        const expIdx = self.exposureIdx
        const bulkIdx = self.bulkIdx
        if (!expIdx?.length && !bulkIdx?.length) return

        /** 区段起点查表，避免每个方块做 Math.floor */
        const secOfLayer = new Int32Array(h)
        for (let yi = 0; yi < h; yi++) secOfLayer[yi] = Math.floor((bottom + yi) / 16) * 16

        /* ---------------- 数量统计：不做暴露判定 ---------------- */

        for (const i of bulkIdx ?? []) {
          const y = bottom + (i >> 8)
          if (yMin !== undefined && y < yMin) continue
          if (yMax !== undefined && y > yMax) continue
          const b = biomeAt(i)
          if (!b) continue

          const id = g.palette[src[i] - 1].id
          const fam = familyOf.get(id)!
          bulkBlocks++
          const sec = secOfLayer[i >> 8]

          let byBiome = biomeBulk.get(b)
          if (!byBiome) { byBiome = new Map(); biomeBulk.set(b, byBiome) }
          byBiome.set(id, (byBiome.get(id) ?? 0) + 1)

          // 全维度按家族区段：暴露计数留空（bulk 类不算暴露）
          let fs = famSection.get(fam)
          if (!fs) { fs = new Map(); famSection.set(fam, fs) }
          let fsc = fs.get(sec)
          if (!fsc) { fsc = emptyCounts(); fs.set(sec, fsc) }
          fsc.total++

          if (wantSections) {
            let bySec = biomeBulkSection.get(b)
            if (!bySec) { bySec = new Map(); biomeBulkSection.set(b, bySec) }
            let m = bySec.get(sec)
            if (!m) { m = new Map(); bySec.set(sec, m) }
            m.set(id, (m.get(id) ?? 0) + 1)
          }
        }

        /* ---------------- 暴露统计：逐个查 6 面 ---------------- */

        if (!expIdx?.length) return

        // 4 个侧邻只在方块贴到该侧边时才解析
        let west: ChunkCodes | null = null
        let east: ChunkCodes | null = null
        let north: ChunkCodes | null = null
        let south: ChunkCodes | null = null
        const selfGrid = self.grid
        const pal = self.pal

        for (const i of expIdx) {
          const y = bottom + (i >> 8)
          if (yMin !== undefined && y < yMin) continue
          if (yMax !== undefined && y > yMax) continue
          const b = biomeAt(i)
          // 无群系归属时不臆造群系
          if (!b) continue

          const lx = i & 15
          const lz = (i >> 4) & 15
          const yi = i >> 8

          // 竖向：同块内上下，越界就是空气
          const up = yi + 1 < h ? pal[selfGrid[(yi + 1) * COLUMNS_PER_CHUNK + lz * 16 + lx]] : W_AIR
          const down = yi > 0 ? pal[selfGrid[(yi - 1) * COLUMNS_PER_CHUNK + lz * 16 + lx]] : W_AIR

          // 横向：块内直取，贴边才查邻块
          let xm: number, xp: number, zm: number, zp: number
          if (lx > 0) xm = pal[selfGrid[i - 1]]
          else { west ??= await codesAt(c.x - 1, c.z); xm = west ? codeAt(west, 15, y, lz) : W_UNKNOWN }
          if (lx < 15) xp = pal[selfGrid[i + 1]]
          else { east ??= await codesAt(c.x + 1, c.z); xp = east ? codeAt(east, 0, y, lz) : W_UNKNOWN }
          if (lz > 0) zm = pal[selfGrid[i - 16]]
          else { north ??= await codesAt(c.x, c.z - 1); zm = north ? codeAt(north, lx, y, 15) : W_UNKNOWN }
          if (lz < 15) zp = pal[selfGrid[i + 16]]
          else { south ??= await codesAt(c.x, c.z + 1); zp = south ? codeAt(south, lx, y, 0) : W_UNKNOWN }

          const air = xm === W_AIR || xp === W_AIR || up === W_AIR || down === W_AIR || zm === W_AIR || zp === W_AIR
          const water = xm === W_WATER || xp === W_WATER || up === W_WATER
            || down === W_WATER || zm === W_WATER || zp === W_WATER
          const unknown = xm === W_UNKNOWN || xp === W_UNKNOWN || up === W_UNKNOWN
            || down === W_UNKNOWN || zm === W_UNKNOWN || zp === W_UNKNOWN

          const oreId = g.palette[src[i] - 1].id
          const fam = familyOf.get(oreId)!
          oreBlocks++

          // 群系级
          let byOre = biomeOre.get(b)
          if (!byOre) { byOre = new Map(); biomeOre.set(b, byOre) }
          addOne(getCounts(byOre, oreId), air, water, unknown)

          const sec = secOfLayer[yi]

          // 全维度按家族区段
          let fs = famSection.get(fam)
          if (!fs) { fs = new Map(); famSection.set(fam, fs) }
          let fsc = fs.get(sec)
          if (!fsc) { fsc = emptyCounts(); fs.set(sec, fsc) }
          addOne(fsc, air, water, unknown)

          // 群系级区段
          if (wantSections) {
            let bySec = biomeOreSection.get(b)
            if (!bySec) { bySec = new Map(); biomeOreSection.set(b, bySec) }
            let byOreSec = bySec.get(sec)
            if (!byOreSec) { byOreSec = new Map(); bySec.set(sec, byOreSec) }
            addOne(getCounts(byOreSec, oreId), air, water, unknown)
          }
        }
      },
      finalize() {
        const expIds = [...exposureSet].sort()
        const bulkIds = [...bulkSet].sort()
        const expFams = [...new Set(expIds.map(oreFamily))].sort()
        /** 每区块平均固体方块数：in-situ 口径把「该群系占多少固体」折算成等效区块数用 */
        const solidPerChunk = chunks > 0 ? scannedSolid / chunks : 0

        const oreStat = (c: Counts, eq: number): OreStat => {
          const per = (n: number) => (eq > 0 ? n / eq : 0)
          return {
            count: c.total,
            avgPerChunk: per(c.total),
            airExposed: c.air,
            avgAirExposed: per(c.air),
            waterExposed: c.water,
            avgWaterExposed: per(c.water),
            both: c.both,
            buried: c.buried,
            avgBuried: per(c.buried),
            unknownEdge: c.unknown,
            airPct: c.total > 0 ? c.air / c.total * 100 : 0,
            waterPct: c.total > 0 ? c.water / c.total * 100 : 0,
            reliableExposure: c.total >= minOreSamples,
          }
        }

        // 群系候选按「覆盖度」排序：surface 用列数，in-situ 用固体量
        const cover = new Map<number, number>()
        for (const [b, n] of biomeColumns) cover.set(b, n)
        for (const [b, n] of biomeSolid) if (basis === "in-situ") cover.set(b, n)

        const biomes = [...cover.entries()]
          .sort((a, c) => c[1] - a[1] || ids[a[0]].localeCompare(ids[c[0]]))
          .map(([b, n]) => {
            const chunkCount = biomeChunks.get(b)?.size ?? 0
            const reliable = chunkCount >= minChunks
            // surface：列数 / 256（面积份额）；in-situ：固体量 / 每区块平均固体量（等效满固体区块）
            const chunkEquivalent = basis === "surface"
              ? n / COLUMNS_PER_CHUNK
              : solidPerChunk > 0 ? n / solidPerChunk : 0
            const byOre = biomeOre.get(b)
            const byBulk = biomeBulk.get(b)

            const perf = (c: number) => (chunkEquivalent > 0 ? c / chunkEquivalent : 0)

            // 暴露统计
            const exposure: Record<string, OreStat> = {}
            for (const id of expIds) {
              const c = byOre?.get(id) ?? emptyCounts()
              // 不可靠群系只列非零，免得把「没测到」伪装成 0
              if (!c.total && !reliable) continue
              exposure[id] = oreStat(c, chunkEquivalent)
            }
            // 数量统计（无暴露字段）
            const bulk: Record<string, BulkStat> = {}
            for (const id of bulkIds) {
              const c = byBulk?.get(id) ?? 0
              if (!c && !reliable) continue
              bulk[id] = { count: c, avgPerChunk: perf(c) }
            }
            // 家族汇总：只对暴露类做（数量类就 3 种，直接看精确 id 即可）
            const families: Record<string, OreStat> = {}
            for (const f of expFams) {
              const c = emptyCounts()
              for (const id of expIds) {
                if (familyOf.get(id) !== f) continue
                const s = byOre?.get(id)
                if (!s) continue
                c.total += s.total; c.air += s.air; c.water += s.water
                c.both += s.both; c.buried += s.buried; c.unknown += s.unknown
              }
              if (!c.total && !reliable) continue
              families[f] = oreStat(c, chunkEquivalent)
            }

            // 区段：精确 id（不合并 deepslate_ 前缀 —— 恶地的 gold_ore 与
            // deepslate_gold_ore 是两个完全不同的开采目标）
            let sections: SectionRow[] | undefined
            if (wantSections) {
              const expSec = biomeOreSection.get(b)
              const bulkSec = biomeBulkSection.get(b)
              const secKeys = new Set<number>([
                ...(expSec?.keys() ?? []),
                ...(bulkSec?.keys() ?? []),
              ])
              if (secKeys.size) {
                sections = [...secKeys].sort((a, c) => a - c).map(sec => {
                  const ex: SectionRow["exposure"] = {}
                  const bu: SectionRow["bulk"] = {}
                  let blocks = 0
                  for (const [id, c] of [...(expSec?.get(sec)?.entries() ?? [])].sort((a, c) => c[1].total - a[1].total)) {
                    blocks += c.total
                    const top = byOre?.get(id)?.total ?? 0
                    ex[id] = {
                      count: c.total,
                      avgPerChunk: perf(c.total),
                      share: top > 0 ? c.total / top : 0,
                      airPct: c.total > 0 ? c.air / c.total * 100 : 0,
                    }
                  }
                  for (const [id, c] of [...(bulkSec?.get(sec)?.entries() ?? [])].sort((a, c) => c[1] - a[1])) {
                    blocks += c
                    const top = byBulk?.get(id) ?? 0
                    bu[id] = { count: c, avgPerChunk: perf(c), share: top > 0 ? c / top : 0 }
                  }
                  return { yRange: [sec, sec + 15] as [number, number], blocks, exposure: ex, bulk: bu }
                })
              }
            }

            const out: Record<string, unknown> = {
              id: ids[b],
              chunkEquivalent,
              chunks: chunkCount,
              reliable,
              /** 暴露类的方块数 */
              exposureBlocks: [...(byOre?.values() ?? [])].reduce((a, c) => a + c.total, 0),
              /** 数量类（不做暴露判定）的方块数 */
              bulkBlocks: [...(byBulk?.values() ?? [])].reduce((a, c) => a + c, 0),
              exposure,
              bulk,
              families,
            }
            if (basis === "surface") {
              out.columns = n
              out.areaFraction = totalColumns > 0 ? n / totalColumns : 0
            } else {
              out.solidBlocks = n
              out.volumeFraction = scannedSolid > 0 ? n / scannedSolid : 0
            }
            if (sections) out.sections = sections
            return out
          })

        // 全维度按家族：区段分布（暴露类带暴露率，数量类只给占比）
        const sectionProfiles = wantSections
          ? Object.fromEntries(
              [...famSection.entries()]
                .sort((a, c) => {
                  const sum = (m: Map<number, Counts>) => [...m.values()].reduce((x, y) => x + y.total, 0)
                  return sum(c[1]) - sum(a[1])
                })
                .map(([fam, fs]) => {
                  const total = [...fs.values()].reduce((a, c) => a + c.total, 0)
                  const kind = expFams.includes(fam) ? "exposure" : "bulk"
                  const rows = [...fs.entries()].sort((a, c) => a[0] - c[0]).map(([sec, c]) => ({
                    yRange: [sec, sec + 15],
                    count: c.total,
                    share: total > 0 ? c.total / total : 0,
                    // bulk 类没有暴露计数，这两项恒为 0
                    airExposed: c.air,
                    buried: c.buried,
                    unknownEdge: c.unknown,
                    airPct: c.total > 0 && kind === "exposure" ? c.air / c.total * 100 : null,
                  }))
                  return [fam, { kind, count: total, sections: rows }]
                }),
            )
          : undefined

        return {
          biomeBasis: basis,
          chunks,
          minChunks,
          minOreSamples,
          top: wantTop,
          /** 两类列表各自独立维护：exposure 逐面算暴露，bulk 只数数量 */
          exposureBlockList: expIds,
          bulkBlockList: bulkIds,
          exposureBlocks: oreBlocks,
          bulkBlocks,
          /** in-situ 口径用得到；surface 口径下仍输出，便于对照体积 */
          scannedSolid: basis === "in-situ" ? scannedSolid : undefined,
          totalColumns: basis === "surface" ? totalColumns : undefined,
          blocksWithoutBiome: basis === "in-situ" ? blocksWithoutBiome : undefined,
          reliableBiomes: biomes.filter(b => b.reliable as boolean).length,
          biomes,
          sectionProfiles,
          note: basis === "surface"
            ? "群系取该列地表（最高非空气方块）处的群系，与 biome-histogram 同口径；资源方块按所在列的地表群系归属；chunkEquivalent = 地表列数/256，avgPerChunk 的分母就是它；exposure 是逐面判定暴露的方块（airExposed = 6 面邻居中至少一面是空气，waterExposed 同理判水，两者可重叠 both；unknownEdge 是邻块读不到的，不计入 buried），bulk 只统计数量、不做暴露判定（紫颂植物与黑曜石天生在开阔处，暴露率恒为 100%，算了没信息量）；reliable = chunks >= minChunks（密度可采信），reliableExposure = count >= minOreSamples（暴露率可采信）；不可靠群系只列非零条目，可靠群系列出全部（真 0 写 0）；families 只汇总 exposure 类并合并 deepslate_ 前缀；同一方块不会被同时计入两类（重复时以 exposure 为准）；同群系各区段 avgPerChunk 相加 = 顶层同种 avgPerChunk"
            : "群系取资源方块自身所在位置的群系单元（下界群系按 4³ 单元三维分布，同一列可穿过多个群系）；chunkEquivalent = 该群系非空气方块数 / 每区块平均非空气方块数，即等效满固体区块数，avgPerChunk 的分母就是它（不数空气，避免顶部空气与洞穴稀释密度）；volumeFraction 的分母是全部已扫描区块的非空气方块数；exposure/bulk 的划分与暴露定义同主世界口径；不可靠群系只列非零条目",
        }
      },
    }
  },
  format(result) {
    const r = result as {
      biomeBasis: string
      chunks: number
      minChunks: number
      minOreSamples: number
      top?: number
      reliableBiomes: number
      biomes: {
        id: string
        chunkEquivalent: number
        chunks: number
        reliable: boolean
        columns?: number
        areaFraction?: number
        volumeFraction?: number
        exposure: Record<string, { count: number, avgPerChunk: number }>
        bulk: Record<string, { count: number, avgPerChunk: number }>
        families: Record<string, { count: number, avgPerChunk: number, avgAirExposed: number, airPct: number, reliableExposure: boolean }>
        sections?: SectionRow[]
      }[]
      sectionProfiles?: Record<string, {
        kind: "exposure" | "bulk"
        count: number
        sections: { yRange: [number, number], count: number, share: number, airPct: number | null }[]
      }>
    }
    if (!r.biomes?.length) return ["没有可统计的区块"]
    const top = r.top ?? DEFAULT_TOP
    const basisLabel = r.biomeBasis === "surface" ? "地表群系" : "原地群系单元"
    const lines = [
      `区块 ${r.chunks}，群系 ${r.biomes.length} 个（${basisLabel}；密度可靠 ${r.reliableBiomes} 个 >=${r.minChunks} 区块）`,
    ]

    const render = (b: (typeof r.biomes)[number]) => {
      // 暴露类带暴露率；数量类只给密度（它们天生在开阔处，暴露率恒为 100%）
      const exp = Object.entries(b.families)
        .filter(([, v]) => v.avgPerChunk >= 0.01)
        .sort((a, c) => c[1].avgPerChunk - a[1].avgPerChunk)
        .slice(0, 5)
        .map(([f, v]) => `${f} ${v.avgPerChunk.toFixed(2)} (露 ${v.airPct.toFixed(0)}%${v.reliableExposure ? "" : "*"})`)
      const bulk = Object.entries(b.bulk)
        .filter(([, v]) => v.avgPerChunk >= 0.01)
        .sort((a, c) => c[1].avgPerChunk - a[1].avgPerChunk)
        .slice(0, 3)
        .map(([id, v]) => `${id.replace("minecraft:", "")} ${v.avgPerChunk.toFixed(2)}`)
      const cover = b.columns !== undefined
        ? `${((b.areaFraction ?? 0) * 100).toFixed(1)}% 面积`
        : `${((b.volumeFraction ?? 0) * 100).toFixed(1)}% 体积`
      const flag = b.reliable ? "" : "  [密度样本不足]"
      lines.push(
        `  ${b.id.padEnd(34)} ${cover.padStart(11)}  ${String(b.chunks).padStart(5)} 区块${flag}`,
      )
      const parts = [...exp, ...bulk.map(x => `${x}[量]`)]
      lines.push(`    ${parts.join("  ") || "(无资源)"}`)
    }
    for (const b of r.biomes.slice(0, top)) render(b)

    // 反向视角：每种矿最富集的群系
    const famSet = new Set<string>()
    for (const b of r.biomes) for (const f of Object.keys(b.families)) famSet.add(f)
    const bestLines: string[] = []
    const bestBiomeOf = new Map<string, string>()
    for (const f of [...famSet].sort()) {
      let best: { id: string, avg: number, reliable: boolean } | null = null
      for (const b of r.biomes) {
        const v = b.families[f]
        if (!v || v.count <= 0) continue
        if (!best || v.avgPerChunk > best.avg) best = { id: b.id, avg: v.avgPerChunk, reliable: b.reliable }
      }
      if (!best) continue
      bestBiomeOf.set(f, best.id)
      const tag = best.reliable ? "" : "  [密度样本不足]"
      bestLines.push(`  ${f.padEnd(14)} ${best.id.padEnd(32)} ${best.avg.toFixed(2).padStart(7)}/区块${tag}`)
    }
    if (bestLines.length) {
      lines.push("  — 各矿种最富集的群系 —")
      lines.push(...bestLines)
    }

    // 区段分布：按矿种展示它在最富集群系里的纵向分布。
    // 按矿种（而不是按群系）组织，是因为「恶地金矿」这类问题真正要区分的是
    // gold_ore 与 deepslate_gold_ore —— 恶地表海拔高，两者离地表的距离差几十格。
    const blocks: string[] = []
    for (const [f, biomeId] of bestBiomeOf) {
      const biome = r.biomes.find(b => b.id === biomeId)
      if (!biome?.sections?.length) continue
      const present = [...new Set(biome.sections.flatMap(s => Object.keys(s.exposure)))]
        .filter(id => oreFamily(id) === f)
        .sort()
      if (!present.length) continue

      const w = 16
      const short = (id: string) => id.replace("minecraft:", "").replace(/_ore$/, "").padEnd(w)
      blocks.push(`    ${f} → ${biomeId}（等效 ${biome.chunkEquivalent.toFixed(1)} 区块）`)
      blocks.push(`      ${"区段".padStart(9)}  ${present.map(short).join(" ")}`)
      for (const s of biome.sections) {
        const cells = present.map(id => {
          const o = s.exposure[id]
          if (!o) return "-".padEnd(w)
          return `${o.avgPerChunk.toFixed(2)}(${(o.share * 100).toFixed(0)}%)`.padEnd(w)
        })
        blocks.push(`      ${`${s.yRange[0]}~${s.yRange[1]}`.padStart(9)}  ${cells.join(" ")}`)
      }
    }
    if (blocks.length) {
      lines.push("  — 各矿种在最富集群系里的区段分布（x.xx(pp%) = 每等效区块平均(占该矿种总数)）—")
      lines.push(...blocks)
    }

    // 数量统计类（植物、黑曜石）单独一段，不与暴露类混在一起
    const bulkRows: string[] = []
    for (const b of r.biomes.slice(0, top)) {
      const items = Object.entries(b.bulk)
        .filter(([, v]) => v.count > 0)
        .sort((a, c) => c[1].avgPerChunk - a[1].avgPerChunk)
      if (!items.length) continue
      bulkRows.push(`    ${b.id}（等效 ${b.chunkEquivalent.toFixed(1)} 区块）`)
      for (const [id, v] of items.slice(0, 4)) {
        const secs = (b.sections ?? [])
          .filter(s => s.bulk[id])
          .map(s => `${s.yRange[0]}:${(s.bulk[id].share * 100).toFixed(0)}%`)
        bulkRows.push(`      ${id.replace("minecraft:", "").padEnd(22)} ${String(v.count).padStart(7)} 个  ${v.avgPerChunk.toFixed(2)}/eq  ${secs.join(" ")}`)
      }
    }
    if (bulkRows.length) {
      lines.push("  — 只统计数量、不做暴露判定的资源（区段 = 该方块在各层的占比）—")
      lines.push(...bulkRows)
    }

    // 全维度按矿种的纵向分布（含暴露率）：看某种资源聚在哪一层、那一层露不露。
    // 只列数量最多的几个：加入末地资源后家族数有 10 个，全展开会刷屏。
    const prof = r.sectionProfiles
    if (prof && Object.keys(prof).length) {
      const ranked = Object.entries(prof).sort((a, c) => c[1].count - a[1].count).slice(0, 6)
      lines.push("  — 各矿种的区段分布（share = 占该种总数，露 = 该段暴露率）—")
      for (const [fam, p] of ranked) {
        const peak = Math.max(...p.sections.map(s => s.share), 0)
        lines.push(`    ${fam}（${p.count} 个方块）`)
        for (const s of p.sections) {
          const bar = "█".repeat(Math.max(0, Math.round((s.share / (peak || 1)) * 20)))
          lines.push(
            `      ${`${s.yRange[0]}~${s.yRange[1]}`.padStart(9)}  ${String(s.count).padStart(6)}  `
            + `${(s.share * 100).toFixed(1).padStart(5)}%  ${bar.padEnd(20)}  `
            + `${p.kind === "exposure" ? `露 ${(s.airPct ?? 0).toFixed(1)}%` : "（数量类）"}`,
          )
        }
      }
      if (Object.keys(prof).length > ranked.length) {
        lines.push(`    （另有 ${Object.keys(prof).length - ranked.length} 种数量更少的资源未列出）`)
      }
    }
    return lines
  },
}

export default analyzer
