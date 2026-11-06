import { NO_Y, packXZ, unpackX, unpackZ, type TerrainIndex } from "./terrain.js"

/**
 * 合法地形 mask：把「不是水域、坡度也合格」的列压成 tile 网格，
 * 再把可用 tile 求连通分量，得到地理上连成一片的「可生成区」。
 *
 * 为什么需要它：湖泊、结构这类东西在海洋和陡坡上生成不了，
 * 但逐列判定噪声太大（单格树坑、单列水面就会把可用区撕碎），
 * 所以先按 tile 聚合（tile 内可用列占比够高才算可用），再求连通。
 *
 * 两个消费方：
 * - 间距统计：两个湖只有落在同一片可生成区、且连线不穿过不可用地形时才算邻居
 * - 可视化：把不可用区域暗化，一眼看出地形筛选是否符合预期
 */

export interface MaskComponent {
  id: number
  /** 该分量包含的可用 tile 数 */
  tiles: number
}

export interface MaskOptions {
  /** tile 边长（方块）：16 = 1 区块，8 = 1/4 区块 */
  tileSize: number
  /** 坡度阈值：3x3 地面高差 < 该值才算合格 */
  slopeThreshold: number
  /** tile 内可用列占比达到该值才算可用 tile */
  minUsableShare: number
}

export interface TerrainMask {
  tileSize: number
  /** 有地形数据的 tile 数 */
  tiles: number
  /** 其中可用 tile 数 */
  usableTiles: number
  /** 可用 tile 的连通块（按大小降序） */
  components: MaskComponent[]
  /** 某世界坐标所在 tile 的分量 id；-1 = 该 tile 不可用或无数据 */
  componentAt(wx: number, wz: number): number
  /** 该世界坐标所在 tile 是否有地形数据（区分「无数据」与「有数据但不可用」） */
  hasTile(wx: number, wz: number): boolean
  /**
   * bbox 内出现最多的可用分量 id（用于给一整片湖找归属）；
   * bbox 内没有任何可用 tile 时返回 -1。
   */
  componentOfRegion(bbox: { minX: number, maxX: number, minZ: number, maxZ: number }): number
}

/**
 * 构建 mask。
 *
 * tile 可用 = tile 内可用列占比 >= minUsableShare；
 * 分量 = 可用 tile 的 4-连通块。
 */
export function buildMask(terrain: TerrainIndex, opts: MaskOptions): TerrainMask {
  const ts = Math.max(1, Math.trunc(opts.tileSize))
  const acc = new Map<number, { total: number, usable: number }>()

  terrain.eachChunk((cx, cz, t) => {
    for (let i = 0; i < 256; i++) {
      const g = t.groundY[i]
      if (g === NO_Y) continue
      const wx = cx * 16 + (i & 15)
      const wz = cz * 16 + (i >> 4)
      const tk = packXZ(Math.floor(wx / ts), Math.floor(wz / ts))
      let a = acc.get(tk)
      if (!a) { a = { total: 0, usable: 0 }; acc.set(tk, a) }
      a.total++
      if (t.water[i]) continue
      const s = terrain.slope(wx, wz)
      if (s === null) continue
      if (s < opts.slopeThreshold) a.usable++
    }
  })

  const usableTiles = new Set<number>()
  for (const [k, a] of acc) {
    if (a.total > 0 && a.usable / a.total >= opts.minUsableShare) usableTiles.add(k)
  }

  const comp = new Map<number, number>()
  const components: MaskComponent[] = []
  for (const start of usableTiles) {
    if (comp.has(start)) continue
    const id = components.length
    let size = 0
    const queue = [start]
    comp.set(start, id)
    while (queue.length) {
      const cur = queue.pop()!
      size++
      const tx = unpackX(cur), tz = unpackZ(cur)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nk = packXZ(tx + dx, tz + dz)
        if (!usableTiles.has(nk) || comp.has(nk)) continue
        comp.set(nk, id)
        queue.push(nk)
      }
    }
    components.push({ id, tiles: size })
  }
  components.sort((a, b) => b.tiles - a.tiles)

  return new TerrainMaskImpl(ts, acc, comp, components)
}

