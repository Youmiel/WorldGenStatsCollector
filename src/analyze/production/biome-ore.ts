import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"
import { packXZ } from "../terrain.js"
import { DEFAULT_ORES, oreFamily } from "./ore-exposure.js"

/**
 * 群系矿物统计：某矿「在这个群系里有多富集」。
 *
 * 与 ore-exposure 的分工：
 * - ore-exposure 测的是暴露（挖掉后露出来多少），用于判断「挖矿时能看见多少」；
 * - 本分析器只数矿石方块总数，不做暴露判定 —— 下游用它算「玩家会在哪个群系专门去挖这种矿」，
 *   暴露与否是开采过程的结果，不是「去哪挖」的依据。
 *
 * 口径：
 * - 群系 = 该列地表（最高的非空气方块）处的群系，与 biome-histogram / biome-patch 同口径。
 * - 矿石方块按它所在 (x, z) 列的地表群系归属 —— 即「站在这个群系的表面往下挖能挖到什么」。
 * - 分母 = 该群系的等效区块数 columns / 256（一列 = 1 方块²，256 列 = 1 区块面积）。
 *   不用「包含该群系的区块数」作分母：一个只占 3 列的群系按整块区块除会把密度稀释掉。
 *   同时给出 `chunks`（包含该群系列的原区块数），供下游判断覆盖范围与可靠度。
 * - `reliable` = chunks >= minChunks（默认 200）。不可靠的群系只列非零矿种，
 *   可靠的群系把全部矿种都列出来（真测到 0 就写 0），两者语义不同，不要混。
 * - 矿石同时给精确 id（含 deepslate 变体）与家族汇总（deepslate_ 前缀合并）。
 *
 * params:
 *   ores?: string[]      自定义矿种列表（默认与原版主世界 + 下界一致）
 *   yMin?, yMax?: number 只统计该高度范围内的矿石方块
 *   minChunks?: number   可靠度阈值（默认 200）
 *   top?: number         控制台摘要列出的群系数（默认 10），不影响产物
 */

const KEY = "biome-ore"
const DEFAULT_MIN_CHUNKS = 200
const DEFAULT_TOP = 10
/** 一列 = 1 方块²，一个区块 16×16 = 256 列 */
const COLUMNS_PER_CHUNK = 256

interface OreStat {
  count: number
  /** 该群系每区块（面积折算）平均数量；分母 = columns / 256 */
  avgPerChunk: number
}

