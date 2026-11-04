import type { Area } from "../lib/config.js"

/**
 * 判断区块是否落在选区内。
 * - square：切比雪夫距离（Chunky 的 square 就是方形，不是欧氏圆形）
 * - circle：欧氏距离
 * 判定用「区块矩形与选区相交」，比只看区块中心更接近 Chunky 实际处理的数量。
 */
export function chunkInArea(cx: number, cz: number, area: Area): boolean {
  if (area.chunkBounds) {
    const b = area.chunkBounds
    return cx >= b.minX && cx <= b.maxX && cz >= b.minZ && cz <= b.maxZ
  }
  const x0 = cx * 16, z0 = cz * 16
  const x1 = x0 + 15, z1 = z0 + 15
  const [ax, az] = area.center

  // 中心点到区块矩形的最短距离（按轴分开算）
  const dx = ax < x0 ? x0 - ax : ax > x1 ? ax - x1 : 0
  const dz = az < z0 ? z0 - az : az > z1 ? az - z1 : 0

  if (area.shape === "square") {
    // 方形：任一轴超出 radius 即不在范围内（切比雪夫）
    return dx <= area.radius && dz <= area.radius
  }
  return Math.hypot(dx, dz) <= area.radius
}

export function describeArea(area: Area): string {
  const [x, z] = area.center
  const box = area.chunkBounds
  const suffix = box ? ` chunks=[${box.minX}..${box.maxX}]x[${box.minZ}..${box.maxZ}]` : ""
  return `${area.shape} center=${x},${z} r=${area.radius}${suffix}`
}

/** 估算选区覆盖的区块数，用于和 Chunky 的 processed 数对照 */
export function estimateAreaChunks(area: Area): number {
  const rChunks = Math.ceil(area.radius / 16) + 2
  const cx = Math.floor(area.center[0] / 16)
  const cz = Math.floor(area.center[1] / 16)
  let n = 0
  for (let x = cx - rChunks; x <= cx + rChunks; x++) {
    for (let z = cz - rChunks; z <= cz + rChunks; z++) {
      if (chunkInArea(x, z, area)) n++
    }
  }
  return n
}
