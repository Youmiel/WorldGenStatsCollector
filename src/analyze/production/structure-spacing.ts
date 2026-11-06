import type { Analyzer, AnalyzerContext, AnalyzerModule, ChunkHandle } from "../types.js"
import { loadStructureSets, type StructureSetIndex } from "../../lib/structure-sets.js"

/**
 * 结构间距：按结构集合（structure_set）统计各集合里结构起点之间的平均最近邻距离。
 *
 * 数据来自区块 NBT 的 structures.starts——reader 的 world.chunk() 会丢掉这个根键，
 * 所以走 ChunkHandle.rawNbt() 自己解析 region。
 * 集合定义（含 placement.spacing / separation）从原版服务端 jar 的数据包里读，
 * 读不到时按结构 id 单独归组。
 *
 * params:
 *   sets?: string[]  只看这些集合（可写 villages 或 minecraft:villages）
 */

interface Point { x: number, z: number }
interface Group {
  set: string
  dimension: string
  known: boolean
  ids: Set<string>
  points: Point[]
}
interface Bounds { minX: number, maxX: number, minZ: number, maxZ: number }

const KEY = "structure-spacing"

/** 最近邻距离（方块）：每个点到同集合其它起点的最小距离 */
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

const analyzer: AnalyzerModule = {
  name: KEY,
  description: "按结构集合统计结构起点之间的平均间距（方块/区块）",
  units: { distance: "block", spacing: "chunk" },
  create(params): Analyzer {
    const p = (params[KEY] ?? {}) as { sets?: unknown }
    const only = Array.isArray(p.sets)
      ? new Set(p.sets.map(s => {
          const id = String(s)
          return id.includes(":") ? id : `minecraft:${id}`
        }))
      : null

    const groups = new Map<string, Group>()
    const bounds = new Map<string, Bounds>()
    let chunks = 0
    let starts = 0
    let dimension = "overworld"
    let indexPromise: Promise<StructureSetIndex> | null = null
    let warnedNoJar = false

    const ensureIndex = (ctx: AnalyzerContext) => {
      indexPromise ??= loadStructureSets(ctx.runtime.serverJar)
      return indexPromise
    }

    return {
      name: KEY,
      onRegion(session) {
        dimension = session.dimension
      },
      async onChunk(c: ChunkHandle, ctx) {
        chunks++
        const b = bounds.get(dimension) ?? { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
        b.minX = Math.min(b.minX, c.x); b.maxX = Math.max(b.maxX, c.x)
        b.minZ = Math.min(b.minZ, c.z); b.maxZ = Math.max(b.maxZ, c.z)
        bounds.set(dimension, b)

        const nbt = await c.rawNbt(["structures"])
        const st = nbt?.structures as { starts?: Record<string, { ChunkX?: unknown, ChunkZ?: unknown }> } | undefined
        const startsObj = st?.starts
        if (!startsObj) return

        const index = await ensureIndex(ctx)
        if (!index.sets.length && !warnedNoJar) {
          warnedNoJar = true
          ctx.log(ctx.runtime.serverJar ? "结构集合表为空，按结构 id 归组" : "没有原版服务端 jar，按结构 id 归组")
        }

        for (const [id, s] of Object.entries(startsObj)) {
          const set = index.byStructure.get(id)
          const setId = set?.id ?? id
          if (only && !only.has(setId)) continue
          const cx = typeof s?.ChunkX === "number" ? s.ChunkX : c.x
          const cz = typeof s?.ChunkZ === "number" ? s.ChunkZ : c.z
          const key = `${dimension}|${setId}`
          let g = groups.get(key)
          if (!g) {
            g = { set: setId, dimension, known: Boolean(set), ids: new Set(), points: [] }
            groups.set(key, g)
          }
          g.ids.add(id)
          g.points.push({ x: cx * 16 + 8, z: cz * 16 + 8 })
          starts++
        }
      },
      async finalize(ctx) {
        const index = await ensureIndex(ctx)
        const rows = [...groups.values()].sort((a, b) => a.dimension.localeCompare(b.dimension) || a.set.localeCompare(b.set)).map(g => {
          const set: { spacing: number | null, separation: number | null } | null = index.byStructure.get([...g.ids][0]) ?? null
          const nn = g.points.length >= 2 ? nearestNeighbours(g.points) : []
          const m = mean(nn)
          const med = median(nn)
          const b = bounds.get(g.dimension)!

          // 靠近统计范围边缘的起点，最近的邻居可能在范围外，会把均值抬上去；
          // 用中位间距的 2 倍当边距，把这类点剔除后再算一次。
          const edge = (pt: Point) => Math.min(
            pt.x - b.minX * 16,
            (b.maxX + 1) * 16 - pt.x,
            pt.z - b.minZ * 16,
            (b.maxZ + 1) * 16 - pt.z,
          )
          const width = (b.maxX - b.minX + 1) * 16
          const depth = (b.maxZ - b.minZ + 1) * 16
          // 边距不超过范围的 1/4，否则小区间里一个点都留不下
          const margin = Math.min((med ?? 0) * 2, Math.min(width, depth) * 0.25)
          const keptNN = margin > 0 ? nn.filter((_, i) => edge(g.points[i]) >= margin) : nn
          const trimmedMean = keptNN.length >= 3 ? mean(keptNN) : null

          return {
            set: g.set,
            dimension: g.dimension,
            count: g.points.length,
            setKnown: g.known,
            structureIds: [...g.ids].sort(),
            meanNNBlocks: m,
            meanNNChunks: m === null ? null : m / 16,
            medianNNBlocks: med,
            medianNNChunks: med === null ? null : med / 16,
            minNNBlocks: nn.length ? Math.min(...nn) : null,
            maxNNBlocks: nn.length ? Math.max(...nn) : null,
            trimmed: trimmedMean === null ? null : {
              count: keptNN.length,
              meanNNBlocks: trimmedMean,
              meanNNChunks: trimmedMean / 16,
            },
            configured: set ? { spacingChunks: set.spacing, separationChunks: set.separation } : null,
          }
        })

        return {
          chunks,
          structureStarts: starts,
          groups: rows,
          note: "间距为同集合内每个结构起点到最近起点的距离均值；trimmed 是去掉边界附近起点后的结果（范围受限时更接近真实间距）",
        }
      },
    }
  },
  format(result) {
    const r = result as {
      structureStarts: number
      groups: {
        set: string, dimension: string, count: number, setKnown: boolean,
        meanNNChunks: number | null, meanNNBlocks: number | null, medianNNChunks: number | null,
        trimmed: { count: number, meanNNChunks: number, meanNNBlocks: number } | null,
        configured: { spacingChunks: number | null } | null,
      }[]
    }
    if (!r.structureStarts) return ["没有结构起点"]
    const lines = [`结构起点 ${r.structureStarts}，集合 ${r.groups.length} 个`]
    const head = `  ${"集合".padEnd(30)}${"数量".padStart(6)}${"平均间距(区块)".padStart(16)}${"平均(方块)".padStart(11)}${"中位(区块)".padStart(11)}${"配置".padStart(9)}`
    lines.push(head)
    const fmt = (v: number | null) => (v === null ? "-" : String(Number(v.toFixed(2))))
    let trimmedUsed = false
    for (const g of r.groups) {
      const t = g.trimmed
      if (t) trimmedUsed = true
      const avg = t ? `${fmt(t.meanNNChunks)}*` : fmt(g.meanNNChunks)
      const avgBlocks = t ? `${fmt(t.meanNNBlocks)}*` : fmt(g.meanNNBlocks)
      lines.push(
        `  ${g.set.padEnd(30)}${String(g.count).padStart(6)}${avg.padStart(16)}${avgBlocks.padStart(11)}${fmt(g.medianNNChunks).padStart(11)}${fmt(g.configured?.spacingChunks ?? null).padStart(9)}`,
      )
    }
    if (trimmedUsed) lines.push("  * 已去掉靠近统计范围边缘的起点（邻居可能在范围外）")
    return lines
  },
}

export default analyzer
