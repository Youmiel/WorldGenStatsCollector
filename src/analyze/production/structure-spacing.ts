import type { Analyzer, AnalyzerContext, AnalyzerModule, ChunkHandle } from "../types.js"
import { loadStructureSets, type StructureSetIndex } from "../../lib/structure-sets.js"
import {
  nearestNeighbours,
  mean,
  median,
  quantile,
  variance,
  summariseNN,
  clusterPoints,
  centroid,
  MIN_QUANTILE_SAMPLES,
  type Point,
} from "../nn.js"
import { landmarkOwnerOf, landmarkSetId, LANDMARK_CLUSTER_RADIUS } from "./landmarks.js"

/**
 * 结构间距：按结构集合（structure_set）统计各集合里结构起点之间的平均最近邻距离。
 *
 * 数据来自区块 NBT 的 structures.starts——reader 的 world.chunk() 会丢掉这个根键，
 * 所以走 ChunkHandle.rawNbt() 自己解析 region。
 * 集合定义（含 placement.spacing / separation）从原版服务端 jar 的数据包里读，
 * 读不到时按结构 id 单独归组。
 *
 * 没有 start 的地形特征（沙漠水井）按可疑方块实体聚类成实例，作为独立集合参与
 * 同一套统计——否则这类结构永远没有 nearest_distance / density。
 *
 * params:
 *   sets?: string[]  只看这些集合（可写 villages 或 minecraft:villages）
 */

interface Group {
  set: string
  dimension: string
  known: boolean
  ids: Set<string>
  points: Point[]
}
interface Bounds { minX: number, maxX: number, minZ: number, maxZ: number }

const KEY = "structure-spacing"