export type MaskPathReason = "none" | "water" | "steep"

export interface MaskPathResult {
  /** 连线是否被足够长的不可用地形带隔断 */
  crosses: boolean
  reason: MaskPathReason
}

/**
 * 两点连线是否被 mask 的不可用 tile 隔断。
 *
 * 为什么不能只靠「同属一个连通分量」：分量是拓扑连通 —— 陆地可以绕过海洋连成一片，
 * 但两湖之间的直线照样穿海。Delaunay 给的是直线边，所以必须再校验这条线本身。
 *
 * 采样步长取 tileSize / 2，连续 maxBadTiles 个不可用 tile 才判隔断
 * （tile 已聚合过列级噪声，单块不可用 tile 不构成地形带）。
 * 两端各跳过 skip 格，避开湖自身所在的位置。
 *
 * reason 优先报「水域」—— 跨海的边在语义上最该被排除。
 */
export function maskPath(
  mask: TerrainMask,
  terrain: TerrainIndex,
  x0: number, z0: number, x1: number, z1: number,
  opts: { skip?: number, maxBadTiles?: number } = {},
): MaskPathResult {
  const skip = opts.skip ?? 0
  const maxBad = Math.max(1, opts.maxBadTiles ?? 2)
  const dx = x1 - x0, dz = z1 - z0
  const len = Math.hypot(dx, dz)
  if (len <= skip * 2) return { crosses: false, reason: "none" }
  const step = Math.max(1, mask.tileSize / 2)
  const steps = Math.floor(len / step)
  const skipSteps = Math.ceil(skip / step)
  let bad = 0
  let reason: MaskPathReason = "none"
  for (let i = skipSteps; i <= steps - skipSteps; i++) {
    const t = i / steps
    const x = Math.round(x0 + dx * t)
    const z = Math.round(z0 + dz * t)
    if (mask.componentAt(x, z) >= 0) { bad = 0; continue }
    const c = terrain.column(x, z)
    if (c?.water) reason = "water"
    else if (reason !== "water") reason = "steep"
    if (++bad >= maxBad) return { crosses: true, reason }
  }
  return { crosses: false, reason: "none" }
}

class TerrainMaskImpl implements TerrainMask {
  constructor(
    readonly tileSize: number,
    private acc: Map<number, { total: number, usable: number }>,
    private comp: Map<number, number>,
    readonly components: MaskComponent[],
  ) {}

  get tiles(): number {
    return this.acc.size
  }

  get usableTiles(): number {
    return this.comp.size
  }

  componentAt(wx: number, wz: number): number {
    const k = packXZ(Math.floor(wx / this.tileSize), Math.floor(wz / this.tileSize))
    return this.comp.get(k) ?? -1
  }

  hasTile(wx: number, wz: number): boolean {
    return this.acc.has(packXZ(Math.floor(wx / this.tileSize), Math.floor(wz / this.tileSize)))
  }

  componentOfRegion(bbox: { minX: number, maxX: number, minZ: number, maxZ: number }): number {
    const ts = this.tileSize
    const votes = new Map<number, number>()
    for (let tx = Math.floor(bbox.minX / ts); tx <= Math.floor(bbox.maxX / ts); tx++) {
      for (let tz = Math.floor(bbox.minZ / ts); tz <= Math.floor(bbox.maxZ / ts); tz++) {
        const c = this.comp.get(packXZ(tx, tz))
        if (c === undefined) continue
        votes.set(c, (votes.get(c) ?? 0) + 1)
      }
    }
    let best = -1, bestN = 0
    for (const [c, n] of votes) if (n > bestN) { best = c; bestN = n }
    return best
  }
}
