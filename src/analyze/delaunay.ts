/**
 * Delaunay 三角剖分（Bowyer–Watson 增量算法）。
 *
 * 用途：给一组点（岩浆湖组质心）建三角网，取网里的边作为「邻接关系」。
 * 相比最近邻（每点只取一条边，点数 = 边数），三角网的边覆盖整个区域，
 * 平均边长与边长分布对点密度的估计更稳，也不会被局部聚集或孤立点带偏。
 *
 * 点数是几十量级，O(n²) 的实现完全够用，不引入依赖。
 */

export interface Pt { x: number, z: number }

export interface MeshEdge {
  /** 端点在入参数组里的下标 */
  a: number
  b: number
  /** 边长（世界方块） */
  length: number
}

interface Tri { a: number, b: number, c: number }

/** 三角形外接圆；三点共线（退化）返回 null */
function circumcircle(v: Pt[], t: Tri): { x: number, z: number, r2: number } | null {
  const A = v[t.a], B = v[t.b], C = v[t.c]
  const ax = A.x, az = A.z, bx = B.x, bz = B.z, cx = C.x, cz = C.z
  const d = 2 * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz))
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return null
  const a2 = ax * ax + az * az
  const b2 = bx * bx + bz * bz
  const c2 = cx * cx + cz * cz
  const ux = (a2 * (bz - cz) + b2 * (cz - az) + c2 * (az - bz)) / d
  const uz = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  return { x: ux, z: uz, r2: (ax - ux) ** 2 + (az - uz) ** 2 }
}

/**
 * 三角网的所有边（去重，无向）。
 * 少于 2 点返回空；2 点返回一条边；全部共线时返回按坐标排序的相邻链
 * （此时没有三角形，但相邻点的边仍然是有意义的邻接）。
 */
export function delaunayEdges(points: Pt[]): MeshEdge[] {
  const n = points.length
  if (n < 2) return []
  const dist = (i: number, j: number) => Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z)
  if (n === 2) return [{ a: 0, b: 1, length: dist(0, 1) }]

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  const span = Math.max(maxX - minX, maxZ - minZ) || 1
  const midX = (minX + maxX) / 2, midZ = (minZ + maxZ) / 2

  // 超级三角形：三顶点放到远大于点集范围处，保证所有点都在其外接圆内
  const far = 20 * span
  const verts: Pt[] = [
    ...points,
    { x: midX - far, z: midZ - far },
    { x: midX + far, z: midZ - far },
    { x: midX, z: midZ + far },
  ]
  const S1 = n, S2 = n + 1, S3 = n + 2

  let tris: Tri[] = [{ a: S1, b: S2, c: S3 }]

  for (let pi = 0; pi < n; pi++) {
    const px = points[pi].x, pz = points[pi].z
    const bad: Tri[] = []
    const kept: Tri[] = []
    for (const t of tris) {
      const c = circumcircle(verts, t)
      if (!c) { bad.push(t); continue }
      const dx = px - c.x, dz = pz - c.z
      if (dx * dx + dz * dz <= c.r2 + 1e-9) bad.push(t)
      else kept.push(t)
    }

    // 空腔边界 = 只出现在一个 bad 三角形里的边
    const edgeCount = new Map<string, { a: number, b: number, n: number }>()
    const addEdge = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`
      const hit = edgeCount.get(key)
      if (hit) hit.n++
      else edgeCount.set(key, { a, b, n: 1 })
    }
    for (const t of bad) {
      addEdge(t.a, t.b); addEdge(t.b, t.c); addEdge(t.c, t.a)
    }
    const next = kept
    for (const e of edgeCount.values()) {
      if (e.n === 1) next.push({ a: e.a, b: pi, c: e.b })
    }
    tris = next
  }

  const seen = new Set<string>()
  const out: MeshEdge[] = []
  const push = (a: number, b: number) => {
    if (a >= n || b >= n) return   // 含超级三角形顶点，丢弃
    const key = a < b ? `${a},${b}` : `${b},${a}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ a, b, length: dist(a, b) })
  }
  for (const t of tris) {
    push(t.a, t.b); push(t.b, t.c); push(t.c, t.a)
  }

  // 退化兜底：全部共线时上面不会产出任何三角形，改成按坐标排序连成链
  if (!out.length) {
    const order = points.map((p, i) => ({ i, x: p.x, z: p.z }))
      .sort((p, q) => p.x - q.x || p.z - q.z)
    for (let i = 0; i + 1 < order.length; i++) {
      const a = order[i].i, b = order[i + 1].i
      out.push({ a, b, length: dist(a, b) })
    }
  }
  return out
}
