import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"

/**
 * 逐区段方块统计：按 16 格高的区段（Y section）统计所有方块 id 的**每区块平均数量**与占比。
 *
 * 数据从整块 grid 里取（比 blocks() 便宜），默认不统计空气；
 * 平均值分母是「包含该区段的区块数」，不同高度的区块混在一起也不会把均值拉低。
 * 结果文件保留每个区段的完整方块表，控制台只打印每段前三。
 *
 * params: { includeAir?, top? }
 */
interface Section { y: number, chunks: number, total: number, counts: Uint32Array }

/** 每区块（或每区段）平均。产物保留原始浮点，取整只在 format 里做 */
const avg = (n: number, denom: number) => (denom > 0 ? n / denom : 0)

const analyzer: AnalyzerModule = {
  name: "section-block-histogram",
  description: "按 16 格区段统计全部方块的每区块平均数量与占比",
  units: { sectionDensity: "per_chunk_per_section", share: "percent" },
  parallelCost: 1.0,
  create(params): Analyzer {
    const p = params["section-block-histogram"] as Record<string, unknown> | undefined
    const includeAir = Boolean(p?.includeAir ?? false)
    const top = Number(p?.top ?? 3)

    const sections = new Map<number, Section>()
    /**
     * 全局方块编号：逐方块用字符串 Map 计数是这里的主要开销（主世界约 4.6 亿次 Map.set）。
     * 每个区块的色板先映射到全局编号，之后计数就只是 Uint32Array 自增。
     */
    const globalIds = new Map<string, number>()
    const globalNames: string[] = []
    let idCount = 0
    const idOf = (id: string): number => {
      let i = globalIds.get(id)
      if (i === undefined) {
        i = idCount++
        globalIds.set(id, i)
        globalNames.push(id)
      }
      return i
    }

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

        // 色板 → 全局编号（+1 是因为 grid 的 0 表示空气）
        const pal = new Uint32Array(grid.palette.length + 1)
        for (let i = 0; i < grid.palette.length; i++) pal[i + 1] = idOf(grid.palette[i].id)
        const airId = includeAir ? idOf("minecraft:air") : -1

        // 同一区段在一个区块里会出现多行，只记一次分母
        const seen = new Set<number>()
        for (let yi = 0; yi < h; yi++) {
          const sy = Math.floor((ext.bottom + yi) / 16) * 16
          let s = sections.get(sy)
          if (!s) {
            s = { y: sy, chunks: 0, total: 0, counts: new Uint32Array(0) }
            sections.set(sy, s)
          }
          if (!seen.has(sy)) { seen.add(sy); s.chunks++ }
          if (s.counts.length < idCount) {
            const grown = new Uint32Array(idCount)
            grown.set(s.counts)
            s.counts = grown
          }

          const base = yi * 256
          const counts = s.counts
          let added = 0
          for (let i = 0; i < 256; i++) {
            const v = grid.grid[base + i]
            if (v === 0) {
              if (airId < 0) continue
              counts[airId]++
              added++
              continue
            }
            const gid = pal[v]
            // 越界的调色板索引说明区块数据异常，跳过而不是记到 0 号上
            if (gid === undefined) continue
            counts[gid]++
            added++
          }
          s.total += added
          counted += added
        }
      },
      finalize() {
        const out = [...sections.entries()]
          .sort((a, b) => a[0] - b[0])
          .filter(([, s]) => s.total > 0)
          .map(([sy, s]) => ({
            y: sy,
            yRange: [sy, sy + 15],
            /** 包含该区段的区块数（平均值分母） */
            chunks: s.chunks,
            /** 每区块该区段的方块总数（不含空气） */
            avgTotal: avg(s.total, s.chunks),
            blocks: [...s.counts.entries()]
              .filter(([, n]) => n > 0)
              .sort((a, b) => b[1] - a[1])
              .map(([gid, n]) => ({ id: globalNames[gid], avg: avg(n, s.chunks), share: n / s.total * 100 })),
          }))
        return {
          chunks,
          avgBlocksPerChunk: avg(counted, chunks),
          note: "avgTotal / blocks[].avg 为每区块该区段的平均数量（分母 = 该区段的 chunks）",
          includeAir,
          top,
          sections: out,
        }
      },
    }
  },
  format(result) {
    const r = result as {
      chunks: number
      avgBlocksPerChunk: number
      top: number
      sections: { y: number, yRange: [number, number], chunks: number, avgTotal: number, blocks: { id: string, avg: number, share: number }[] }[]
    }
    const lines = [`区块 ${r.chunks}，每区块平均方块 ${r.avgBlocksPerChunk.toFixed(2)}，区段 ${r.sections.length} 个`]
    for (const s of r.sections) {
      const top = s.blocks.slice(0, r.top)
        .map(b => `${b.id.replace("minecraft:", "")} ${b.avg.toFixed(2)} (${b.share.toFixed(1)}%)`)
        .join("  ")
      lines.push(`  ${`${s.yRange[0]}~${s.yRange[1]}`.padStart(9)}  ${top}`)
    }
    return lines
  },
}

export default analyzer