const analyzer: AnalyzerModule = {
  name: KEY,
  description: "按地表群系统计矿石数量：每个群系里各矿种的每区块平均（不做暴露判定）",
  units: { density: "per_chunk", count: "block", area: "block^2" },
  create(params): Analyzer {
    const p = (params[KEY] ?? {}) as Record<string, unknown>
    const oreSet = new Set(
      ((p.ores as string[] | undefined) ?? DEFAULT_ORES).map(o => (o.includes(":") ? o : `minecraft:${o}`)),
    )
    const yMin = p.yMin as number | undefined
    const yMax = p.yMax as number | undefined
    const minChunks = Math.max(1, Math.trunc(Number(p.minChunks) || DEFAULT_MIN_CHUNKS))
    const top = Math.max(1, Math.trunc(Number(p.top) || DEFAULT_TOP))

    /** 群系 id ↔ 内部编号（0 保留给「无数据」） */
    const palette = new Map<string, number>()
    const ids: string[] = [""]
    const idOf = (id: string): number => {
      let i = palette.get(id)
      if (i === undefined) {
        ids.push(id)
        i = ids.length - 1
        palette.set(id, i)
      }
      return i
    }

    /** 群系 → 地表列数 */
    const columns = new Map<number, number>()
    /** 群系 → 含该群系列的原区块（packed cx/cz），用于 chunks 与 reliable */
    const chunkSets = new Map<number, Set<number>>()
    /** 群系 → 矿种 id → 数量 */
    const oreCounts = new Map<number, Map<string, number>>()
    /** 群系 → 矿种家族 → 数量 */
    const familyCounts = new Map<number, Map<string, number>>()

    let chunks = 0
    let totalColumns = 0
    let oreBlocks = 0

    const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)

    return {
      name: KEY,
      async onChunk(c: ChunkHandle) {
        const ext = await c.extent()
        if (!ext) return
        const grid = await c.grid({ yMin: ext.bottom, yMax: ext.top })
        const h = ext.top - ext.bottom + 1
        if (h <= 0 || grid.grid.length !== h * COLUMNS_PER_CHUNK) return
        chunks++

        // 每列的地表群系：从高往低找第一个非空气方块（水算方块，与 biome-histogram 同口径）
        const colBiome = new Uint16Array(COLUMNS_PER_CHUNK)
        const seen = new Set<number>()
        for (let col = 0; col < COLUMNS_PER_CHUNK; col++) {
          let topOff = -1
          for (let yi = h - 1; yi >= 0; yi--) {
            if (grid.grid[yi * COLUMNS_PER_CHUNK + col] !== 0) { topOff = yi; break }
          }
          if (topOff < 0) continue
          const bIdx = grid.biomes.grid[topOff * COLUMNS_PER_CHUNK + col]
          if (!bIdx) continue
          const bId = grid.biomes.palette[bIdx - 1]
          if (!bId) continue
          const id = idOf(bId)
          colBiome[col] = id
          seen.add(id)
          totalColumns++
        }
        if (!seen.size) return

        for (const b of seen) {
          let set = chunkSets.get(b)
          if (!set) { set = new Set(); chunkSets.set(b, set) }
          set.add(packXZ(c.x, c.z))
        }
        for (let col = 0; col < COLUMNS_PER_CHUNK; col++) {
          const b = colBiome[col]
          if (b) columns.set(b, (columns.get(b) ?? 0) + 1)
        }

        // 矿种在 palette 中的索引 → 快速判定标记（避免内层循环做字符串比较）
        const isOre = new Uint8Array(grid.palette.length + 1)
        for (let i = 0; i < grid.palette.length; i++) {
          if (oreSet.has(grid.palette[i].id)) isOre[i + 1] = 1
        }
        let anyOre = false
        for (let i = 1; i < isOre.length; i++) if (isOre[i]) { anyOre = true; break }
        if (!anyOre) return

        const minY = ext.bottom
        for (let i = 0; i < grid.grid.length; i++) {
          const v = grid.grid[i]
          if (!isOre[v]) continue
          const col = i & 255
          const b = colBiome[col]
          // 该列没有地表（空列）→ 无法归属群系，跳过；不要臆造一个「未知群系」
          if (!b) continue
          const y = minY + (i >> 8)
          if (yMin !== undefined && y < yMin) continue
          if (yMax !== undefined && y > yMax) continue
          const oreId = grid.palette[v - 1].id
          oreBlocks++
          let byOre = oreCounts.get(b)
          if (!byOre) { byOre = new Map(); oreCounts.set(b, byOre) }
          bump(byOre, oreId)
          let byFam = familyCounts.get(b)
          if (!byFam) { byFam = new Map(); familyCounts.set(b, byFam) }
          bump(byFam, oreFamily(oreId))
        }
      },
      finalize() {
        const oreIds = [...oreSet].sort()
        const families = [...new Set(oreIds.map(oreFamily))].sort()

        const biomes = [...columns.entries()]
          .sort((a, b) => b[1] - a[1] || ids[a[0]].localeCompare(ids[b[0]]))
          .map(([b, cols]) => {
            const chunkCount = chunkSets.get(b)?.size ?? 0
            const reliable = chunkCount >= minChunks
            const chunkEquivalent = cols / COLUMNS_PER_CHUNK
            const byOre = oreCounts.get(b)
            const byFam = familyCounts.get(b)

            const oreStat = (count: number): OreStat => ({
              count,
              avgPerChunk: chunkEquivalent > 0 ? count / chunkEquivalent : 0,
            })

            // 可靠的群系把全部矿种列出来（真测到 0 写 0）；不可靠的只列非零，
            // 免得把「没测到」伪装成 0
            const ores: Record<string, OreStat> = {}
            for (const id of oreIds) {
              const n = byOre?.get(id) ?? 0
              if (!n && !reliable) continue
              ores[id] = oreStat(n)
            }
            const fams: Record<string, OreStat> = {}
            for (const f of families) {
              const n = byFam?.get(f) ?? 0
              if (!n && !reliable) continue
              fams[f] = oreStat(n)
            }

            return {
              id: ids[b],
              columns: cols,
              chunkEquivalent,
              chunks: chunkCount,
              reliable,
              oreBlocks: [...(byOre?.values() ?? [])].reduce((a, n) => a + n, 0),
              ores,
              families: fams,
            }
          })

        return {
          chunks,
          columns: totalColumns,
          minChunks,
          top,
          reliableBiomes: biomes.filter(b => b.reliable).length,
          oreBlocks,
          biomes,
          note: "群系取该列地表（最高非空气方块）处的群系，与 biome-histogram 同口径；矿石按所在列的地表群系归属；avgPerChunk 的分母是该群系的等效区块数 = 地表列数/256，不是包含该群系的区块数（chunks 字段另有给出）；reliable = chunks >= minChunks，不可靠群系只列非零矿种，可靠群系列出全部矿种（真 0 写 0）；families 把 deepslate_ 前缀合并、无命名空间前缀",
        }
      },
    }
  },
  format(result) {
    const r = result as {
      chunks: number
      columns: number
      minChunks: number
      top?: number
      reliableBiomes: number
      biomes: {
        id: string
        columns: number
        chunkEquivalent: number
        chunks: number
        reliable: boolean
        families: Record<string, { count: number, avgPerChunk: number }>
      }[]
    }
    if (!r.biomes?.length) return ["没有可统计的列"]
    const top = r.top ?? DEFAULT_TOP
    const lines = [
      `区块 ${r.chunks}，地表列 ${r.columns}，群系 ${r.biomes.length} 个（可靠 ${r.reliableBiomes} 个，阈值 ${r.minChunks} 区块）`,
    ]

    const renderBiome = (b: (typeof r.biomes)[number]) => {
      // 只显示每区块 >= 0.01 的矿种，避免 19 个零值淹没重点
      const fams = Object.entries(b.families)
        .filter(([, v]) => v.avgPerChunk >= 0.01)
        .sort((a, c) => c[1].avgPerChunk - a[1].avgPerChunk)
        .slice(0, 6)
        .map(([f, v]) => `${f} ${v.avgPerChunk.toFixed(2)}`)
      const flag = b.reliable ? "" : "  [样本不足]"
      lines.push(`  ${b.id.padEnd(34)} ${String(b.chunks).padStart(6)} 区块${flag}`)
      lines.push(`    ${fams.join("  ") || "(无矿石)"}`)
    }

    for (const b of r.biomes.slice(0, top)) renderBiome(b)

    // 面积小但「某种矿明显比世界平均富集」的群系（恶地金矿、山地绿宝石这类）会被面积排序挤出前几名，
    // 而它们正是「该去哪挖某种矿」的答案。按相对全局均值的最大倍率排序，避免只挑到矿石绝对量大、
    // 但只是因为地形高低差异而变多的群系。
    const totalEquiv = r.biomes.reduce((a, b) => a + b.chunkEquivalent, 0)
    const globalFam = new Map<string, number>()
    for (const b of r.biomes) {
      for (const [f, v] of Object.entries(b.families)) globalFam.set(f, (globalFam.get(f) ?? 0) + v.count)
    }
    const globalAvg = (f: string) => {
      const n = globalFam.get(f) ?? 0
      return totalEquiv > 0 ? n / totalEquiv : 0
    }
    const enrichment = (b: (typeof r.biomes)[number]) => {
      let best: { f: string, ratio: number } | null = null
      for (const [f, v] of Object.entries(b.families)) {
        const g = globalAvg(f)
        if (g <= 0 || v.avgPerChunk <= 0) continue
        const ratio = v.avgPerChunk / g
        if (!best || ratio > best.ratio) best = { f, ratio }
      }
      return best
    }

    const shown = new Set(r.biomes.slice(0, top))
    const highlights = r.biomes
      .filter(b => !b.reliable && !shown.has(b))
      .map(b => ({ b, best: enrichment(b) }))
      .filter((x): x is { b: (typeof r.biomes)[number], best: { f: string, ratio: number } } => x.best !== null && x.best.ratio >= 1.5)
      .sort((a, c) => c.best.ratio - a.best.ratio)
      .slice(0, 3)
    if (highlights.length) {
      lines.push("  — 样本不足但有富集的群系（倍率 = 相对全局每区块平均）—")
      for (const x of highlights) {
        renderBiome(x.b)
        lines.push(`    ↑ ${x.best.f} ${x.best.ratio.toFixed(1)}x`)
      }
    }

    // 反向视角：每种矿「该去哪个群系挖」。倍率是相对全局每区块平均。
    const famRank = [...globalFam.entries()].sort((a, c) => c[1] - a[1]).slice(0, 8)
    const bestLines: string[] = []
    for (const [f] of famRank) {
      let best: { id: string, avg: number, reliable: boolean, chunks: number } | null = null
      for (const b of r.biomes) {
        const v = b.families[f]?.avgPerChunk ?? 0
        if (v > 0 && (!best || v > best.avg)) best = { id: b.id, avg: v, reliable: b.reliable, chunks: b.chunks }
      }
      if (!best) continue
      const g = globalAvg(f)
      const ratio = g > 0 ? best.avg / g : 0
      // 小群系常常样本不足，直接标出实际区块数，便于判断这个倍率能信多少
      const tag = best.reliable ? "" : `  [${best.chunks} 区块，样本不足]`
      bestLines.push(
        `  ${f.padEnd(14)} ${best.id.padEnd(32)} ${best.avg.toFixed(2).padStart(7)}/区块  ${ratio.toFixed(1)}x${tag}`,
      )
    }
    if (bestLines.length) {
      lines.push("  — 各矿种最富集的群系（x = 相对全局每区块平均）—")
      lines.push(...bestLines)
    }
    return lines
  },
}

export default analyzer
