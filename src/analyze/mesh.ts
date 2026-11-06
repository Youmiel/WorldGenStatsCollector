import { delaunayEdges } from "./delaunay.js"
import { maskPath, type TerrainMask } from "./mask.js"
import type { TerrainIndex } from "./terrain.js"

/**
 * 三角网（Delaunay mesh）邻接统计。
 *
 * 用途：把一组点（通常是湖泊质心）变成「谁和谁是邻居」的关系网，用边长刻画间距。
 *
 * 为什么比最近邻好：最近邻每点只留一条边（边数 = 点数），局部聚集或孤立点会造出
 * 假的「很远的间距」；三角网的边覆盖整个区域，密度估计更稳。
 *
 * 为什么必须做地形校验：Delaunay 只认几何最近，两点之间隔着海洋或陡坡时，
 * 那条直线距离不是「同一片可生成地形上的间距」。所以：
 * 1. 先按 mask 的连通分量分组 —— 不同分量里的点不互为邻居
 * 2. 同分量的每条边再用 maskPath 校验直线本身（分量是拓扑连通，直线照样可能穿海）
 */

export interface MeshPoint {
  x: number
  z: number
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export interface MeshEdge {
  x0: number
  z0: number
  x1: number
  z1: number
  length: number
  crosses: boolean
  reason: "none" | "water" | "steep"
}

export interface MeshOptions {
  /** 连线上连续多少个不可用 tile 判为地形带 */
  maxBadTiles: number
  /** 两端跳过的方块数下限（避免采样点踩在湖自身上） */
  minSkip: number
}

export interface MeshComponentStat {
  /** 该分量包含的可用 tile 数 */
  tiles: number
  /** 落在该分量的点数 */
  points: number
}

export interface MeshBuild {
  /** 全部边（含被剔除的），供可视化绘制 */
  edges: MeshEdge[]
  /** 通过地形校验的边长（方块） */
  keptLengths: number[]
  rejected: number
  rejectByReason: { water: number, steep: number }
  /** 有 >= 2 个点的分量数（真正能连边的） */
  componentsWithMesh: number
  /** 只有 1 个点的分量数（区域内孤立） */
  componentsSingle: number
  /** 不属于任何可用分量的点数 */
  unassigned: number
  /** 每个含点分量的规模（按 tile 数降序，最多 10 个） */
  components: MeshComponentStat[]
  /** 分量内含点数分布（降序，最多 10 个） */
  pointsPerComponent: number[]
}

/** 按 mask 分量分组，组内建 Delaunay 三角网并逐边做地形校验 */
export function buildComponentMesh(
  terrain: TerrainIndex,
  mask: TerrainMask,
  points: MeshPoint[],
  opts: MeshOptions,
): MeshBuild {
  const byComp = new Map<number, number[]>()
  let unassigned = 0
  for (let i = 0; i < points.length; i++) {
    const comp = mask.componentOfRegion(points[i])
    if (comp < 0) { unassigned++; continue }
    const arr = byComp.get(comp)
    if (arr) arr.push(i)
    else byComp.set(comp, [i])
  }

  const tileCount = new Map(mask.components.map(c => [c.id, c.tiles]))
  const edges: MeshEdge[] = []
  const keptLengths: number[] = []
  const components: MeshComponentStat[] = []
  const pointsPerComponent: number[] = []
  let componentsWithMesh = 0
  let componentsSingle = 0
  let rejected = 0
  const rejectByReason = { water: 0, steep: 0 }

  for (const [cid, idxs] of byComp) {
    pointsPerComponent.push(idxs.length)
    components.push({ tiles: tileCount.get(cid) ?? 0, points: idxs.length })
    if (idxs.length < 2) { componentsSingle++; continue }
    componentsWithMesh++

    const pts = idxs.map(i => ({ x: points[i].x, z: points[i].z }))
    for (const e of delaunayEdges(pts)) {
      const a = pts[e.a], b = pts[e.b]
      // 湖本身有面积，起点附近的采样必然踩在湖盆上（那里可能是陡的）
      const skip = Math.max(opts.minSkip, Math.ceil(e.length / 4))
      const chk = maskPath(mask, terrain, a.x, a.z, b.x, b.z, { skip, maxBadTiles: opts.maxBadTiles })
      edges.push({ x0: a.x, z0: a.z, x1: b.x, z1: b.z, length: e.length, crosses: chk.crosses, reason: chk.reason })
      if (chk.crosses) {
        rejected++
        if (chk.reason === "water") rejectByReason.water++
        else rejectByReason.steep++
        continue
      }
      keptLengths.push(e.length)
    }
  }

  pointsPerComponent.sort((a, b) => b - a)
  components.sort((a, b) => b.tiles - a.tiles)

  return {
    edges,
    keptLengths,
    rejected,
    rejectByReason,
    componentsWithMesh,
    componentsSingle,
    unassigned,
    components: components.slice(0, 10),
    pointsPerComponent: pointsPerComponent.slice(0, 10),
  }
}

export interface EdgeSummary {
  count: number
  meanBlocks: number | null
  meanChunks: number | null
  medianBlocks: number | null
  medianChunks: number | null
  minBlocks: number | null
  maxBlocks: number | null
  /** 分位数（方块）：凸包边会拉长均值，判断主体间距看 p50/p75 */
  quantiles: { p25: number | null, p50: number | null, p75: number | null, p90: number | null }
  /** 边长分布（区块） */
  histogram: { range: string, edges: number }[]
}

const BUCKETS = ["0-4", "4-8", "8-12", "12-16", "16-24", "24-32", "32+"] as const

const bucketOf = (blocks: number): string => {
  const c = blocks / 16
  if (c < 4) return "0-4"
  if (c < 8) return "4-8"
  if (c < 12) return "8-12"
  if (c < 16) return "12-16"
  if (c < 24) return "16-24"
  if (c < 32) return "24-32"
  return "32+"
}

const round = (v: number, digits: number) => Number(v.toFixed(digits))

/** 边长的均值 / 中位 / 分位数 / 分桶分布 */
export function summarizeEdges(lengths: number[]): EdgeSummary {
  const n = lengths.length
  if (!n) {
    return {
      count: 0, meanBlocks: null, meanChunks: null, medianBlocks: null, medianChunks: null,
      minBlocks: null, maxBlocks: null,
      quantiles: { p25: null, p50: null, p75: null, p90: null },
      histogram: BUCKETS.map(range => ({ range, edges: 0 })),
    }
  }
  const sorted = [...lengths].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  const mid = n >> 1
  const med = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const quantile = (q: number) => round(sorted[Math.min(n - 1, Math.floor(q * (n - 1)))], 1)

  const hist = new Map<string, number>()
  for (const l of lengths) {
    const k = bucketOf(l)
    hist.set(k, (hist.get(k) ?? 0) + 1)
  }

  return {
    count: n,
    meanBlocks: round(sum / n, 1),
    meanChunks: round(sum / n / 16, 2),
    medianBlocks: round(med, 1),
    medianChunks: round(med / 16, 2),
    minBlocks: round(sorted[0], 1),
    maxBlocks: round(sorted[n - 1], 1),
    quantiles: { p25: quantile(0.25), p50: quantile(0.5), p75: quantile(0.75), p90: quantile(0.9) },
    histogram: BUCKETS.map(range => ({ range, edges: hist.get(range) ?? 0 })),
  }
}