const analyzer: AnalyzerModule = {
  name: KEY,
  description: "按结构集合统计结构起点之间的平均间距（方块/区块）",
  units: { distance: "block", spacing: "chunk", density: "per_1000_chunks" },
  // 代价按「独占跑」算：单独跑时要自己解全部区块的 block_entities（实测 ~110s），
  // 串行时看着快只是因为蹭了 structure-interior 的 memo
  parallelCost: 2.2,
  /** 与 structure-interior 共用 structures / block_entities 的解析结果 */
  parallelGroup: "structure-raw-nbt",
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
    /** 没有 structure start 的地形特征：owner → 可疑方块坐标 */
    const landmarkPoints = new Map<string, Point[]>()
    let chunks = 0
    let starts = 0
    let dimension = "overworld"
    let indexPromise: Promise<StructureSetIndex> | null = null
    let warnedNoJar = false

    const ensureIndex = (ctx: AnalyzerContext) => {
      indexPromise ??= loadStructureSets(ctx.runtime.serverJar, ctx.runtime.worldDir)
      return indexPromise
    }

    return {
      name: KEY,
      onRegion(session) {
        dimension = session.dimension
      },
      async onChunk(c: ChunkHandle, ctx) {
        // 空区块（末地中间的虚空、从未生成方块的区块）不计入分母：
        // 结构起点只可能落在有地形的区块里，把虚空算进去会把密度稀释一半。
        // 这与其它分析器的 chunks 口径一致（都等于 rangeByDimension.chunksWithBlocks）。
        if (!(await c.extent())) return
        chunks++
        const b = bounds.get(dimension) ?? { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
        b.minX = Math.min(b.minX, c.x); b.maxX = Math.max(b.maxX, c.x)
        b.minZ = Math.min(b.minZ, c.z); b.maxZ = Math.max(b.maxZ, c.z)
        bounds.set(dimension, b)

        // 地形特征（沙漠水井）没有 structure start，只能从可疑方块的考古战利品表反查。
        // 同一实例的几块可疑方块聚成一组，组中心就是实例坐标。
        const beNbt = await c.rawNbt(["block_entities"])
        const beRaw = beNbt?.block_entities
        if (Array.isArray(beRaw)) {
          for (const raw of beRaw) {
            if (!raw || typeof raw !== "object") continue
            const be = raw as Record<string, unknown>
            const cfg = be.config as { loot_table?: unknown } | undefined
            const loot = typeof be.LootTable === "string" ? be.LootTable : typeof cfg?.loot_table === "string" ? cfg.loot_table : null
            const owner = loot ? landmarkOwnerOf(loot) : null
            if (!owner) continue
            const x = Number(be.x), z = Number(be.z)
            if (!Number.isFinite(x) || !Number.isFinite(z)) continue
            const pts = landmarkPoints.get(owner)
            if (pts) pts.push({ x, z })
            else landmarkPoints.set(owner, [{ x, z }])
          }
        }

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

          // 分布形状：样本够时才给，样本不足一律 null（不填 0）
          const sortedNN = [...nn].sort((a, b) => a - b)
          const enough = sortedNN.length >= MIN_QUANTILE_SAMPLES
          const q = enough
            ? { p25: quantile(sortedNN, 0.25), p50: quantile(sortedNN, 0.5), p75: quantile(sortedNN, 0.75), p90: quantile(sortedNN, 0.9) }
            : { p25: null, p50: null, p75: null, p90: null }

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
            /** 最近邻距离的 p25/p50/p75/p90（方块）；p50 与 medianNNBlocks 相等 */
            quantiles: q,
            /** 最近邻距离的样本方差（方块²） */
            varianceNN: enough ? variance(sortedNN) : null,
            minNNBlocks: nn.length ? Math.min(...nn) : null,
            maxNNBlocks: nn.length ? Math.max(...nn) : null,
            /** 分位数/方差是否可采信：最近邻样本数 >= MIN_QUANTILE_SAMPLES */
            reliable: enough,
            trimmed: trimmedMean === null ? null : {
              count: keptNN.length,
              meanNNBlocks: trimmedMean,
              meanNNChunks: trimmedMean / 16,
            },
            configured: set ? { spacingChunks: set.spacing, separationChunks: set.separation } : null,
            /** 该集合每 1000 个已扫描（有地形）区块的实例数；游荡撞见口径 */
            densityPer1000Chunks: chunks > 0 ? g.points.length / chunks * 1000 : null,
            source: "structure",
          }
        })

        // 地形特征（沙漠水井）与结构同口径：把可疑方块聚成实例，实例中心当作「起点」。
        const landmarkRows = [...landmarkPoints.entries()].map(([owner, pts]) => {
          const setId = landmarkSetId(owner)
          if (only && !only.has(setId)) return null
          const instances = clusterPoints(pts, LANDMARK_CLUSTER_RADIUS).map(centroid)
          const s = summariseNN(instances)
          return {
            set: setId,
            dimension,
            count: s.count,
            setKnown: false,
            /** 集合里只有一个变体：feature 本身的 id */
            structureIds: [`minecraft:${owner}`],
            meanNNBlocks: s.meanNNBlocks,
            meanNNChunks: s.meanNNBlocks === null ? null : s.meanNNBlocks / 16,
            medianNNBlocks: s.medianNNBlocks,
            medianNNChunks: s.medianNNBlocks === null ? null : s.medianNNBlocks / 16,
            quantiles: s.quantiles,
            varianceNN: s.varianceNN,
            minNNBlocks: s.minNNBlocks,
            maxNNBlocks: s.maxNNBlocks,
            reliable: s.reliable,
            trimmed: null,
            configured: null,
            densityPer1000Chunks: chunks > 0 ? s.count / chunks * 1000 : null,
            /** 聚类用的可疑方块数（一个实例可以有几块） */
            sampleBlocks: pts.length,
            source: "feature",
          }
        }).filter((r): r is NonNullable<typeof r> => r !== null)

        const allRows = [...rows, ...landmarkRows]
          .sort((a, b) => a.dimension.localeCompare(b.dimension) || a.set.localeCompare(b.set))

        return {
          chunks,
          structureStarts: starts,
          /** 地形特征实例数（结构起点之外的「无 start 结构」） */
          landmarkInstances: landmarkRows.reduce((a, r) => a + r.count, 0),
          groups: allRows,
          minQuantileSamples: MIN_QUANTILE_SAMPLES,
          note: "间距为同集合内每个实例到最近实例的距离（含本集合所有变体）；quantiles/varianceNN 是这批距离的分位数（方块，线性插值）与样本方差（方块²，除以 n-1），最近邻样本少于 minQuantileSamples 时为 null 并 reliable=false；maxNNBlocks 恒为实测最大值；densityPer1000Chunks 的分母是本次扫描的有地形区块数；trimmed 是去掉边界附近起点后的均值（范围受限时更接近真实间距）；source=feature 的行是没有 structure start 的地形特征（沙漠水井），由可疑方块的考古战利品表识别、按 LANDMARK_CLUSTER_RADIUS 聚类成实例，sampleBlocks 是聚类用的可疑方块数",
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
        quantiles: { p25: number | null, p50: number | null, p75: number | null, p90: number | null },
        trimmed: { count: number, meanNNChunks: number, meanNNBlocks: number } | null,
        configured: { spacingChunks: number | null } | null,
      }[]
    }
    if (!r.groups.length) return ["没有结构起点"]
    const lines = [`结构起点 ${r.structureStarts}，集合 ${r.groups.length} 个`]
    const head = `  ${"集合".padEnd(30)}${"数量".padStart(6)}${"平均间距(区块)".padStart(16)}${"平均(方块)".padStart(11)}${"中位(区块)".padStart(11)}${"p90(区块)".padStart(11)}${"配置".padStart(9)}`
    lines.push(head)
    const fmt = (v: number | null) => (v === null ? "-" : String(Number(v.toFixed(2))))
    let trimmedUsed = false
    for (const g of r.groups) {
      const t = g.trimmed
      if (t) trimmedUsed = true
      const avg = t ? `${fmt(t.meanNNChunks)}*` : fmt(g.meanNNChunks)
      const avgBlocks = t ? `${fmt(t.meanNNBlocks)}*` : fmt(g.meanNNBlocks)
      const p90 = g.quantiles.p90 === null ? null : g.quantiles.p90 / 16
      lines.push(
        `  ${g.set.padEnd(30)}${String(g.count).padStart(6)}${avg.padStart(16)}${avgBlocks.padStart(11)}${fmt(g.medianNNChunks).padStart(11)}${fmt(p90).padStart(11)}${fmt(g.configured?.spacingChunks ?? null).padStart(9)}`,
      )
    }
    if (trimmedUsed) lines.push("  * 已去掉靠近统计范围边缘的起点（邻居可能在范围外）")
    return lines
  },
}

export default analyzer
