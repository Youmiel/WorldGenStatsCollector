import type { Analyzer, AnalyzerModule, ChunkHandle, RegionSession } from "../types.js"

/**
 * 基础索引：区块数、region 数、坐标范围，以及每个 region 的区块数。
 * 用来确认预生成范围确实落盘了。
 *
 * 磁盘上会有"空气区块"（proto-chunk，section 全空气），是待生成区块被提前落盘的结果，
 * 所以这里单独区分 empty / non-empty，坐标范围只算有方块的区块。
 */
const analyzer: AnalyzerModule = {
  name: "chunk-index",
  description: "统计已生成区块数量、region 数与坐标范围",
  create(): Analyzer {
    const perRegion: Record<string, number> = {}
    let chunks = 0
    let empty = 0
    let regions = 0
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    const dims: Record<string, number> = {}

    return {
      name: "chunk-index",
      onRegion(session: RegionSession) {
        regions++
        const key = `${session.dimension}:r.${session.x}.${session.z}`
        perRegion[key] = session.chunks.length
        dims[session.dimension] = (dims[session.dimension] ?? 0) + session.chunks.length
      },
      async onChunk(c: ChunkHandle) {
        chunks++
        const ext = await c.extent()
        if (!ext) { empty++; return }
        if (c.x < minX) minX = c.x
        if (c.x > maxX) maxX = c.x
        if (c.z < minZ) minZ = c.z
        if (c.z > maxZ) maxZ = c.z
      },
      finalize() {
        const withBlocks = chunks - empty
        return {
          chunks,
          emptyChunks: empty,
          chunksWithBlocks: withBlocks,
          regions,
          chunksByDimension: dims,
          chunksByRegion: perRegion,
          boundsInChunks: withBlocks ? { minX, maxX, minZ, maxZ, width: maxX - minX + 1, depth: maxZ - minZ + 1 } : null,
        }
      },
    }
  },
  format(result) {
    const r = result as { chunks: number, emptyChunks: number, chunksWithBlocks: number, regions: number }
    return [`区块 ${r.chunks}（空气 ${r.emptyChunks}，有方块 ${r.chunksWithBlocks}），region ${r.regions}`]
  },
}

export default analyzer
