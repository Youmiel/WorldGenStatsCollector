import type { World, ChunkRef } from "minecraft-block-reader"
import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"
import {
  decodeHeightmap, dimHeightOf, isGroundDecoration, loadDimensionHeights, pickHeightmaps,
} from "../terrain.js"
import type { Heightmaps } from "../terrain.js"
import { readRegionChunkNbt } from "../chunk-nbt.js"

/**
 * 洞穴空气暴露：指定方块有多少比例紧贴**洞穴空气**，而不是天空空气或水。
 *
 * 与 ore-stats 的 `airPct` 的区别：那边把 air / cave_air / void_air 一律算「空气」，
 * 分不出「地表走过去就能捡」与「要挖矿道下去才碰得到」。本分析器把空气拆成三类：
 * - 天空空气：该列地形高度之上的空气（含虚空）。
 * - 洞穴空气：两种来源合并。
 *   1. 方块 id 是 `minecraft:cave_air`（雕刻器生成的洞穴明确用这个 id）。
 *   2. 普通空气，但低于该列地形高度（噪声洞穴、峡谷、矿井等用普通 air）。
 * - 水：water / bubble_column，单独计数，不算空气。
 *
 * 「该列地形高度」= 最高的非空气、且不是地表装饰/植被（树叶、原木、竹子、甘蔗、
 * 草、海带等）的方块。跳过装饰是必须的：不跳的话树冠和竹竿会把自己那一列抬高，
 * 紧贴它们的空气就会被误判成地下空气。
 *
 * 该高度的求法：优先读区块 NBT 的 `Heightmaps`（`MOTION_BLOCKING_NO_LEAVES`，退到
 * `MOTION_BLOCKING` / `WORLD_SURFACE`）拿到每列起点，再向下跳过残留的原木/竹子等装饰方块；
 * 高度图缺失时才退回全列扫描。高度图已经把「这列最上面有什么」算好了，
 * 全列扫描（主世界每区块 9.8 万次索引）纯属重复劳动。
 * 维度最低 y（高度图解码基准）取自数据包 `dimension_type`，读不到时用内置兜底表。
 *
 * 局限：低于地形高度但水平连通到天空的峡谷、坑洞也会记成洞穴空气——这是「地下空气」
 * 的口径，不是严格的「与天空不连通」。下游按它区分采集模型时，这类少量误判可忽略；
 * 需要精确判连通性得做全维度泛洪，成本不成比例。
 *
 * 暴露判定：6 面邻居。跨区块的邻居会读相邻区块；读不到记 unknownEdge，
 * 不计入 buried，也不当成露出（与 ore-stats 同口径）。
 *
 * params:
 *   blocks?: string[]     统计对象，支持 `minecraft:*_log` 这类通配；默认见 DEFAULT_BLOCKS
 *   yMin?, yMax?: number  只统计该高度范围内的方块
 *   minSamples?: number   暴露率可靠度阈值（默认 200 个方块）
 */

const KEY = "cave-exposure"

/** 默认统计对象：下游按「能不能走过去捡」判定采集模型的地表/浅层方块 */
export const DEFAULT_BLOCKS = [
  // 植被
  "minecraft:bamboo", "minecraft:sugar_cane", "minecraft:short_grass",
  "minecraft:sweet_berry_bush", "minecraft:cactus", "minecraft:kelp",
  "minecraft:seagrass", "minecraft:sea_pickle",
  // 地表沉积
  "minecraft:clay", "minecraft:sand", "minecraft:gravel", "minecraft:dirt",
  "minecraft:snow_block", "minecraft:powder_snow", "minecraft:pointed_dripstone",
  // 树木
  "minecraft:*_log", "minecraft:*_leaves", "minecraft:*_sapling",
  // 特殊
  "minecraft:obsidian", "minecraft:crying_obsidian", "minecraft:glowstone",
  "minecraft:shroomlight", "minecraft:magma_block",
]

const DEFAULT_MIN_SAMPLES = 200
const COLUMNS_PER_CHUNK = 256
const NO_TOP = -32768

const CAVE_AIR = "minecraft:cave_air"
const AIR = new Set(["minecraft:air", "minecraft:void_air"])
const WATER = new Set(["minecraft:water", "minecraft:bubble_column"])
const isAirId = (id: string) => AIR.has(id) || id === CAVE_AIR

/** 调色板编码：空气要区分 id，普通空气的「天空/洞穴」由高度决定 */
const C_AIR = 1
const C_CAVE_AIR = 2
const C_WATER = 3
const C_SOLID = 4

