import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"

/**
 * 逐区段方块统计：按 16 格高的区段（Y section）统计所有方块 id 的数量与占比。
 *
 * 数据从整块 grid 里取（比 blocks() 便宜），默认不统计空气；
 * 结果文件保留每个区段的完整方块表，控制台只打印每段前三。
 *
 * params: { includeAir?, top? }
 */
interface Section { y: number, total: number, counts: Map<string, number> }

const analyzer: AnalyzerModule = {
  name: "section-block-histogram",
  description: "按 16 格区段统计全部方块占比",
  create(params): Analyzer {
    const p = params["section-block-histogram"] as Record<string, unknown> | undefined
    const includeAir = Boolean(p?.includeAir ?? false)
    const top = Number(p?.top ?? 3)

    const sections = new Map<number, Section>()
    let chunks = 0
    let counted = 0

    return {
      name: "section-block-histogram",
      async onChunk(c: ChunkHandle) {
        const ext = await c.extent()
        if (!ext) return
        const grid = await c.grid({ yMin: ext.bottom, yMax: ext.top })
        const h = ext.top - ext.bottom + 1
        if (h <= 0 || grid.grid.length !== h * 256) return
        chunks++

        for (let yi = 0; yi < h; yi++) {
          const sy = Math.floor((ext.bottom + yi) / 16) * 16
          let s = sections.get(sy)
          if (!s) { s = { y: sy, total: 0, counts: new Map() }; sections.set(sy, s) }

          const base = yi * 256
          for (let i = 0; i < 256; i++) {
            const v = grid.grid[base + i]
            if (v === 0) {
              if (!includeAir) continue
              s.counts.set("minecraft:air", (s.counts.get("minecraft:air") ?? 0) + 1)
              s.total++
              counted++
              continue
            }
            const id = grid.palette[v - 1]?.id
            if (!id) continue
            s.counts.set(id, (s.counts.get(id) ?? 0) + 1)
            s.total++
            counted++
          }
        }
      },
      finalize() {
        const out = [...sections.entries()]
          .sort((a, b) => a[0] - b[0])
          .filter(([, s]) => s.total > 0)
          .map(([sy, s]) => ({
            y: sy,
            yRange: [sy, sy + 15],
            total: s.total,
            blocks: [...s.counts.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([id, n]) => ({ id, count: n, share: Number((n / s.total * 100).toFixed(3)) })),
          }))
        return { chunks, counted, includeAir, top, sections: out }
      },
    }
  },
  format(result) {
    const r = result as {
      chunks: number
      counted: number
      top: number
      sections: { y: number, yRange: [number, number], total: number, blocks: { id: string, share: number }[] }[]
    }
    const lines = [`区块 ${r.chunks}，方块 ${r.counted}，区段 ${r.sections.length} 个`]
    for (const s of r.sections) {
      const top = s.blocks.slice(0, r.top)
        .map(b => `${b.id.replace("minecraft:", "")} ${b.share.toFixed(1)}%`)
        .join("  ")
      lines.push(`  ${`${s.yRange[0]}~${s.yRange[1]}`.padStart(9)}  ${top}`)
    }
    return lines
  },
}

export default analyzer
