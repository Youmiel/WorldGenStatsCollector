import type { Analyzer, AnalyzerContext, AnalyzerModule, ChunkHandle } from "../types.js"
import {
  TerrainIndex,
  dimHeightOf,
  loadDimensionHeights,
  pickHeightmaps,
  readChunkTerrain,
} from "../terrain.js"
import { buildMask } from "../mask.js"
import { buildComponentMesh, summarizeEdges } from "../mesh.js"
import { renderTerrainMap } from "../viz.js"
import { basename, join } from "node:path"

/**
 * 岩浆湖探测器：地表岩浆湖的平均间距 + 地下岩浆层每区块的平均面积。
 *
 * 判定口径：
 * - 「岩浆源头」= 方块为 minecraft:lava 且 liquid level 为 0。reader 省略默认属性时
 *   properties.level 不存在，这正是源方块；level 非 0 的流动岩浆不计。
 * - 连通 = 6 面相邻（不认斜角）。一片连通区域只算一次，size >= minSize（默认 6）才算一个岩浆湖。
 * - 地表 / 地下按方块自身的 y 划分：y >= yThreshold（默认 60）为地表，其余为地下。
 * - 地表 lava 全部收进一个世界级 Map，直到 finalize 才做连通：这样跨 region 文件的一整片湖
 *   也能正确合并（onChunk 时相邻 region 可能还没读，边上的方块会被漏掉）。
 * - 质心距离 < mergeGap（默认 16 方块 = 1 区块）的岩浆湖视为同一片（被 1~2 格地形隔断的碎块），
 *   合并成一组再算间距；合并前的湖数与合并明细都保留在结果里。
 * - 间距 = 湖组质心之间的最近邻水平距离，输出均值 / 中位 / 最小 / 最大（方块与区块两种单位）。
 *   spacingInterior 只算不接触统计范围边界的组（贴边的组，最近邻可能落在范围外）。
 * - 地下面积 = 地下岩浆覆盖的水平面积，按「每区块平均列数」计（1 列 = 1 方块²）。
 *
 * 地形（见 terrain.ts）：
 * - 地面高度取自 Heightmaps 的 MOTION_BLOCKING_NO_LEAVES（已排除树叶），再往下跳过原木/木材；
 *   直接扫 lava 列会受树木和湖盆本体的假高差影响，不可靠。
 * - 水域 = MOTION_BLOCKING > OCEAN_FLOOR（海底之上还有流体）。水域只用于水域/陆地面积统计，
 *   不作为「湖的列是否有水」的判据 —— lava 遇水即成黑曜石，那个判据在数据上恒为假。
 * - 陡坡 = 3x3 邻域地面高差 >= slopeThreshold。采样点从湖泊包围盒向外偏移 slopeSampleOffset，
 *   避开湖盆自身的边缘落差；取环上的中位数，单侧偶发的陡壁不会误判整片湖。
 *
 * params:
 *   yThreshold?: number        地表/地下分界 y（默认 60，y >= 该值为地表）
 *   minSize?: number           岩浆湖最小连通方块数（默认 6）
 *   mergeGap?: number          质心距离小于该值（方块）的湖合并为同一片（默认 16；0 = 不合并）
 *   excludeSlope?: boolean     剔除位于陡坡上的湖（默认 true）
 *   slopeThreshold?: number    陡坡判定：3x3 地面高差 >= 该值（默认 6，实测分布见 ref/MEASUREMENTS.md）
 *   slopeSampleOffset?: number 坡度采样环相对湖泊包围盒向外偏移的方块数（默认 4）
 */

const KEY = "lava-lakes"
const LAVA = "minecraft:lava"
const DIRS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

const DEFAULT_Y_THRESHOLD = 60
const DEFAULT_MIN_SIZE = 6
const DEFAULT_MERGE_GAP = 16
/** 3x3 地面高差 >= 6：全地形剔除 21.9%，lava 列周围剔除约 17% */
const DEFAULT_SLOPE_THRESHOLD = 6
const DEFAULT_SLOPE_SAMPLE_OFFSET = 4
/** 间距连线上连续多少格非法地形才算「被隔断」：零星陡坡不切断，连续陡坡带/水域才切断 */
const DEFAULT_SPACING_MAX_BLOCKED_RUN = 16
/** mask 的 tile 粒度（方块）：16 = 1 区块，8 = 1/4 区块 */
const DEFAULT_MASK_TILE_SIZE = 16
/** tile 内可用列占比达到该值才算可用 tile */
const DEFAULT_MASK_MIN_USABLE_SHARE = 0.5
/** mesh 边校验：连线上连续多少个不可用 tile 算一道地形带 */
const DEFAULT_MASK_MAX_BAD_TILES = 2
/** 可视化：方块 / 像素（4 = 1/4 分辨率，够看清 mask 边界与 mesh 连线） */
const DEFAULT_VIZ_SCALE = 4

