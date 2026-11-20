/** 结构起点/地标实例共用的最近邻统计与空间聚类。 */

export interface Point { x: number, z: number }

/** 最近邻距离（方块）：每个点到其它点的最小距离 */
export function nearestNeighbours(points: Point[]): number[] {
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

export function mean(v: number[]): number | null {
  if (!v.length) return null
  return v.reduce((a, b) => a + b, 0) / v.length
}

export function median(v: number[]): number | null {
  if (!v.length) return null
  const s = [...v].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * 分位数：线性插值（R-7）。
 *
 * 选插值而不是「取第 floor(q*(n-1)) 个」，是因为后者在偶数样本下 p50 会等于
 * 较小的那个中间值，与 medianNNBlocks（两中间值的平均）对不上，而验收要求两者一致。
 * 插值版在 q=0.5 时恒等于中位数，且在有序样本上单调，p25 ≤ p50 ≤ p75 ≤ p90 自然成立。
 */
export function quantile(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? sorted[lo] : sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo)
}

/** 样本方差（除以 n-1）：下游常要把它和均值配对做置信区间，总体方差在 n 很小时会偏小 */
export function variance(v: number[]): number | null {
  if (v.length < 2) return null
  const m = mean(v)!
  return v.reduce((a, x) => a + (x - m) * (x - m), 0) / (v.length - 1)
}

/**
 * 分位数/方差需要的最小最近邻样本数。
 *
 * 少于这个数时 p90 只由一两个点决定、方差也没有统计意义，所以字段写 null
 * （不写 0），并给 reliable: false 让下游知道这批数值只能当兜底参考。
 */
export const MIN_QUANTILE_SAMPLES = 10

export interface NNStats {
  count: number
  meanNNBlocks: number | null
  medianNNBlocks: number | null
  quantiles: { p25: number | null, p50: number | null, p75: number | null, p90: number | null }
  varianceNN: number | null
  minNNBlocks: number | null
  maxNNBlocks: number | null
  reliable: boolean
}

/** 一批点位的最近邻距离分布；样本不足时 quantiles/variance 为 null，不填 0 */
export function summariseNN(points: Point[]): NNStats {
  const nn = points.length >= 2 ? nearestNeighbours(points) : []
  const sortedNN = [...nn].sort((a, b) => a - b)
  const enough = sortedNN.length >= MIN_QUANTILE_SAMPLES
  return {
    count: points.length,
    meanNNBlocks: mean(nn),
    medianNNBlocks: median(nn),
    quantiles: enough
      ? { p25: quantile(sortedNN, 0.25), p50: quantile(sortedNN, 0.5), p75: quantile(sortedNN, 0.75), p90: quantile(sortedNN, 0.9) }
      : { p25: null, p50: null, p75: null, p90: null },
    varianceNN: enough ? variance(sortedNN) : null,
    minNNBlocks: nn.length ? Math.min(...nn) : null,
    maxNNBlocks: nn.length ? Math.max(...nn) : null,
    reliable: enough,
  }
}

/**
 * 把离散点按欧氏距离聚类成实例（并查集）。
 *
 * 用于没有 `structures.starts` 的地形特征（沙漠水井）：一个实例的几块可疑方块
 * 彼此相距不超过几格，不同实例之间至少隔一个区块。O(n²) 对地标规模足够。
 */
export function clusterPoints(points: Point[], radius: number): Point[][] {
  const n = points.length
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const r2 = radius * radius
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = points[i].x - points[j].x
      const dz = points[i].z - points[j].z
      if (dx * dx + dz * dz <= r2) union(i, j)
    }
  }
  const buckets = new Map<number, Point[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const a = buckets.get(root)
    if (a) a.push(points[i])
    else buckets.set(root, [points[i]])
  }
  return [...buckets.values()]
}

/** 一组点的平面中心（实例坐标） */
export function centroid(points: Point[]): Point {
  let x = 0, z = 0
  for (const p of points) { x += p.x; z += p.z }
  return { x: x / points.length, z: z / points.length }
}
