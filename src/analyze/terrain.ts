import type { ChunkGrid } from "minecraft-block-reader"
import { readJarJson } from "../lib/jar.js"

/**
 * 逐列地形：地面高度 + 水域/陆地判定，供「按地形筛选」的统计器复用。
 *
 * 数据源用区块 NBT 的 Heightmaps（reader 的 world.chunk() 会丢掉这个根键，走 rawNbt）：
 * - MOTION_BLOCKING_NO_LEAVES：最高的「阻挡移动」方块，已排除树叶 —— 但木材/原木仍然算数。
 * - OCEAN_FLOOR：最高的固体方块（忽略流体）。
 * - MOTION_BLOCKING：同上但含树叶，用来判水域。
 *
 * 编码：9 bit/条、256 条，**不跨 long**（每条 long 只放 floor(64/9)=7 条，剩余位不用），
 * 37 条 long = 74 个 uint32。世界坐标 y = raw - 1 + minY，minY 来自数据包 dimension_type
 * （主世界 -64，下界/末地 0）。实测 WORLD_SURFACE 与方块顶层 12800/12800 列完全一致。
 *
 * 判定：
 * - 水域 = MOTION_BLOCKING > OCEAN_FLOOR，即海底之上还有流体（标准 MC 口径）。
 * - groundY（陆地）= NO_LEAVES 高度往下跳过原木/木材，直到非木方块 ——
 *   树干的木材会挡移动，不剔除就会把坡度算错。
 * - groundY（水域）= OCEAN_FLOOR，即海底。
 * - 没有 Heightmaps 时退化为扫 grid（口径略粗，仅兜底）。
 */

export const NO_Y = -32768

export interface ChunkTerrain {
  /** 256 列，地面 y（水域取海底） */
  groundY: Int16Array
  /** 256 列，1 = 水域列 */
  water: Uint8Array
}

const AIR = /(^|:)(air|cave_air|void_air)$/
const FLUID = /(^|:)(water|lava|bubble_column)$/
const LEAVES = /(_leaves)$/
const LOG = /(_log|_wood|_stem|_hyphae)$/
const ICE = /(^|:)(ice|frosted_ice|blue_ice|packed_ice)$/
const SOFT_SUFFIX = /(_sapling|_flower|_coral|_coral_block|_coral_fan|_kelp|_seagrass|_grass|_fern|_bush|_vine|_vines|_mushroom|_roots|_sprouts|_wart_block|_carpet|_sign|_banner|_button|_pressure_plate|_rail|_torch|_lantern|_pane|_trapdoor|_door|_fence|_fence_gate|_bud|_buds|_pickle|_anemone|_candle|_web|_snow|_litter|_petals|_crop)$/
const SOFT_NAMES = new Set([
  "minecraft:grass", "minecraft:short_grass", "minecraft:tall_grass", "minecraft:fern", "minecraft:large_fern",
  "minecraft:dead_bush", "minecraft:kelp", "minecraft:kelp_plant", "minecraft:seagrass", "minecraft:tall_seagrass",
  "minecraft:vine", "minecraft:glow_lichen", "minecraft:snow", "minecraft:light", "minecraft:barrier",
  "minecraft:structure_void", "minecraft:lily_pad", "minecraft:hanging_roots", "minecraft:spore_blossom",
  "minecraft:leaf_litter", "minecraft:wildflowers", "minecraft:pink_petals", "minecraft:bush",
])

const isSoft = (id: string) => SOFT_NAMES.has(id) || SOFT_SUFFIX.test(id)
/** 水/冰：海洋、河流、湖泊、冰面都算水域 */
export const isWaterLike = (id: string) => id === "minecraft:water" || ICE.test(id)

/* ------------------------------------------------------------------ */
/* Heightmaps                                                          */
/* ------------------------------------------------------------------ */

const HM_BITS = 9
const HM_MASK = (1 << HM_BITS) - 1
/** 每条 long 放几条：不跨 long 打包（与 MC 的 BitStorage 一致） */
const HM_PER_LONG = Math.floor(64 / HM_BITS)

export interface Heightmaps {
  worldSurface?: Uint32Array
  oceanFloor?: Uint32Array
  motionBlocking?: Uint32Array
  motionBlockingNoLeaves?: Uint32Array
}