/** 邻居分类码；0 保留给「邻区块读不到」 */
const N_UNKNOWN = 0
const N_SKY = 1
const N_CAVE = 2
const N_WATER = 3
const N_SOLID = 4

interface ChunkCodes {
  grid: Uint16Array
  /** 调色板索引 → 分类码（1-based；0 位是普通空气） */
  pal: Uint8Array
  /** 256 列的地形高度（跳过地表装饰）；NO_TOP = 整列没有地形 */
  top: Int16Array
  bottom: number
  h: number
  /** 地形顶是否取自高度图（false = 退回全列扫描） */
  fromHeightmap: boolean
  /** 本区块里需要统计的格子下标 */
  targetIdx?: number[]
}

interface Counts {
  total: number
  /** 至少一面紧贴洞穴空气 */
  cave: number
  /** 至少一面紧贴天空空气 */
  sky: number
  /** 同时紧贴洞穴空气与天空空气 */
  bothAir: number
  /** 至少一面紧贴水 */
  water: number
  /** 6 面都读到了，但没有空气也没有水 */
  buried: number
  /** 没有空气/水，但至少一面读不到（贴 region 边界） */
  unknown: number
}

const emptyCounts = (): Counts => ({ total: 0, cave: 0, sky: 0, bothAir: 0, water: 0, buried: 0, unknown: 0 })

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const globOf = (pattern: string) =>
  new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`)

/** 从高度图起点向下跳过装饰方块的深度上限（超高树冠兜底） */
const MAX_DESCENT = 96

/**
 * 逐列地形顶。
 *
 * 有高度图时：以 `MOTION_BLOCKING_NO_LEAVES` 作起点（它已排除树叶，且把水算作方块），
 * 向下跳过原木/竹子/甘蔗等装饰方块找真正的地形方块 —— 通常降 0~5 格，
 * 远低于全列扫描。下降超过 MAX_DESCENT 时退回高度图原值（宁可把树冠当地形，
 * 也不要把整棵树内的空气都判成洞穴空气）。
 * 没有高度图时：退回从高往低全列扫描（旧口径，逐字节等价）。
 */
function computeTop(
  g: { palette: { id: string }[], grid: Uint16Array },
  bottom: number,
  h: number,
  hm: Heightmaps | null,
  minY: number,
): { top: Int16Array, fromHeightmap: boolean } {
  const top = new Int16Array(COLUMNS_PER_CHUNK).fill(NO_TOP)
  const maxY = bottom + h - 1
  const raw = hm
    ? decodeHeightmap(hm.motionBlockingNoLeaves) ?? decodeHeightmap(hm.motionBlocking) ?? decodeHeightmap(hm.worldSurface)
    : null

  if (raw) {
    for (let col = 0; col < COLUMNS_PER_CHUNK; col++) {
      const start = raw[col] - 1 + minY
      // 高度图的 0 = 该列没有方块；低于区块底部 / 高于顶部都要钳制
      if (start < bottom) continue
      const from = Math.min(start, maxY)
      let y = from
      let steps = 0
      let found = false
      while (y >= bottom) {
        const v = g.grid[(y - bottom) * COLUMNS_PER_CHUNK + col]
        if (v !== 0) {
          const id = g.palette[v - 1]?.id
          if (id && !isAirId(id) && !isGroundDecoration(id)) { top[col] = y; found = true; break }
        }
        if (++steps > MAX_DESCENT) break
        y--
      }
      if (!found && steps > MAX_DESCENT) top[col] = from
    }
    return { top, fromHeightmap: true }
  }

  let remaining = COLUMNS_PER_CHUNK
  for (let yi = h - 1; yi >= 0 && remaining > 0; yi--) {
    const base = yi * COLUMNS_PER_CHUNK
    for (let col = 0; col < COLUMNS_PER_CHUNK; col++) {
      if (top[col] !== NO_TOP) continue
      const v = g.grid[base + col]
      if (v === 0) continue
      const id = g.palette[v - 1]?.id
      if (!id || isAirId(id) || isGroundDecoration(id)) continue
      top[col] = bottom + yi
      remaining--
    }
  }
  return { top, fromHeightmap: false }
}

const analyzer: AnalyzerModule = {
  name: KEY,
  description: "指定方块的洞穴空气暴露率：区分洞穴空气、天空空气与水（6 面邻居判定）",
  units: { density: "per_chunk", share: "percent" },
  // 最慢的分析器：3.8 亿个目标方块各查 6 邻，作为代价基准 10
  parallelCost: 10,
  create(params): Analyzer {
    const p = (params[KEY] ?? {}) as Record<string, unknown>
    const patterns = ((p.blocks as string[] | undefined) ?? DEFAULT_BLOCKS)
      .map(b => (b.includes(":") ? b : `minecraft:${b}`))
    const matchers = patterns.map(globOf)
    const matches = (id: string) => matchers.some(re => re.test(id))

    const yMin = p.yMin as number | undefined
    const yMax = p.yMax as number | undefined
    const minSamples = Math.max(1, Math.trunc(Number(p.minSamples) || DEFAULT_MIN_SAMPLES))

    const counts = new Map<string, Counts>()
    const getCounts = (id: string): Counts => {
      let c = counts.get(id)
      if (!c) { c = emptyCounts(); counts.set(id, c) }
      return c
    }

    let chunks = 0
    let targetBlocks = 0
    /** 地形顶取自高度图的区块数 / 退回全列扫描的区块数（审计口径用） */
    let heightmapChunks = 0
    let scannedChunks = 0

    // region 内跨区块邻居查询
    let world: World | null = null
    let refs = new Map<string, ChunkRef>()
    /** 当前 region 的原始字节：读邻区块的 Heightmaps 用（同 region 才读得到） */
    let regionBytes: Uint8Array | null = null
    /** 当前维度的最低 y（高度图解码基准） */
    let dimMinY = 0
    const cache = new Map<string, ChunkCodes | null>()
    const chunkKey = (cx: number, cz: number) => `${cx},${cz}`

    const packGrid = (
      g: { palette: { id: string }[], grid: Uint16Array },
      bottom: number,
      h: number,
      hm: Heightmaps | null,
      match?: (id: string) => boolean,
    ): ChunkCodes | null => {
      if (!g || g.grid.length !== h * COLUMNS_PER_CHUNK) return null
      const pal = new Uint8Array(g.palette.length + 1)
      pal[0] = C_AIR
      const isTarget = new Uint8Array(g.palette.length + 1)
      let anyTarget = false
      for (let i = 0; i < g.palette.length; i++) {
        const id = g.palette[i].id
        pal[i + 1] = id === CAVE_AIR ? C_CAVE_AIR : AIR.has(id) ? C_AIR : WATER.has(id) ? C_WATER : C_SOLID
        if (match?.(id)) { isTarget[i + 1] = 1; anyTarget = true }
      }

      // 逐列地形高度：水面算地形（水下空气是洞穴空气）
      const { top, fromHeightmap } = computeTop(g, bottom, h, hm, dimMinY)

      let targetIdx: number[] | undefined
      if (anyTarget) {
        targetIdx = []
        const src = g.grid
        for (let i = 0; i < src.length; i++) {
          const v = src[i]
          if (v !== 0 && isTarget[v]) targetIdx.push(i)
        }
      }
      return { grid: g.grid, pal, top, bottom, h, fromHeightmap, targetIdx }
    }

    /** 某个格子（调色板索引）的邻居分类；普通空气按所在列地形高度拆天空/洞穴 */
    const resolve = (cs: ChunkCodes, idx: number, y: number, col: number): number => {
      const code = cs.pal[cs.grid[idx]]
      if (code === C_AIR) {
        const t = cs.top[col]
        return t === NO_TOP || y > t ? N_SKY : N_CAVE
      }
      return code === C_CAVE_AIR ? N_CAVE : code === C_WATER ? N_WATER : N_SOLID
    }

    /** 邻区块查询；竖向越界：高于区块顶部算天空，低于底部算洞穴 */
    const codeAt = (cs: ChunkCodes, lx: number, y: number, lz: number): number => {
      const yi = y - cs.bottom
      if (yi >= cs.h) return N_SKY
      if (yi < 0) return N_CAVE
      const col = lz * 16 + lx
      return resolve(cs, yi * COLUMNS_PER_CHUNK + col, y, col)
    }

    const codesAt = async (cx: number, cz: number): Promise<ChunkCodes | null> => {
      const k = chunkKey(cx, cz)
      const hit = cache.get(k)
      if (hit !== undefined) return hit
      const ref = refs.get(k)
      if (!ref || !world) { cache.set(k, null); return null }
      const ext = await world.chunkExtent(ref)
      const h = ext ? ext.top - ext.bottom + 1 : 0
      // 邻区块的地形顶同样用高度图；跨 region 的邻块不在 refs 里，压根走不到这条
      const hm = regionBytes
        ? pickHeightmaps(await readRegionChunkNbt(regionBytes, ref, ["Heightmaps"]))
        : null
      const entry = ext && h > 0
        ? packGrid(await world.chunkGrid(ref, { yMin: ext.bottom, yMax: ext.top }), ext.bottom, h, hm)
        : null
      cache.set(k, entry)
      if (cache.size > 128) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined && oldest !== k) cache.delete(oldest)
      }
      return entry
    }

    return {
      name: KEY,
      async onRegion(session, ctx) {
        world = session.world
        refs = new Map(session.chunks.map(c => [chunkKey(c.cx, c.cz), c]))
        regionBytes = session.bytes
        cache.clear()
        // 高度图是相对维度 minY 编码的；读不到数据包时 terrain 里带兜底表
        const heights = await loadDimensionHeights(ctx.runtime.serverJar)
        dimMinY = dimHeightOf(heights, session.dimension).minY
      },
      async onChunk(c: ChunkHandle) {
        const ext = await c.extent()
        if (!ext) return
        const h = ext.top - ext.bottom + 1
        if (h <= 0) return
        const g = await c.grid({ yMin: ext.bottom, yMax: ext.top })
        const hm = pickHeightmaps(await c.rawNbt(["Heightmaps"]))
        const self = packGrid(g, ext.bottom, h, hm, matches)
        if (!self) return
        chunks++
        if (self.fromHeightmap) heightmapChunks++
        else scannedChunks++
        cache.set(chunkKey(c.x, c.z), self)

        const expIdx = self.targetIdx
        if (!expIdx?.length) return

        const bottom = self.bottom
        const selfGrid = self.grid
        const palette = g.palette

        // 4 个侧邻只在方块贴到该侧边时才解析
        let west: ChunkCodes | null = null
        let east: ChunkCodes | null = null
        let north: ChunkCodes | null = null
        let south: ChunkCodes | null = null

        for (const i of expIdx) {
          const y = bottom + (i >> 8)
          if (yMin !== undefined && y < yMin) continue
          if (yMax !== undefined && y > yMax) continue

          const lx = i & 15
          const lz = (i >> 4) & 15
          const yi = i >> 8
          const col = i & 255

          const up = yi + 1 < h ? resolve(self, (yi + 1) * COLUMNS_PER_CHUNK + col, y + 1, col) : N_SKY
          const down = yi > 0 ? resolve(self, (yi - 1) * COLUMNS_PER_CHUNK + col, y - 1, col) : N_CAVE

          let xm: number, xp: number, zm: number, zp: number
          if (lx > 0) xm = resolve(self, i - 1, y, col - 1)
          else { west ??= await codesAt(c.x - 1, c.z); xm = west ? codeAt(west, 15, y, lz) : N_UNKNOWN }
          if (lx < 15) xp = resolve(self, i + 1, y, col + 1)
          else { east ??= await codesAt(c.x + 1, c.z); xp = east ? codeAt(east, 0, y, lz) : N_UNKNOWN }
          if (lz > 0) zm = resolve(self, i - 16, y, col - 16)
          else { north ??= await codesAt(c.x, c.z - 1); zm = north ? codeAt(north, lx, y, 15) : N_UNKNOWN }
          if (lz < 15) zp = resolve(self, i + 16, y, col + 16)
          else { south ??= await codesAt(c.x, c.z + 1); zp = south ? codeAt(south, lx, y, 0) : N_UNKNOWN }

          const cave = xm === N_CAVE || xp === N_CAVE || up === N_CAVE || down === N_CAVE || zm === N_CAVE || zp === N_CAVE
          const sky = xm === N_SKY || xp === N_SKY || up === N_SKY || down === N_SKY || zm === N_SKY || zp === N_SKY
          const water = xm === N_WATER || xp === N_WATER || up === N_WATER
            || down === N_WATER || zm === N_WATER || zp === N_WATER
          const unknown = xm === N_UNKNOWN || xp === N_UNKNOWN || zm === N_UNKNOWN || zp === N_UNKNOWN

          const id = palette[selfGrid[i] - 1].id
          const t = getCounts(id)
          t.total++
          targetBlocks++
          if (cave) t.cave++
          if (sky) t.sky++
          if (cave && sky) t.bothAir++
          if (water) t.water++
          if (!cave && !sky && !water) {
            if (unknown) t.unknown++
            else t.buried++
          }
        }
      },
      finalize() {
        const pct = (n: number, denom: number): number | null => (denom > 0 ? n / denom * 100 : null)
        const per = (n: number): number => (chunks > 0 ? n / chunks : 0)

        const blocks = [...counts.entries()]
          .sort((a, c) => c[1].total - a[1].total || a[0].localeCompare(c[0]))
          .map(([id, c]) => {
            const air = c.cave + c.sky - c.bothAir
            return {
              id,
              count: c.total,
              avgPerChunk: per(c.total),
              /** 至少一面紧贴洞穴空气 */
              caveAirExposed: c.cave,
              caveAirPct: pct(c.cave, c.total),
              /** 至少一面紧贴天空空气（含虚空） */
              skyAirExposed: c.sky,
              skyAirPct: pct(c.sky, c.total),
              /** 同时紧贴洞穴空气与天空空气 */
              bothAir: c.bothAir,
              bothAirPct: pct(c.bothAir, c.total),
              /** 至少一面紧贴任意空气 */
              airExposed: air,
              airPct: pct(air, c.total),
              /** airExposed 里洞穴空气的占比：直接回答「露头是不是在洞里」 */
              caveShareOfAirPct: pct(c.cave, air),
              waterExposed: c.water,
              waterPct: pct(c.water, c.total),
              buried: c.buried,
              buriedPct: pct(c.buried, c.total),
              unknownEdge: c.unknown,
              unknownPct: pct(c.unknown, c.total),
              /** 暴露率统计到的方块数是否够：按方块数判定，与区块覆盖度无关 */
              reliable: c.total >= minSamples,
            }
          })

        return {
          chunks,
          minSamples,
          blockPatterns: patterns,
          targetBlocks,
          /** 地形顶来自高度图的区块数 */
          heightmapChunks,
          /** 高度图缺失、退回全列扫描的区块数（0 表示全部用上了高度图） */
          scannedChunks,
          blocks,
          note: "6 面邻居判定；地形顶优先取区块 Heightmaps（MOTION_BLOCKING_NO_LEAVES，退到 MOTION_BLOCKING / WORLD_SURFACE）并向下跳过原木/竹子等装饰方块，高度图缺失的区块退回全列扫描（见 heightmapChunks / scannedChunks）；洞穴空气 = 邻居是 minecraft:cave_air，或邻居是普通空气但其高度低于该列地形高度（最高非空气且非地表装饰的方块）；天空空气 = 地形高度之上的普通空气与虚空；水 = water/bubble_column，单独计数；caveAirPct 等百分比的分母是 count，caveShareOfAirPct 的分母是 airExposed（至少一面贴空气的方块数）；unknownEdge = 没有空气/水、但有邻块读不到（贴 region 边界）的方块，不计入 buried；reliable = count >= minSamples；只列出实际出现的方块，某个通配模式在该维度没匹配到就不成行。局限：低于地形高度但水平连通天空的峡谷/坑洞也会记成洞穴空气。",
        }
      },
    }
  },
  format(result) {
    const r = result as {
      chunks: number
      targetBlocks: number
      minSamples: number
      heightmapChunks: number
      scannedChunks: number
      blocks: {
        id: string
        count: number
        avgPerChunk: number
        caveAirPct: number | null
        skyAirPct: number | null
        caveShareOfAirPct: number | null
        buriedPct: number | null
        unknownPct: number | null
        reliable: boolean
      }[]
    }
    if (!r.blocks?.length) return [`区块 ${r.chunks}，没有统计到目标方块`]
    const lines = [
      `区块 ${r.chunks}，目标方块 ${r.targetBlocks} 个，命中 ${r.blocks.length} 种（暴露率可靠阈值 ${r.minSamples} 个）`,
      `  地形顶来源：高度图 ${r.heightmapChunks} 区块 / 全列扫描 ${r.scannedChunks} 区块`,
    ]
    for (const b of r.blocks.slice(0, 15)) {
      const f = (v: number | null) => (v === null ? "  -" : `${v.toFixed(0)}%`)
      lines.push(
        `  ${b.id.replace("minecraft:", "").padEnd(28)} ${String(b.count).padStart(8)} 个`
        + `  洞 ${f(b.caveAirPct).padStart(4)}  天 ${f(b.skyAirPct).padStart(4)}`
        + `  洞占空气 ${f(b.caveShareOfAirPct).padStart(4)}  埋 ${f(b.buriedPct).padStart(4)}`
        + `  未知 ${f(b.unknownPct).padStart(4)}${b.reliable ? "" : "  [样本不足]"}`,
      )
    }
    return lines
  },
}

export default analyzer
