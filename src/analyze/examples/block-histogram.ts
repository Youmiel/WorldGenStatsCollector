import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"

/**
 * 方块直方图：按方块 id 统计出现次数。
 * params: { yMin?, yMax?, includeAir?, top? }
 */
const analyzer: AnalyzerModule = {
  name: "block-histogram",
  description: "按方块 id 统计方块数量与占比",
  create(params): Analyzer {
    const p = params["block-histogram"] as Record<string, unknown> | undefined
    const opts = {
      yMin: p?.yMin as number | undefined,
      yMax: p?.yMax as number | undefined,
      includeAir: Boolean(p?.includeAir ?? false),
    }
    const top = Number(p?.top ?? 15)
    const counts = new Map<string, number>()
    let blocks = 0
    let chunks = 0

    return {
      name: "block-histogram",
      async onChunk(c: ChunkHandle) {
        const res = await c.blocks(opts)
        if (!res) return
        chunks++
        const { palette, raw } = res
        const ids = palette.map(s => s.id)
        // raw: [state, x, y, z, ...]，只读 state 位
        for (let i = 0; i < raw.length; i += 4) {
          const id = ids[raw[i]] ?? "minecraft:air"
          counts.set(id, (counts.get(id) ?? 0) + 1)
          blocks++
        }
      },
      finalize() {
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
        const total = blocks || 1
        return {
          chunks,
          blocks,
          uniqueBlocks: counts.size,
          top: sorted.slice(0, top).map(([id, n]) => ({ id, count: n, share: Number((n / total * 100).toFixed(3)) })),
          all: Object.fromEntries(sorted),
        }
      },
    }
  },
  format(result) {
    const r = result as { chunks: number, blocks: number, uniqueBlocks: number, top: { id: string, count: number, share: number }[] }
    return [
      `区块 ${r.chunks}，方块 ${r.blocks}，种类 ${r.uniqueBlocks}`,
      ...r.top.slice(0, 6).map(t => `  ${t.id.padEnd(34)} ${String(t.count).padStart(9)}  ${t.share}%`),
    ]
  },
}

export default analyzer
