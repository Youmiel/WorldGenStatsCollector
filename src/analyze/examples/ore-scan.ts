import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"

/**
 * 示例分析器：统计指定方块 id 的出现次数。
 *
 * 它同时是自定义分析器的最小骨架——接口和 `analyzers/*.js` 插件完全一致，
 * 抄成 .js 丢进 analyzers/ 就能用 --analyzers 点名运行。
 *
 * params: { watch?: string[] }
 */
const DEFAULT_WATCH = [
  "minecraft:coal_ore",
  "minecraft:iron_ore",
  "minecraft:copper_ore",
  "minecraft:diamond_ore",
  "minecraft:redstone_ore",
]

const analyzer: AnalyzerModule = {
  name: "ore-scan",
  description: "统计指定方块 id 的出现次数（示例）",
  create(params): Analyzer {
    const p = (params["ore-scan"] ?? {}) as { watch?: string[] }
    const watch = new Set(p.watch ?? DEFAULT_WATCH)
    const counts: Record<string, number> = Object.fromEntries([...watch].map(id => [id, 0]))
    let chunks = 0

    return {
      name: "ore-scan",
      async onChunk(chunk: ChunkHandle) {
        chunks++
        const res = await chunk.blocks({ includeAir: false })
        if (!res) return
        const ids = res.palette.map(s => s.id)
        const { raw } = res
        for (let i = 0; i < raw.length; i += 4) {
          const id = ids[raw[i]]
          if (counts[id] !== undefined) counts[id]++
        }
      },
      finalize() {
        return { chunks, counts }
      },
    }
  },
  format(result) {
    const r = result as { chunks: number, counts: Record<string, number> }
    return [
      `区块 ${r.chunks}`,
      ...Object.entries(r.counts)
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `  ${id.padEnd(30)} ${n}`),
    ]
  },
}

export default analyzer
