import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"

/**
 * 地表高度剖面：用 chunkExtent 取每列最高的非空气方块高度，
 * 输出 min/max/mean 和 8 格一档的分布。
 * params: { bucket? }
 */
const analyzer: AnalyzerModule = {
  name: "surface-profile",
  description: "统计每个区块最高非空气方块的高度分布",
  create(params): Analyzer {
    const p = params["surface-profile"] as Record<string, unknown> | undefined
    const bucket = Number(p?.bucket ?? 8)
    const hist = new Map<number, number>()
    let chunks = 0
    let empty = 0
    let min = Infinity, max = -Infinity, sum = 0, n = 0

    return {
      name: "surface-profile",
      async onChunk(c: ChunkHandle) {
        chunks++
        const ext = await c.extent()
        if (!ext) { empty++; return }
        const top = ext.top
        if (top < min) min = top
        if (top > max) max = top
        sum += top; n++
        const k = Math.floor(top / bucket) * bucket
        hist.set(k, (hist.get(k) ?? 0) + 1)
      },
      finalize() {
        return {
          chunks,
          emptyChunks: empty,
          minTop: n ? min : null,
          maxTop: n ? max : null,
          meanTop: n ? Number((sum / n).toFixed(2)) : null,
          histogram: [...hist.entries()].sort((a, b) => a[0] - b[0])
            .map(([from, count]) => ({ from, to: from + bucket - 1, count })),
        }
      },
    }
  },
  format(result) {
    const r = result as { minTop: number | null, maxTop: number | null, meanTop: number | null }
    return [`最高点 ${r.minTop}~${r.maxTop}，均值 ${r.meanTop}`]
  },
}

export default analyzer