interface Point { x: number, z: number }
interface Bounds { minX: number, maxX: number, minZ: number, maxZ: number }

/** 一片 6 面连通的 lava 区域（size 可能小于 minSize） */
interface Cluster {
  size: number
  /** 质心（方块中心，即 x + 0.5） */
  x: number
  z: number
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  /** 簇内有方块贴在 region 文件边界（相邻 region 缺数据时会被截断） */
  regionEdge: boolean
  /** 簇内有方块贴在统计范围边界（范围外无从得知） */
  areaEdge: boolean
}

/** mergeGap 合并后的岩浆湖组 */
interface LakeGroup {
  size: number
  x: number
  z: number
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  regionEdge: boolean
  areaEdge: boolean
  /** 合并了多少片连通区域 */
  members: number
}

const round = (v: number, digits: number) => Number(v.toFixed(digits))

function mean(v: number[]): number | null {
  if (!v.length) return null
  return v.reduce((a, b) => a + b, 0) / v.length
}

function median(v: number[]): number | null {
  if (!v.length) return null
  const s = [...v].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** 最近邻水平距离（方块） */
function nearestNeighbours(points: Point[]): number[] {
  const out = new Array<number>(points.length).fill(0)
  for (let i = 0; i < points.length; i++) {
    let best = Infinity
    const a = points[i]
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue
      const b = points[j]
      const dx = a.x - b.x, dz = a.z - b.z
      const d2 = dx * dx + dz * dz
      if (d2 < best) best = d2
    }
    out[i] = Math.sqrt(best)
  }
  return out
}

interface SpacingStat {
  count: number
  meanNNBlocks: number | null
  meanNNChunks: number | null
  medianNNBlocks: number | null
  medianNNChunks: number | null
  minNNBlocks: number | null
  maxNNBlocks: number | null
}

function spacingStatFromNN(nn: number[]): SpacingStat {
  const m = mean(nn)
  const med = median(nn)
  return {
    count: nn.length,
    meanNNBlocks: m === null ? null : round(m, 1),
    meanNNChunks: m === null ? null : round(m / 16, 2),
    medianNNBlocks: med === null ? null : round(med, 1),
    medianNNChunks: med === null ? null : round(med / 16, 2),
    minNNBlocks: nn.length ? round(Math.min(...nn), 1) : null,
    maxNNBlocks: nn.length ? round(Math.max(...nn), 1) : null,
  }
}

function spacingStat(points: Point[]): SpacingStat {
  return spacingStatFromNN(points.length >= 2 ? nearestNeighbours(points) : [])
}

