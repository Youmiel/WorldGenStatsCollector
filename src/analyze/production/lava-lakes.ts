import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"

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
 * params:
 *   yThreshold?: number  地表/地下分界 y（默认 60，y >= 该值为地表）
 *   minSize?: number     岩浆湖最小连通方块数（默认 6）
 *   mergeGap?: number    质心距离小于该值（方块）的湖合并为同一片（默认 16；0 = 不合并）
 */

const KEY = "lava-lakes"
const LAVA = "minecraft:lava"
const DIRS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

const DEFAULT_Y_THRESHOLD = 60
const DEFAULT_MIN_SIZE = 6
const DEFAULT_MERGE_GAP = 16

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

function spacingStat(points: Point[]): SpacingStat {
  const nn = points.length >= 2 ? nearestNeighbours(points) : []
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

function numParam(v: unknown, dflt: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

const analyzer: AnalyzerModule = {
  name: KEY,
  description: "岩浆湖间距（地表，每片连通 >= 6 方块）与地下岩浆每区块平均面积",
  create(params): Analyzer {
    const p = (params[KEY] ?? {}) as Record<string, unknown>
    const yThreshold = numParam(p.yThreshold, DEFAULT_Y_THRESHOLD)
    const minSize = Math.max(1, Math.trunc(numParam(p.minSize, DEFAULT_MIN_SIZE)))
    const mergeGap = Math.max(0, numParam(p.mergeGap, DEFAULT_MERGE_GAP))

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

    return {
      name: KEY,
      async onChunk(c: ChunkHandle) {
        const ext = await c.extent()
        if (!ext) return
        const grid = await c.grid({ yMin: ext.bottom, yMax: ext.top })
        const h = ext.top - ext.bottom + 1
        if (h <= 0 || grid.grid.length !== h * 256) return
        chunks++
        bounds.minX = Math.min(bounds.minX, c.x); bounds.maxX = Math.max(bounds.maxX, c.x)
        bounds.minZ = Math.min(bounds.minZ, c.z); bounds.maxZ = Math.max(bounds.maxZ, c.z)

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
      finalize() {
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

        const lakes = clusters.filter(c => c.size >= minSize)
        const discarded = clusters.length - lakes.length
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

        const spacing = spacingStat(groups)
        // 贴统计范围边界的组，最近邻可能落在范围外（会把均值抬上去），单独算一版内部组
        const interior = spacingStat(groups.filter(g => !g.areaEdge))

        const denom = chunks || 1
        return {
          chunks,
          lavaBlocks,
          yThreshold,
          minLakeSize: minSize,
          mergeGap,
          surface: {
            yRange: surfaceMaxY >= surfaceMinY ? [surfaceMinY, surfaceMaxY] : null,
            /** 全部连通区域数（含不足 minSize 的碎块） */
            clusters: clusters.length,
            /** size >= minSize 的岩浆湖（合并前） */
            lakes: lakes.length,
            /** 被丢弃的碎块数 */
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
            /** 合并后按组计算的平均间距 */
            spacing,
            /** 只统计不接触范围边界的组 */
            spacingInterior: interior,
            edgeGroups: {
              region: groups.filter(g => g.regionEdge).length,
              area: groups.filter(g => g.areaEdge).length,
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
          note: "岩浆湖 = 6 面连通的 lava 源方块（level=0）区域，每片连通区域只算一次；地表判定为 y >= yThreshold；质心距离 < mergeGap 的湖合并为一组再算间距；spacing/meanNN 为组质心的最近邻水平距离；地下面积为水平覆盖列数（1 列 = 1 方块²）",
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
        spacingInterior: SpacingStat
        edgeGroups: { region: number, area: number }
      }
      underground: {
        lavaBlocks: number
        chunksWithLava: number
        avgBlocksPerChunk: number
        avgAreaPerChunk: number
        areaSharePct: number
      }
    }
    const s = r.surface, u = r.underground, g = s.groups
    const fmt = (v: number | null) => (v === null ? "-" : String(v))
    const yRange = s.yRange ? ` ${s.yRange[0]}~${s.yRange[1]}` : ""
    const lines = [
      `区块 ${r.chunks}，地表岩浆湖(y>=${r.yThreshold}${yRange}) 连通 ${s.clusters} 片 → 合格 ${s.lakes} 片 → 合并后 ${g.count} 组`,
      `  连通 >= ${r.minLakeSize} 方块，共 ${s.lakeBlocks} 方块，平均 ${g.avgSize}/组；丢弃碎块 ${s.discarded}，因距离 < ${r.mergeGap} 合并 ${g.mergedPairs} 对`,
    ]

    const sp = s.spacing, ip = s.spacingInterior
    const useInterior = ip.count >= 2
    const pick = useInterior ? ip : sp
    if (pick.count >= 2) {
      const suffix = useInterior
        ? `  * 仅统计范围内部的 ${ip.count}/${sp.count} 组（剔除贴边 ${s.edgeGroups.area} 组）`
        : ""
      lines.push(
        `  平均间距 ${fmt(pick.meanNNChunks)} 区块（${fmt(pick.meanNNBlocks)} 方块），中位 ${fmt(pick.medianNNChunks)} 区块，最小 ${fmt(pick.minNNBlocks)} 方块，最大 ${fmt(pick.maxNNBlocks)} 方块${suffix}`,
      )
    } else {
      lines.push(`  平均间距：样本不足（合格湖组 ${ip.count} 组）`)
    }
    lines.push(`地下岩浆(y<${r.yThreshold}) 每区块平均 ${u.avgBlocksPerChunk} 方块，覆盖面积 ${u.avgAreaPerChunk} 方块²（占区块水平面积 ${u.areaSharePct}%），含岩浆区块 ${u.chunksWithLava}/${r.chunks}`)
    return lines
  },
}

export default analyzer
