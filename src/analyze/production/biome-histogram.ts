import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"

/**
 * 生物群系直方图：分地表、地下两层。
 *
 * 地表：每列从高往低找第一个非空气方块（含水），取该位置的群系。
 * 地下：每列一票——从地表往下扫 4×4×4 群系单元（群系以单元为最小粒度，
 *       按世界坐标 4 对齐），第一个与地表不同的群系就是这一列的结论；一列都没有不同的归入「其他」。
 * 只对主世界分层；下界/末地没有地表概念，只出单层。
 */
const AIR = 0

const analyzer: AnalyzerModule = {
  name: "biome-histogram",
  description: "地表与地下两层生物群系占比（地下每列一票）",
  units: { share: "percent" },
  parallelCost: 3.2,
  create(): Analyzer {
    const surface = new Map<string, number>()
    const underground = new Map<string, number>()
    let chunks = 0
    let columns = 0
    let sampled = 0
    let same = 0
    let dimension = "overworld"

    const bump = (map: Map<string, number>, id: string) => map.set(id, (map.get(id) ?? 0) + 1)

    const toList = (map: Map<string, number>, total: number) =>
      [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => ({ id, cells: n, share: n / (total || 1) * 100 }))

    return {
      name: "biome-histogram",
      onRegion(session) {
        dimension = session.dimension
      },
      async onChunk(c: ChunkHandle) {
        // 空气 proto-chunk 的群系 palette 是占位值（实测为 plains），会污染占比，
        // 所以按"整块没有方块"剔除；注意不能用 grid.empty（海平面那层本来就是空气）。
        const ext = await c.extent()
        if (!ext) return
        const grid = await c.grid({ yMin: ext.bottom, yMax: ext.top })
        const h = ext.top - ext.bottom + 1
        if (h <= 0 || grid.biomes.grid.length !== h * 256) return
        chunks++

        const layered = dimension === "overworld"

        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            const col = z * 16 + x

            // 地表：该列最高的非空气方块（水算地表）
            let topOff = -1
            for (let yi = h - 1; yi >= 0; yi--) {
              if (grid.grid[yi * 256 + col] !== AIR) { topOff = yi; break }
            }
            if (topOff < 0) continue
            const sIdx = grid.biomes.grid[topOff * 256 + col]
            if (!sIdx) continue
            const sBiome = grid.biomes.palette[sIdx - 1]
            if (!sBiome) continue
            columns++
            bump(surface, sBiome)

            // 地下（每列一票）：从浅到深扫 4³ 单元，第一个不同的群系就是该列结论
            if (!layered) continue
            sampled++
            let verdict: string | null = null
            for (let off = Math.floor((topOff - 1) / 4) * 4; off >= 0; off -= 4) {
              const uIdx = grid.biomes.grid[off * 256 + col]
              if (!uIdx) continue
              const uBiome = grid.biomes.palette[uIdx - 1]
              if (!uBiome || uBiome === sBiome) continue
              verdict = uBiome
              break
            }
            if (verdict) bump(underground, verdict)
            else same++
          }
        }
      },
      finalize() {
        return {
          chunks,
          columns,
          surface: {
            uniqueBiomes: surface.size,
            biomes: toList(surface, columns),
          },
          underground: {
            /** 只对主世界分层 */
            dimensions: ["overworld"],
            /** 口径：每列一票，列内按 4³ 单元从浅到深找第一个与地表不同的群系 */
            unit: "column (4x4x4 cell scan)",
            /** 参与判定的列数 */
            columns: sampled,
            /** 地下与地表不同的列数 */
            differing: sampled - same,
            /** 整列都与地表相同、归入「其他」的列 */
            sameAsSurface: {
              columns: same,
              share: same / (sampled || 1) * 100,
            },
            uniqueBiomes: underground.size,
            biomes: toList(underground, sampled),
          },
        }
      },
    }
  },
  format(result) {
    const r = result as {
      columns: number
      surface: { uniqueBiomes: number, biomes: { id: string, share: number }[] }
      underground: { columns: number, differing: number, sameAsSurface: { columns: number, share: number }, uniqueBiomes: number, biomes: { id: string, share: number }[] }
    }
    const u = r.underground
    const f3 = (v: number) => v.toFixed(3)
    return [
      `地表 列数 ${r.columns}，群系 ${r.surface.uniqueBiomes} 个`,
      ...r.surface.biomes.slice(0, 8).map(b => `  ${b.id.padEnd(34)} ${f3(b.share).padStart(7)}%`),
      u.columns
        ? `地下（仅主世界，每列一票） 列数 ${u.columns}，与地表不同 ${u.differing}（${(100 - u.sameAsSurface.share).toFixed(2)}%），群系 ${u.uniqueBiomes} 个`
        : "地下：没有样本（非主世界）",
      ...(u.columns
        ? [
            ...u.biomes.slice(0, 8).map(b => `  ${b.id.padEnd(34)} ${f3(b.share).padStart(7)}%`),
            `  ${"其他(与地表相同)".padEnd(34)} ${f3(u.sameAsSurface.share).padStart(7)}%`,
          ]
        : []),
    ]
  },
}

export default analyzer
