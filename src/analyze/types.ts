import type { Blocks, BlockState, ChunkGrid, ChunkRef, Entity, World } from "minecraft-block-reader"

/** 一个区块的惰性句柄：只有真正调用方法时才解析 NBT */
export interface ChunkHandle {
  ref: ChunkRef
  /** 世界坐标 */
  x: number
  z: number
  nbt(): Promise<Record<string, unknown> | null>
  /**
   * 方块的扁平列表。includeAir=false（默认）时只含非空气方块，
   * 所以「查不到某个坐标」就等于该处是空气——判断邻接/暴露时不必再查空气表。
   */
  blocks(opts?: { yMin?: number, yMax?: number, includeAir?: boolean }): Promise<Blocks | null>
  grid(opts?: { yMin?: number, yMax?: number }): Promise<ChunkGrid>
  extent(opts?: { yMin?: number, yMax?: number }): Promise<{ top: number, bottom: number } | null>
  /**
   * 区块里的实体（含掉落物、矿车）。
   * 1.17+ 实体存在独立的 entities/r.x.z.mca 里，不在区块 NBT 里，
   * 所以这里读的是实体文件，读不到再退回区块 NBT 的 entities 根键；两者都没有就返回空数组。
   */
  entities(): Promise<Entity[]>
  /**
   * 原始区块 NBT：绕过 reader 的根键白名单（sections/block_entities/…），
   * 可拿到 structures、Heightmaps 等；only 限定要解析的根键。
   */
  rawNbt(only?: readonly string[]): Promise<Record<string, unknown> | null>
}

/** 一个 region 文件对应的读取会话，onRegion 里可以直接用 world 做任意范围查询 */
export interface RegionSession {
  dimension: string
  x: number
  z: number
  path: string
  world: World
  chunks: ChunkRef[]
  palette?: BlockState[]
  /** region 文件原始字节，配合 chunk-nbt 读 world.chunk() 丢掉的字段 */
  bytes: Uint8Array
  /** 同维度的实体 region 文件路径（entities/r.x.z.mca），没有就 null */
  entityPath?: string | null
}

export interface AnalyzerContext {
  /** analyze.params 里属于本分析器的参数（已做浅合并） */
  params: Record<string, unknown>
  log: (...args: unknown[]) => void
  /** 累积一个结果字段，finalize 时一并输出 */
  emit: (key: string, value: unknown) => void
  /** 自上次调用以来的耗时 */
  elapsedMs: () => number
  /** 运行环境：存档目录、原版服务端 jar（数据包数据来源）、本次结果输出目录 */
  runtime: { worldDir: string, serverJar: string | null, outDir: string }
}

export interface Analyzer {
  name: string
  description?: string
  /** 每个 region 开始时调用一次 */
  onRegion?(session: RegionSession, ctx: AnalyzerContext): Promise<void> | void
  /** 每个区块调用一次（惰性解析，不调用方法就没有解析开销） */
  onChunk?(chunk: ChunkHandle, ctx: AnalyzerContext): Promise<void> | void
  /** 全部结束后的汇总，返回值写入结果文件 */
  finalize?(ctx: AnalyzerContext): Promise<unknown> | unknown
}

export interface AnalyzerModule {
  name: string
  description?: string
  /** 每次运行创建一个新实例，保证多次运行/多维度互不污染 */
  create(params: Record<string, unknown>): Analyzer
  /** 控制台摘要（可选）：接收 finalize 的结果，返回相对缩进的行，CLI 每行再缩进 4 格 */
  format?(result: unknown): string[]
}

export interface AnalysisRunResult {
  analyzer: string
  description?: string
  ok: boolean
  error?: string
  durationMs: number
  result?: unknown
}