/** long array（readNBT 给的 [lo, hi] uint32 对）→ 256 条原始值 */
export function decodeHeightmap(arr: Uint32Array | undefined): Int32Array | null {
  if (!arr || arr.length < 2) return null
  const out = new Int32Array(256)
  const longs = arr.length >> 1
  for (let li = 0; li < longs; li++) {
    const lo = arr[li * 2], hi = arr[li * 2 + 1]
    for (let j = 0; j < HM_PER_LONG; j++) {
      const idx = li * HM_PER_LONG + j
      if (idx >= 256) return out
      const off = j * HM_BITS
      let v: number
      if (off + HM_BITS <= 32) v = (lo >>> off) & HM_MASK
      else if (off >= 32) v = (hi >>> (off - 32)) & HM_MASK
      else v = ((lo >>> off) | (hi << (32 - off))) & HM_MASK
      out[idx] = v
    }
  }
  return out
}

/** 从 rawNbt(["Heightmaps"]) 的结果里取四张表 */
export function pickHeightmaps(nbt: Record<string, unknown> | null): Heightmaps | null {
  const hm = nbt?.Heightmaps as Record<string, unknown> | undefined
  if (!hm) return null
  const asArr = (v: unknown) => (v instanceof Uint32Array ? v : undefined)
  return {
    worldSurface: asArr(hm.WORLD_SURFACE),
    oceanFloor: asArr(hm.OCEAN_FLOOR),
    motionBlocking: asArr(hm.MOTION_BLOCKING),
    motionBlockingNoLeaves: asArr(hm.MOTION_BLOCKING_NO_LEAVES),
  }
}

/* ------------------------------------------------------------------ */
/* 维度高度（minY）                                                    */
/* ------------------------------------------------------------------ */

export interface DimensionHeight { minY: number, height: number }

const DIM_FALLBACK: Record<string, DimensionHeight> = {
  overworld: { minY: -64, height: 384 },
  the_nether: { minY: 0, height: 256 },
  the_end: { minY: 0, height: 256 },
}

const dimCache = new Map<string, Promise<Record<string, DimensionHeight>>>()

/**
 * 从原版服务端 jar 的 data/minecraft/dimension_type/*.json 读 min_y / height。
 * Heightmaps 是相对 minY 编码的，拿不到 minY 就无法解码，所以这里带兜底表。
 */
