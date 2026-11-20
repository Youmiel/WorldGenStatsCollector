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

/** 一个分析器模块的完整形状（`create` 必填，其余由分析器按需声明） */
export interface AnalyzerModule {
  name: string
  description?: string
  /**
   * 适用的维度（不写 = 全部维度都适用）。接受 `overworld` / `minecraft:overworld` 两种写法。
   * 不在列表里的维度不会执行本分析器，而是记入 `unsupported` 并写明原因 ——
   * 口径只对某个维度成立时（例如岩浆湖的 yThreshold 是主世界高度）用它，
   * 别让一个只对主世界有意义的数字落到下界/末地的结果里。
   */
  dimensions?: string[]
  /** 产物 `units` 字段：本分析器各数值的单位，避免下游从 note 散文里猜 */
  units?: Record<string, string>
  /**
   * 产物按维度拆成多个文件（默认 false = 全部写进 `<name>.json`）。
   *
   * 用于单维度结果就很大、放一个文件不便按需读取的分析器（`ore-stats` 的主世界
   * 就有近 1MB）。开启后：
   * - 主文件 `<name>.json` 只含元信息，`result` 为空对象，另给 `resultFiles`
   *   记录「维度 → 文件名」的映射；
   * - 每个维度写一个 `<name>.<维度简写>.json`，结构与本分析器的常规产物完全一致，
   *   只是 `result` 里只有那一个维度。
   *
   * 下游读法：先读主文件拿 `resultFiles`，再按需读对应维度文件。
   */
  splitByDimension?: boolean
  /**
   * 并行调度的**相对代价**：独占跑一次本分析器的耗时。
   *
   * 单位任意，但必须跨分析器可比（通常以最慢的那个记 10 等比折算）。
   * 框架只用它做 worker 负载均衡，不影响任何产物内容；不写按 2 计。
   *
   * 注意记的是**独占跑**的代价，不是串行时观测到的耗时：能蹭别人 memo 的分析器
   * 串行时看起来很快，一旦被分到别的 worker 就要自己付全额解码成本。
   *
   * 由分析器自己声明，是因为只有它知道自己扫了多少数据；框架不该认识具体插件。
   */
  parallelCost?: number
  /**
   * 并行**亲和键**：同一键的分析器会被尽量分到同一个 worker。
   *
   * 适用于「读同一批原始 NBT」的分析器——`ChunkHandle` 的 memo 只在同一个
   * worker 内共享，分开就要各解一遍（实测代价可达上百秒）。
   *
   * 键名自取，只需相关分析器写同一个值。亲和是「尽量」：若目标分组已明显超载，
   * 框架会放弃亲和以保证负载均衡（正确性不受影响，只是多付一次解码）。
   */
  parallelGroup?: string
  /** 每次运行创建一个新实例，保证多次运行/多维度互不污染 */
  create(params: Record<string, unknown>): Analyzer
  /** 控制台摘要（可选）：接收 finalize 的结果，返回相对缩进的行，CLI 每行再缩进 4 格 */
  format?(result: unknown): string[]
}

/**
 * 「我不是分析器」的约定声明。
 *
 * 分析器目录（`production/`、`examples/`、`plugins`）里除了分析器，还可能需要放
 * **共享库**——被多个分析器复用的领域知识或工具（例如 `production/landmarks.ts`，
 * 由结构统计的两个分析器共用）。这类模块只要导出这个字段，
 * 加载器就会静默跳过，不会因为缺少 `name` / `create()` 而告警。
 *
 * 为什么用声明而不是目录层级：目录分层会让「这个文件该放哪」变成每次都要判断的事，
 * 而声明是一次说清、永久生效，且与 `parallelCost` / `parallelGroup` 同一思路——
 * 插件告诉框架自己是什么，框架只做通用检测，不按文件名猜。
 *
 * 用法：
 * ```ts
 * export const notAnAnalyzer = true
 * ```
 */
export const NOT_AN_ANALYZER_KEY = "notAnAnalyzer"

export interface AnalysisRunResult {
  analyzer: string
  description?: string
  ok: boolean
  error?: string
  durationMs: number
  result?: unknown
}