function numParam(v: unknown, dflt: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

const analyzer: AnalyzerModule = {
  name: KEY,
  description: "岩浆湖间距（地表，每片连通 >= 6 方块，剔除陡坡）与地下岩浆每区块平均面积",
  create(params): Analyzer {
    const p = (params[KEY] ?? {}) as Record<string, unknown>
    const yThreshold = numParam(p.yThreshold, DEFAULT_Y_THRESHOLD)
    const minSize = Math.max(1, Math.trunc(numParam(p.minSize, DEFAULT_MIN_SIZE)))
    const mergeGap = Math.max(0, numParam(p.mergeGap, DEFAULT_MERGE_GAP))
    const excludeSlope = p.excludeSlope !== false
    const slopeThreshold = numParam(p.slopeThreshold, DEFAULT_SLOPE_THRESHOLD)
    const slopeSampleOffset = Math.max(0, Math.trunc(numParam(p.slopeSampleOffset, DEFAULT_SLOPE_SAMPLE_OFFSET)))
    const spacingMaxBlockedRun = Math.max(1, Math.trunc(numParam(p.spacingMaxBlockedRun, DEFAULT_SPACING_MAX_BLOCKED_RUN)))
    const maskTileSize = Math.max(1, Math.trunc(numParam(p.maskTileSize, DEFAULT_MASK_TILE_SIZE)))
    const maskMinUsableShare = Math.min(1, Math.max(0, numParam(p.maskMinUsableShare, DEFAULT_MASK_MIN_USABLE_SHARE)))
    const maskMaxBadTiles = Math.max(1, Math.trunc(numParam(p.maskMaxBadTiles, DEFAULT_MASK_MAX_BAD_TILES)))
    // 可视化是 lava-lakes 的固定输出阶段（默认开启），产物与结果 JSON 同目录
    const visualize = p.visualize !== false
    const vizScale = Math.max(1, Math.trunc(numParam(p.vizScale, DEFAULT_VIZ_SCALE)))

    /** 地形索引：onChunk 时收录，finalize 时算跨区块坡度 */
    const terrain = new TerrainIndex()
    let dimension = "overworld"
    /** 维度最低 y：Heightmaps 是相对它编码的 */
    let minY = -64
    let heightsReady = false

    /** 水域/陆地列统计（口径见文件头） */
    let terrainColumns = 0
    let waterColumns = 0

    /**
     * 所有地表 lava 源方块：世界坐标 key → 索引。
     * 不在这里做连通：onChunk 时相邻 region 可能还没读，压在 region 边界上的边会被漏掉；
     * 全部读完再统一 BFS，跨 region 的一整片湖才能正确合并。
     * 只有 y >= yThreshold 的 lava 会进来（默认 60，量级很小）。
     */
    const lava = new Map<string, number>()
    const xs: number[] = []
    const ys: number[] = []
    const zs: number[] = []

    // 地下岩浆：只累计面积，不需要连通
    let chunks = 0
    let lavaBlocks = 0
    let undergroundBlocks = 0
    let undergroundColumns = 0
    let undergroundChunks = 0
    let ugMinY = Infinity
    let ugMaxY = -Infinity
    let surfaceMinY = Infinity
    let surfaceMaxY = -Infinity
    const bounds: Bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }

    const ensureHeight = async (ctx: AnalyzerContext) => {
      if (heightsReady) return
      heightsReady = true
      const table = await loadDimensionHeights(ctx.runtime.serverJar)
      minY = dimHeightOf(table, dimension).minY
    }

    return {
      name: KEY,
      async onRegion(session) {
        // 每个分析器可能跑多个维度；维度切换时 minY 要重取
        if (session.dimension !== dimension) {
          dimension = session.dimension
          heightsReady = false
        }
      },
      async onChunk(c: ChunkHandle, ctx) {
        await ensureHeight(ctx)
        const ext = await c.extent()
        if (!ext) return
        const grid = await c.grid({ yMin: ext.bottom, yMax: ext.top })
        const h = ext.top - ext.bottom + 1
        if (h <= 0 || grid.grid.length !== h * 256) return
        chunks++
        bounds.minX = Math.min(bounds.minX, c.x); bounds.maxX = Math.max(bounds.maxX, c.x)
        bounds.minZ = Math.min(bounds.minZ, c.z); bounds.maxZ = Math.max(bounds.maxZ, c.z)

        // 地形：Heightmaps 走 rawNbt（reader 的 world.chunk() 会丢掉这个根键），方块从已加载的 grid 取
        const heightmaps = pickHeightmaps(await c.rawNbt(["Heightmaps"]))
        const t = readChunkTerrain(grid, heightmaps, minY, ext.bottom)
        terrain.add(c.x, c.z, t)
        terrainColumns += 256
        for (let i = 0; i < 256; i++) if (t.water[i]) waterColumns++

        // 源方块：palette 里 id 为 lava 且 level 缺省（0）或显式为 0
        const sourceStates = new Set<number>()
        for (let i = 0; i < grid.palette.length; i++) {
          const s = grid.palette[i]
          if (s.id !== LAVA) continue
          const level = s.properties?.level
          if (level === undefined || level === "0") sourceStates.add(i + 1)
        }
        if (!sourceStates.size) return

        const bx = c.x * 16, bz = c.z * 16
        let columns: Uint8Array | null = null

        for (let i = 0; i < grid.grid.length; i++) {
          const v = grid.grid[i]
          if (!sourceStates.has(v)) continue
          const yi = i >> 8
          const rest = i & 255
          const lz = rest >> 4
          const lx = rest & 15
          const y = ext.bottom + yi
          lavaBlocks++

          if (y >= yThreshold) {
            if (y < surfaceMinY) surfaceMinY = y
            if (y > surfaceMaxY) surfaceMaxY = y
            const wx = bx + lx, wz = bz + lz
            lava.set(`${wx},${y},${wz}`, xs.length)
            xs.push(wx)
            ys.push(y)
            zs.push(wz)
          } else {
            undergroundBlocks++
            if (y < ugMinY) ugMinY = y
            if (y > ugMaxY) ugMaxY = y
            columns ??= new Uint8Array(256)
            columns[lz * 16 + lx] = 1
          }
        }

        if (columns) {
          undergroundChunks++
          for (let i = 0; i < 256; i++) if (columns[i]) undergroundColumns++
        }
      },
      async finalize(ctx) {
        const total = xs.length
        const visited = new Uint8Array(total)
        const hasBounds = bounds.maxX >= bounds.minX

        // 6 面连通（跨 region、跨区块都是一次 BFS，所以压在两边的同一片会正确合并）
        const clusters: Cluster[] = []
        for (let i = 0; i < total; i++) {
          if (visited[i]) continue
          let size = 0, sx = 0, sz = 0
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
          let regionEdge = false, areaEdge = false
          const stack = [i]
          visited[i] = 1
          while (stack.length) {
            const cur = stack.pop()!
            size++
            const x = xs[cur], y = ys[cur], z = zs[cur]
            // 用方块中心算质心
            sx += x + 0.5
            sz += z + 0.5
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (z < minZ) minZ = z
            if (z > maxZ) maxZ = z
            // region 覆盖 512x512 方块：低 9 位为 0 / 511 就是贴在 region 文件边界上
            if ((x & 511) === 0 || (x & 511) === 511 || (z & 511) === 0 || (z & 511) === 511) regionEdge = true
            // 落在最外一层区块里 → 相邻区块可能在统计范围外，这片湖可能被裁过
            if (hasBounds && (
              x < (bounds.minX + 1) * 16 || x >= bounds.maxX * 16 ||
              z < (bounds.minZ + 1) * 16 || z >= bounds.maxZ * 16
            )) areaEdge = true
            for (const [dx, dy, dz] of DIRS) {
              const next = lava.get(`${x + dx},${y + dy},${z + dz}`)
              if (next === undefined || visited[next]) continue
              visited[next] = 1
              stack.push(next)
            }
          }
          clusters.push({ size, x: sx / size, z: sz / size, minX, maxX, minZ, maxZ, regionEdge, areaEdge })
        }

        /**
         * 湖泊周围地形的坡度：取包围盒向外偏移 slopeSampleOffset 的一圈采样点，
         * 用中位数代表这片湖所在坡面的陡峭程度（单侧陡壁不误判整片湖）。
         * 地形缺失或附近全是水域 → null，不参与陡坡判定。
         */
        const lakeSlope = (c: Cluster): number | null => {
          const x0 = c.minX - slopeSampleOffset, x1 = c.maxX + slopeSampleOffset
          const z0 = c.minZ - slopeSampleOffset, z1 = c.maxZ + slopeSampleOffset
          const samples: number[] = []
          const push = (x: number, z: number) => {
            const s = terrain.slope(x, z)
            if (s !== null) samples.push(s)
          }
          for (let x = x0; x <= x1; x++) { push(x, z0); push(x, z1) }
          for (let z = z0 + 1; z < z1; z++) { push(x0, z); push(x1, z) }
          return median(samples)
        }

        const sizeOk = clusters.filter(c => c.size >= minSize)
        const slopeHist = new Map<string, number>()
        const bumpSlope = (s: number) => {
          const k = s <= 1 ? "0-1" : s <= 3 ? "2-3" : s <= 5 ? "4-5" : s <= 8 ? "6-8" : "9+"
          slopeHist.set(k, (slopeHist.get(k) ?? 0) + 1)
        }
        let slopeEvaluated = 0, slopeNoData = 0
        /** 被陡坡整片剔除的湖（可视化用红点标出，便于核对判定是否合理） */
        const slopeRejected: Cluster[] = []
        const lakes = sizeOk.filter(c => {
          const s = lakeSlope(c)
          if (s === null) { slopeNoData++; return true }
          slopeEvaluated++
          bumpSlope(s)
          if (!excludeSlope || s < slopeThreshold) return true
          slopeRejected.push(c)
          return false
        })
        const discarded = clusters.length - sizeOk.length

        const lakeBlocks = lakes.reduce((a, c) => a + c.size, 0)

        // 质心过近的湖合并成一组：同一片被 1~2 格地形隔断的碎块、或恰好被 region 边界切开的两半
        const lParent = lakes.map((_, i) => i)
        const lfind = (a: number): number => {
          let root = a
          while (lParent[root] !== root) root = lParent[root]
          while (lParent[a] !== root) {
            const next = lParent[a]
            lParent[a] = root
            a = next
          }
          return root
        }
        const merges: { distance: number, aSize: number, bSize: number, x: number, z: number }[] = []
        if (mergeGap > 0) {
          for (let i = 0; i < lakes.length; i++) {
            for (let j = i + 1; j < lakes.length; j++) {
              const d = Math.hypot(lakes[i].x - lakes[j].x, lakes[i].z - lakes[j].z)
              if (d >= mergeGap) continue
              const ri = lfind(i), rj = lfind(j)
              if (ri !== rj) lParent[rj] = ri
              merges.push({
                distance: round(d, 1),
                aSize: lakes[i].size,
                bSize: lakes[j].size,
                x: round((lakes[i].x + lakes[j].x) / 2, 1),
                z: round((lakes[i].z + lakes[j].z) / 2, 1),
              })
            }
          }
        }

        const agg = new Map<number, { sx: number, sz: number, g: LakeGroup }>()
        for (let i = 0; i < lakes.length; i++) {
          const l = lakes[i]
          const root = lfind(i)
          let a = agg.get(root)
          if (!a) {
            a = {
              sx: 0, sz: 0,
              g: { size: 0, x: 0, z: 0, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, regionEdge: false, areaEdge: false, members: 0 },
            }
            agg.set(root, a)
          }
          // 组质心 = 按方块数加权的片质心（等价于所有方块中心的均值）
          a.sx += l.x * l.size
          a.sz += l.z * l.size
          a.g.size += l.size
          a.g.members++
          a.g.minX = Math.min(a.g.minX, l.minX); a.g.maxX = Math.max(a.g.maxX, l.maxX)
          a.g.minZ = Math.min(a.g.minZ, l.minZ); a.g.maxZ = Math.max(a.g.maxZ, l.maxZ)
          a.g.regionEdge ||= l.regionEdge
          a.g.areaEdge ||= l.areaEdge
        }
        const groups: LakeGroup[] = [...agg.values()].map(a => ({ ...a.g, x: a.sx / a.g.size, z: a.sz / a.g.size }))

        /**
         * 最近邻距离。地形连通的版本会沿两点连线采样：中途一旦被足够长的水域/陡坡带隔断，
         * 这对湖就不算「同一片合法地形上的邻居」，跳过它去找下一个。
         * 两块合法地形之间隔着海洋/陡坡时，那段直线距离没有意义，不该计入间距。
         */
        const spacing = spacingStat(groups)
        let rejectedByTerrain = 0
        /** 只对给定下标集合算地形连通的最近邻 */
        const terrainNN = (indices: number[]): { nn: number[], isolated: number } => {
          const nn: number[] = []
          let isolated = 0
          if (!excludeSlope) {
            const pts = indices.map(i => groups[i])
            return { nn: pts.length >= 2 ? nearestNeighbours(pts) : [], isolated: 0 }
          }
          for (const i of indices) {
            const a = groups[i]
            const cands: { j: number, d: number }[] = []
            for (const j of indices) {
              if (i === j) continue
              cands.push({ j, d: Math.hypot(a.x - groups[j].x, a.z - groups[j].z) })
            }
            cands.sort((p, q) => p.d - q.d)
            let found = false
            for (const c of cands) {
              const b = groups[c.j]
              // 湖自己的范围要跳过：采样点从湖盆上起步，那几格本来就可能是陡的
              const skip = Math.max(
                slopeSampleOffset,
                Math.ceil(Math.max(b.maxX - b.minX, b.maxZ - b.minZ, a.maxX - a.minX, a.maxZ - a.minZ) / 2),
              )
              const ok = terrain.pathUsable(a.x, a.z, b.x, b.z, {
                slopeThreshold,
                skip,
                maxBlockedRun: spacingMaxBlockedRun,
              })
              if (ok === false) { rejectedByTerrain++; continue }
              nn.push(c.d)
              found = true
              break
            }
            if (!found && cands.length) isolated++
          }
          return { nn, isolated }
        }

        const allNN = terrainNN(groups.map((_, i) => i))
        const spacingTerrain = excludeSlope ? spacingStatFromNN(allNN.nn) : spacing
        // 贴统计范围边界的组，最近邻可能落在范围外（会把均值抬上去），单独算一版内部组
        const interiorIdx = groups.map((_, i) => i).filter(i => !groups[i].areaEdge)
        const interiorNN = terrainNN(interiorIdx)
        const interior = excludeSlope ? spacingStatFromNN(interiorNN.nn) : spacingStat(interiorIdx.map(i => groups[i]))

        /**
         * mask + Delaunay mesh 口径。
         *
         * 把合法地形（非水域 + 坡度合格）按 tile 聚合成 mask，mask 的连通分量就是地理上
         * 连成一片的可生成区。分量内做 Delaunay 三角剖分，取 mesh 的边作为邻接关系，
         * 但每条边还要用 mask 校验直线本身（分量是拓扑连通，直线照样可能穿海）。
         * 详见 mask.ts / mesh.ts。
         */
        const mask = buildMask(terrain, {
          tileSize: maskTileSize,
          slopeThreshold,
          minUsableShare: maskMinUsableShare,
        })
        const built = buildComponentMesh(terrain, mask, groups, {
          maxBadTiles: maskMaxBadTiles,
          minSkip: slopeSampleOffset,
        })
        const meshSummary = summarizeEdges(built.keptLengths)
        const vizEdges = built.edges

        const mesh = {
          enabled: excludeSlope,
          /** mask 参数 */
          tileSize: maskTileSize,
          tileBlocks: maskTileSize,
          minUsableShare: maskMinUsableShare,
          /** mask 规模 */
          tiles: mask.tiles,
          usableTiles: mask.usableTiles,
          components: mask.components.length,
          /** 有 >= 2 个湖的分量数（真正能连边的） */
          componentsWithMesh: built.componentsWithMesh,
          /** 只有 1 个湖的分量数（区域内孤立） */
          componentsSingle: built.componentsSingle,
          /** 不属于任何可用分量的湖 */
          unassignedLakes: built.unassigned,
          /** 分量内湖数分布（降序，前 10 个） */
          componentLakeCounts: built.pointsPerComponent,
          /** 每个含湖分量的规模（前 10，按 tile 数降序） */
          lakeComponents: built.components,
          /** mesh 边数（已通过 mask 校验） */
          edges: meshSummary.count,
          /** Delaunay 生成的总边数（含被剔除） */
          edgesTotal: meshSummary.count + built.rejected,
          /** 因连线被水域/陡坡带隔断而剔除的边 */
          edgesRejected: built.rejected,
          rejectByReason: built.rejectByReason,
          meanEdgeBlocks: meshSummary.meanBlocks,
          meanEdgeChunks: meshSummary.meanChunks,
          medianEdgeBlocks: meshSummary.medianBlocks,
          medianEdgeChunks: meshSummary.medianChunks,
          minEdgeBlocks: meshSummary.minBlocks,
          maxEdgeBlocks: meshSummary.maxBlocks,
          quantiles: meshSummary.quantiles,
          histogram: meshSummary.histogram,
        }

        /**
         * 可视化：固定输出阶段，只在 visualize=true 时出图。
         * 画地形分类、mask 连通区、湖泊与 mesh 边（含被剔除的边），用来肉眼核对地形判定。
         */
        let viz: { file: string, scale: number, width: number, height: number } | null = null
        if (visualize) {
          const file = join(ctx.runtime.outDir, `${KEY}-map.png`)
          try {
            await renderTerrainMap({
              terrain,
              mask,
              slopeThreshold,
              lakes: [
                ...groups.map(g => ({ x: g.x, z: g.z, filtered: false })),
                ...slopeRejected.map(c => ({ x: c.x, z: c.z, filtered: true })),
              ],
              edges: vizEdges,
            }, file, { scale: vizScale })
            const b = terrain.worldBounds()
            viz = {
              file: basename(file),
              scale: vizScale,
              width: b ? Math.ceil((b.maxX - b.minX + 1) / vizScale) : 0,
              height: b ? Math.ceil((b.maxZ - b.minZ + 1) / vizScale) : 0,
            }
          } catch (e) {
            ctx.log(`可视化生成失败：${(e as Error).message}`)
          }
        }

        const denom = chunks || 1
        const landColumns = terrainColumns - waterColumns
        const landChunks = landColumns / 256
        return {
          chunks,
          lavaBlocks,
          yThreshold,
          minLakeSize: minSize,
          mergeGap,
          minY,
          surface: {
            yRange: surfaceMaxY >= surfaceMinY ? [surfaceMinY, surfaceMaxY] : null,
            /** 全部连通区域数（含不足 minSize 的碎块） */
            clusters: clusters.length,
            /** 尺寸合格、地形可用、进入间距统计的岩浆湖（合并前） */
            lakes: lakes.length,
            /** 只按尺寸丢弃的碎块数（不含陡坡剔除） */
            discarded,
            /** 属于合格岩浆湖的方块数 */
            lakeBlocks,
            avgLakeSize: lakes.length ? round(lakeBlocks / lakes.length, 2) : 0,
            /** 质心距离 < mergeGap 的湖合并后的组 */
            groups: {
              count: groups.length,
              mergedPairs: merges.length,
              avgSize: groups.length ? round(lakeBlocks / groups.length, 2) : 0,
            },
            /** 被合并的湖对明细（距离升序，最多 20 条） */
            merges: merges.sort((a, b) => a.distance - b.distance).slice(0, 20),
            /** 合并后按组计算的平均间距（欧氏直线，不看地形） */
            spacing,
            /** 同上，但只统计地形连通的邻居（连线穿过水域/陡坡的对被跳过） */
            spacingTerrain,
            /** 地形连通过滤的代价：被跳过的候选对数、找不到合法邻居的孤立组数 */
            spacingTerrainFilter: {
              enabled: excludeSlope,
              rejectedPairs: rejectedByTerrain,
              isolatedGroups: allNN.isolated,
              maxBlockedRun: spacingMaxBlockedRun,
            },
            /** mask + Delaunay mesh：只在同一片合法地形区内部连边 */
            mesh,
            /** 只统计不接触范围边界的组 */
            spacingInterior: interior,
            edgeGroups: {
              region: groups.filter(g => g.regionEdge).length,
              area: groups.filter(g => g.areaEdge).length,
            },
            /** 陡坡过滤：采样环向外偏移，取环上坡度的中位数 */
            slope: {
              enabled: excludeSlope,
              threshold: slopeThreshold,
              sampleOffset: slopeSampleOffset,
              unit: "median of 3x3 ground-height range on the ring around the lake bbox",
              evaluated: slopeEvaluated,
              filtered: sizeOk.length - lakes.length,
              noData: slopeNoData,
              /** 尺寸合格湖的坡度分布（中位数，按档） */
              histogram: ["0-1", "2-3", "4-5", "6-8", "9+"].map(k => ({ range: k, lakes: slopeHist.get(k) ?? 0 })),
            },
            /** 水域 / 陆地面积（Heightmaps 口径：MOTION_BLOCKING > OCEAN_FLOOR 为水域） */
            landWater: {
              columns: terrainColumns,
              water: waterColumns,
              land: landColumns,
              waterSharePct: terrainColumns ? round(waterColumns / terrainColumns * 100, 2) : 0,
              /** 陆地列折算成区块数（256 列 = 1 区块） */
              landChunksEquivalent: round(landChunks, 1),
            },
            /** 按陆地面积归一化的湖密度：海洋不该稀释湖泊生成频率 */
            density: {
              lakesPer1000LandChunks: landChunks > 0 ? round(lakes.length / landChunks * 1000, 2) : null,
              groupsPer1000LandChunks: landChunks > 0 ? round(groups.length / landChunks * 1000, 2) : null,
            },
          },
          underground: {
            yRange: ugMaxY >= ugMinY ? [ugMinY, ugMaxY] : null,
            lavaBlocks: undergroundBlocks,
            chunksWithLava: undergroundChunks,
            /** 每区块平均地下岩浆方块数 */
            avgBlocksPerChunk: round(undergroundBlocks / denom, 2),
            /** 每区块平均水平覆盖面积（列数，1 列 = 1 方块²） */
            avgAreaPerChunk: round(undergroundColumns / denom, 2),
            /** 覆盖面积占区块水平面积（256 列）的比例 */
            areaSharePct: round(undergroundColumns / (denom * 256) * 100, 3),
          },
          note: "岩浆湖 = 6 面连通的 lava 源方块（level=0）区域，每片连通区域只算一次；地表判定为 y >= yThreshold；地面高度取自 MOTION_BLOCKING_NO_LEAVES 并向下跳过原木，陡坡 = 湖泊包围盒外扩 slopeSampleOffset 的环上 3x3 地面高差中位数 >= slopeThreshold，超阈值的湖整片剔除；水域 = MOTION_BLOCKING > OCEAN_FLOOR，只用于水域/陆地面积与密度归一化；质心距离 < mergeGap 的湖合并为一组再算间距；mesh 只保留直线不穿过不可用地形 tile 的边",
          visual: viz,
        }
      },
    }
  },
  format(result) {
    const r = result as {
      chunks: number
      yThreshold: number
      minLakeSize: number
      mergeGap: number
      surface: {
        yRange: [number, number] | null
        clusters: number
        lakes: number
        discarded: number
        lakeBlocks: number
        avgLakeSize: number
        groups: { count: number, mergedPairs: number, avgSize: number }
        spacing: SpacingStat
        spacingTerrain: SpacingStat
        spacingTerrainFilter: { enabled: boolean, rejectedPairs: number, isolatedGroups: number, maxBlockedRun: number }
        mesh: {
          enabled: boolean
          tileSize: number
          tileBlocks: number
          minUsableShare: number
          tiles: number
          usableTiles: number
          components: number
          componentsWithMesh: number
          componentsSingle: number
          unassignedLakes: number
          componentLakeCounts: number[]
          edges: number
          edgesTotal: number
          edgesRejected: number
          rejectByReason: { water: number, steep: number }
          meanEdgeBlocks: number | null
          meanEdgeChunks: number | null
          medianEdgeBlocks: number | null
          medianEdgeChunks: number | null
          minEdgeBlocks: number | null
          maxEdgeBlocks: number | null
          quantiles: { p25: number | null, p50: number | null, p75: number | null, p90: number | null }
          histogram: { range: string, edges: number }[]
        }
        spacingInterior: SpacingStat
        edgeGroups: { region: number, area: number }
        slope: {
          enabled: boolean
          threshold: number
          sampleOffset: number
          evaluated: number
          filtered: number
          noData: number
          histogram: { range: string, lakes: number }[]
        }
        landWater: { columns: number, water: number, land: number, waterSharePct: number, landChunksEquivalent: number }
        density: { lakesPer1000LandChunks: number | null, groupsPer1000LandChunks: number | null }
      }
      visual?: { file: string, scale: number, width: number, height: number } | null
      underground: {
        lavaBlocks: number
        chunksWithLava: number
        avgBlocksPerChunk: number
        avgAreaPerChunk: number
        areaSharePct: number
      }
    }
    const s = r.surface, u = r.underground, g = s.groups, lw = s.landWater
    const fmt = (v: number | null) => (v === null ? "-" : String(v))
    const yRange = s.yRange ? ` ${s.yRange[0]}~${s.yRange[1]}` : ""
    const lines = [
      `区块 ${r.chunks}，地表岩浆湖(y>=${r.yThreshold}${yRange}) 连通 ${s.clusters} 片 → 合格 ${s.lakes} 片 → 合并后 ${g.count} 组`,
      `  连通 >= ${r.minLakeSize} 方块，共 ${s.lakeBlocks} 方块，平均 ${g.avgSize}/组；丢弃碎块 ${s.discarded}，因距离 < ${r.mergeGap} 合并 ${g.mergedPairs} 对`,
    ]

    if (s.slope.enabled) {
      const hist = s.slope.histogram.map(h => `${h.range}:${h.lakes}`).join(" ")
      lines.push(
        `  陡坡过滤（3x3 >= ${s.slope.threshold}，采样环外扩 ${s.slope.sampleOffset}）: 评估 ${s.slope.evaluated} 片，剔除 ${s.slope.filtered} 片，无数据 ${s.slope.noData}；坡度分布 ${hist}`,
      )
    } else {
      lines.push(`  陡坡过滤：已关闭`)
    }

    lines.push(
      `  水域/陆地（Heightmaps）: 列 ${lw.columns}，水域 ${lw.water}(${lw.waterSharePct}%)，陆地 ${lw.land}（≈${lw.landChunksEquivalent} 区块）`,
    )
    if (s.density.lakesPer1000LandChunks !== null) {
      lines.push(`  陆地归一化密度: ${s.density.lakesPer1000LandChunks} 湖 / 1000 陆地区块，${s.density.groupsPer1000LandChunks} 组 / 1000 陆地区块`)
    }

    const sp = s.spacingTerrain, eu = s.spacing, ip = s.spacingInterior, tf = s.spacingTerrainFilter
    const useInterior = ip.count >= 2
    const pick = useInterior ? ip : sp
    if (pick.count >= 2) {
      const suffix = useInterior
        ? `  * 仅统计范围内部的 ${ip.count}/${sp.count} 组（剔除贴边 ${s.edgeGroups.area} 组）`
        : ""
      lines.push(
        `  平均间距（地形连通） ${fmt(pick.meanNNChunks)} 区块（${fmt(pick.meanNNBlocks)} 方块），中位 ${fmt(pick.medianNNChunks)} 区块，最小 ${fmt(pick.minNNBlocks)} 方块，最大 ${fmt(pick.maxNNBlocks)} 方块${suffix}`,
      )
    } else {
      lines.push(`  平均间距：样本不足（合格湖组 ${ip.count} 组）`)
    }
    if (tf.enabled) {
      lines.push(
        `  地形连通口径: 参与 ${sp.count}/${g.count} 组，跳过跨水域/陡坡的候选 ${tf.rejectedPairs} 对（连续 >= ${tf.maxBlockedRun} 格判为地形带），无合法邻居 ${tf.isolatedGroups} 组；欧氏对照 ${fmt(eu.meanNNChunks)} 区块 / 中位 ${fmt(eu.medianNNChunks)}`,
      )
    }

    const m = s.mesh
    if (m.enabled) {
      lines.push(
        `  地形 mask: tile ${m.tileBlocks} 方块（用量 ≥ ${(m.minUsableShare * 100).toFixed(0)}%），可用 ${m.usableTiles}/${m.tiles} tile，${m.components} 个连通区（有 mesh ${m.componentsWithMesh}，单湖 ${m.componentsSingle}），未归属湖 ${m.unassignedLakes}`,
      )
      if (m.edges) {
        const hist = m.histogram.map(h => `${h.range}:${h.edges}`).join(" ")
        lines.push(
          `  三角 mesh（同区且不跨不可用地形）: ${m.edges}/${m.edgesTotal} 条边可用（剔除 ${m.edgesRejected}：跨水域 ${m.rejectByReason.water} / 跨陡坡 ${m.rejectByReason.steep}）`,
        )
        lines.push(
          `    均值 ${m.meanEdgeChunks} 区块（${m.meanEdgeBlocks} 方块），中位 ${m.medianEdgeChunks} 区块，最小 ${m.minEdgeBlocks} 方块，最大 ${m.maxEdgeBlocks} 方块`,
        )
        lines.push(`    边长分布 ${hist}`)
        const q = m.quantiles
        lines.push(
          `    分位数 p25 ${q.p25} / p50 ${q.p50} / p75 ${q.p75} / p90 ${q.p90} 方块`,
        )
      } else {
        lines.push(`  三角 mesh：mask 校验后没有可用边（原始 ${m.edgesTotal} 条全部跨越不可用地形）`)
      }
    }
    if (r.visual) {
      lines.push(`  可视化 ${r.visual.file}（${r.visual.width}x${r.visual.height}，1px = ${r.visual.scale} 方块）`)
    }
    lines.push(`地下岩浆(y<${r.yThreshold}) 每区块平均 ${u.avgBlocksPerChunk} 方块，覆盖面积 ${u.avgAreaPerChunk} 方块²（占区块水平面积 ${u.areaSharePct}%），含岩浆区块 ${u.chunksWithLava}/${r.chunks}`)
    return lines
  },
}

export default analyzer