export function loadDimensionHeights(jarPath: string | null | undefined): Promise<Record<string, DimensionHeight>> {
  const key = jarPath ?? ""
  const hit = dimCache.get(key)
  if (hit) return hit
  const task = (async () => {
    const out: Record<string, DimensionHeight> = { ...DIM_FALLBACK }
    if (!jarPath) return out
    try {
      const files = await readJarJson("data/minecraft/dimension_type/", jarPath)
      for (const f of files) {
        const name = f.path.replace(/^data\/minecraft\/dimension_type\//, "").replace(/\.json$/, "")
        const json = f.json as { min_y?: unknown, height?: unknown }
        const minY = Number(json.min_y)
        const height = Number(json.height)
        if (Number.isFinite(minY) && Number.isFinite(height)) out[name] = { minY, height }
      }
    } catch {
      /* 读不到就用兜底表 */
    }
    return out
  })()
  dimCache.set(key, task)
  return task
}

/** 按维度名取 minY，认不出时按主世界处理 */
export function dimHeightOf(table: Record<string, DimensionHeight>, dimension: string): DimensionHeight {
  return table[dimension] ?? table[dimension.replace(/^minecraft:/, "")] ?? DIM_FALLBACK.overworld
}

/* ------------------------------------------------------------------ */
/* 逐列地形                                                            */
/* ------------------------------------------------------------------ */

const MAX_LOG_DESCENT = 64

/** 从 startY 往下跳过原木/树叶/空气，返回第一个真正的地面 y */
function descendPastLogs(grid: ChunkGrid, startY: number, col: number, gridMinY: number): number {
  const h = grid.grid.length >> 8
  for (let i = 0, y = startY; i < MAX_LOG_DESCENT && y >= gridMinY; i++, y--) {
    const yi = y - gridMinY
    if (yi < 0 || yi >= h) break
    const v = grid.grid[yi * 256 + col]
    if (!v) continue
    const id = grid.palette[v - 1]?.id
    if (!id) continue
    if (LOG.test(id) || LEAVES.test(id)) continue
    return y
  }
  return startY
}

/**
 * 提取一个区块的 256 列地形。
 *
 * minY 是维度最低 y（Heightmaps 的编码基准），gridMinY 是这份 grid 索引 0 对应的 y
 * （即 chunkExtent().bottom）。两者通常相同，但区块底部全空时 ext.bottom 会更高，必须分开传。
 * heightmaps 缺失时退化为扫 grid（水面按水/冰识别，地面跳过原木与软方块）。
 */
export function readChunkTerrain(
  grid: ChunkGrid,
  heightmaps: Heightmaps | null,
  minY: number,
  gridMinY: number = minY,
): ChunkTerrain {
  const groundY = new Int16Array(256).fill(NO_Y)
  const water = new Uint8Array(256)
  const h = grid.grid.length >> 8

  const nl = decodeHeightmap(heightmaps?.motionBlockingNoLeaves)
  const of = decodeHeightmap(heightmaps?.oceanFloor)
  const mb = decodeHeightmap(heightmaps?.motionBlocking)

  if (nl && of && mb) {
    for (let col = 0; col < 256; col++) {
      const oceanFloor = of[col] - 1 + minY
      const isWater = mb[col] > of[col]
      if (isWater) {
        water[col] = 1
        groundY[col] = oceanFloor
        continue
      }
      const surface = nl[col] - 1 + minY
      groundY[col] = descendPastLogs(grid, surface, col, gridMinY)
    }
    return { groundY, water }
  }

  // 兜底：扫 grid
  for (let col = 0; col < 256; col++) {
    let sawWater = false
    for (let yi = h - 1; yi >= 0; yi--) {
      const v = grid.grid[yi * 256 + col]
      if (!v) continue
      const id = grid.palette[v - 1]?.id
      if (!id) continue
      const y = gridMinY + yi
      if (isWaterLike(id)) { sawWater = true; continue }
      if (FLUID.test(id)) continue
      if (AIR.test(id) || LEAVES.test(id) || LOG.test(id) || isSoft(id)) continue
      groundY[col] = y
      if (sawWater) water[col] = 1
      break
    }
  }
  return { groundY, water }
}

/* ------------------------------------------------------------------ */
/* 跨区块索引                                                          */
/* ------------------------------------------------------------------ */

/** x,z 打包成 32 位整数（各取低 16 位），用于 Map key */
export const packXZ = (x: number, z: number) => ((x & 0xffff) << 16) | (z & 0xffff)
export const unpackX = (p: number) => ((p >>> 16) << 16) >> 16
export const unpackZ = (p: number) => (p << 16) >> 16

export interface ColumnTerrain {
  groundY: number
  water: boolean
}

/**
 * 已收录区块的地形索引。
 * 地形必须在全部区块读完之后才能跨区块算坡度，因为 3x3 邻域会越过区块边界。
 */
export class TerrainIndex {
  private chunks = new Map<number, ChunkTerrain>()
  private slopeCache = new Map<number, number | null>()

  add(cx: number, cz: number, t: ChunkTerrain): void {
    this.chunks.set(packXZ(cx, cz), t)
  }

  get chunkCount(): number {
    return this.chunks.size
  }

  /** 已收录区块的世界包围盒（方块）；没有任何区块时返回 null */
  worldBounds(): { minX: number, maxX: number, minZ: number, maxZ: number } | null {
    if (!this.chunks.size) return null
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const key of this.chunks.keys()) {
      const cx = unpackX(key), cz = unpackZ(key)
      if (cx < minX) minX = cx
      if (cx > maxX) maxX = cx
      if (cz < minZ) minZ = cz
      if (cz > maxZ) maxZ = cz
    }
    return { minX: minX * 16, maxX: maxX * 16 + 15, minZ: minZ * 16, maxZ: maxZ * 16 + 15 }
  }

  /** 遍历全部已收录区块（可视化用） */
  eachChunk(fn: (cx: number, cz: number, t: ChunkTerrain) => void): void {
    for (const [key, t] of this.chunks) fn(unpackX(key), unpackZ(key), t)
  }

  column(wx: number, wz: number): ColumnTerrain | null {
    const t = this.chunks.get(packXZ(wx >> 4, wz >> 4))
    if (!t) return null
    const i = (wz & 15) * 16 + (wx & 15)
    return { groundY: t.groundY[i], water: t.water[i] === 1 }
  }

  /**
   * 3x3 邻域地面高差（方块）。水域列不参与（海底与陆地混算没有意义）。
   * 有效样本 < 5 个时返回 null，表示无法判定，调用方不要把它当陡坡。
   * 结果按列缓存 —— 两地之间的连线上会反复查询同一批列。
   */
  slope(wx: number, wz: number): number | null {
    const key = packXZ(wx, wz)
    const hit = this.slopeCache.get(key)
    if (hit !== undefined) return hit
    let min = Infinity, max = -Infinity, n = 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.column(wx + dx, wz + dz)
        if (!c || c.water || c.groundY === NO_Y) continue
        if (c.groundY < min) min = c.groundY
        if (c.groundY > max) max = c.groundY
        n++
      }
    }
    const out = n >= 5 ? max - min : null
    this.slopeCache.set(key, out)
    return out
  }

  /**
   * 这一列能否承载「合法岩浆湖地形」：不是水域，且坡度可判定并且低于阈值。
   * 地形缺失（区块没读到）时返回 null，调用方按「未知」处理。
   */
  isUsable(wx: number, wz: number, slopeThreshold: number): boolean | null {
    const c = this.column(wx, wz)
    if (!c || c.groundY === NO_Y) return null
    if (c.water) return false
    const s = this.slope(wx, wz)
    if (s === null) return null
    return s < slopeThreshold
  }

  /**
   * 两点之间是否被「非法地形带」隔断（直线采样）。
   *
   * 用途：两块合法地形之间若隔着海洋或陡坡，它们之间的直线距离不是「同一片可生成地形上的间距」，
   * 不该计入间距统计。跳过的两端 skip 格 —— 采样点从湖自己的范围里起步时必然踩在湖盆上。
   *
   * 判定不是「踩到一格非法就断开」，而是「连续 maxBlockedRun 格非法才算一条地形带」：
   * 3x3 高差 >= 阈值的零星列在地形上随处可见（树坑、石边），它们中间仍有平坦地块，
   * 不构成不能生成岩浆湖的区域；只有连续的陡坡带/水域才是。maxBlockedRun=1 则退化为严格逐格。
   *
   * 返回：
   *   true  全程可通行
   *   false 中途遇到足够长的非法地形带
   *   null  中途缺少地形数据，无法判断
   */
  pathUsable(
    x0: number, z0: number, x1: number, z1: number,
    opts: { slopeThreshold: number, skip?: number, maxBlockedRun?: number },
  ): boolean | null {
    const skip = opts.skip ?? 0
    const maxRun = Math.max(1, opts.maxBlockedRun ?? 1)
    const dx = x1 - x0, dz = z1 - z0
    const steps = Math.max(Math.abs(dx), Math.abs(dz))
    if (steps <= skip * 2) return true
    let unknown = false
    let run = 0
    for (let i = skip; i <= steps - skip; i++) {
      const t = steps === 0 ? 0 : i / steps
      const x = Math.round(x0 + dx * t)
      const z = Math.round(z0 + dz * t)
      const ok = this.isUsable(x, z, opts.slopeThreshold)
      if (ok === null) { unknown = true; run = 0; continue }
      if (ok) { run = 0; continue }
      if (++run >= maxRun) return false
    }
    return unknown ? null : true
  }

  /** 统计 bbox 内的列数与水域列数（只算已收录区块） */
  countColumns(bbox: { minX: number, maxX: number, minZ: number, maxZ: number }): { columns: number, water: number } {
    let columns = 0, water = 0
    for (let cx = bbox.minX >> 4; cx <= bbox.maxX >> 4; cx++) {
      for (let cz = bbox.minZ >> 4; cz <= bbox.maxZ >> 4; cz++) {
        const t = this.chunks.get(packXZ(cx, cz))
        if (!t) continue
        for (let i = 0; i < 256; i++) {
          columns++
          if (t.water[i]) water++
        }
      }
    }
    return { columns, water }
  }
}
