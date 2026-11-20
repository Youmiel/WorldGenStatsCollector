import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { availableParallelism } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { read } from "minecraft-block-reader"
import type { ChunkRef, Entity, World } from "minecraft-block-reader"
import { dimensionDirs, dimensionEntityDirs } from "../lib/server.js"
import type { Area, Config } from "../lib/config.js"
import { chunkInArea } from "./range.js"
import { readRegionChunkNbt } from "./chunk-nbt.js"
import { FIELD_DOC_FILE, loadFieldDoc, writeFieldDoc } from "./field-doc.js"
import { log, progressClear, progressWrite } from "../lib/util.js"
import type { TargetInfo } from "./target.js"
import type { Analyzer, AnalyzerContext, AnalyzerModule, AnalysisRunResult, ChunkHandle, RegionSession } from "./types.js"

/** 仓库根：与 cli 用同一套推导（dist/analyze → 上两级），worker 里解析插件目录要用 */
const ROOT = process.env.WGS_ROOT
  ? resolve(process.env.WGS_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

export interface AnalyzeOptions {
  cfg: Config
  worldDir: string
  outDir: string
  /** 每个维度的统计范围（键为配置里的维度名）；不在表里或值为 null 则全量 */
  areas: Map<string, Area | null>
  /** 原版服务端 jar（数据包数据来源），没有就 null */
  serverJar?: string | null
  /** 产物头部标识（版本/种子/数据包） */
  target: TargetInfo
}

/**
 * 实体 NBT → Entity。
 * 实体 region 的元素是完整实体 NBT（自带 Pos）；区块内嵌的 entities 可能是 { pos, nbt } 包一层。
 */
function toEntity(v: unknown): Entity | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const inner = o.nbt && typeof o.nbt === "object" ? o.nbt as Record<string, unknown> : o
  const raw = Array.isArray(o.pos) ? o.pos : Array.isArray(inner.Pos) ? inner.Pos : null
  const pos: [number, number, number] = raw && raw.length >= 3
    ? [Number(raw[0]), Number(raw[1]), Number(raw[2])]
    : [0, 0, 0]
  return { pos, nbt: inner }
}

function makeHandle(
  world: World,
  ref: ChunkRef,
  bytes: Uint8Array,
  entityBytes: () => Promise<Uint8Array | null>,
): ChunkHandle {
  const cache = new Map<string, Promise<unknown>>()
  const memo = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, fn() as Promise<unknown>)
    return cache.get(key) as Promise<T>
  }
  return {
    ref,
    x: ref.cx,
    z: ref.cz,
    nbt: () => memo("nbt", () => world.chunk(ref)),
    blocks: opts => memo(`b:${JSON.stringify(opts ?? {})}`, () => world.chunkBlocks(ref, opts)),
    grid: opts => memo(`g:${JSON.stringify(opts ?? {})}`, () => world.chunkGrid(ref, opts)),
    extent: opts => memo(`e:${JSON.stringify(opts ?? {})}`, () => world.chunkExtent(ref, opts)),
    entities: () => memo("entities", async () => {
      // 先读实体 region（1.17+ 的正规位置），读不到再退回区块 NBT 内嵌的 entities
      const ebytes = await entityBytes()
      if (ebytes) {
        const nbt = await readRegionChunkNbt(ebytes, ref, ["Entities"])
        const list = nbt?.Entities
        if (Array.isArray(list) && list.length) {
          return list.map(toEntity).filter((e): e is Entity => e !== null)
        }
      }
      const own = await readRegionChunkNbt(bytes, ref, ["entities"])
      const inline = own?.entities
      if (!Array.isArray(inline) || !inline.length) return []
      return inline.map(toEntity).filter((e): e is Entity => e !== null)
    }),
    rawNbt: only => memo(`r:${only?.join(",") ?? "*"}`, () => readRegionChunkNbt(bytes, ref, only)),
  }
}

function contextFor(
  analyzer: Analyzer,
  params: Record<string, unknown>,
  runtime: { worldDir: string, serverJar: string | null, outDir: string },
): { ctx: AnalyzerContext, store: Record<string, unknown> } {
  const store: Record<string, unknown> = {}
  let last = Date.now()
  const scoped = (params[analyzer.name] ?? {}) as Record<string, unknown>
  return {
    store,
    ctx: {
      params: { ...params, ...scoped },
      log: (...a: unknown[]) => log.info(`[${analyzer.name}]`, ...a),
      emit: (k, v) => { store[k] = v },
      elapsedMs: () => { const n = Date.now(); const d = n - last; last = n; return d },
      runtime,
    },
  }
}

async function listRegions(
  worldDir: string,
  dim: string,
): Promise<{ x: number, z: number, path: string, entityPath: string | null }[]> {
  let dir = ""
  let files: string[] = []
  for (const cand of dimensionDirs(worldDir, dim)) {
    try { files = await readdir(cand); dir = cand; break } catch { /* 试下一种布局 */ }
  }
  if (!dir) return []

  // 实体是独立文件，和 region 同名；目录缺失（旧版本/未写过实体）就当没有
  let entityDir = ""
  let entityFiles: string[] = []
  for (const cand of dimensionEntityDirs(worldDir, dim)) {
    try { entityFiles = await readdir(cand); entityDir = cand; break } catch { /* 同上 */ }
  }
  const entitySet = new Set(entityFiles)

  const out: { x: number, z: number, path: string, entityPath: string | null }[] = []
  for (const f of files) {
    const m = f.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/)
    if (!m) continue
    out.push({
      x: Number(m[1]),
      z: Number(m[2]),
      path: join(dir, f),
      entityPath: entityDir && entitySet.has(f) ? join(entityDir, f) : null,
    })
  }
  return out.sort((a, b) => a.x - b.x || a.z - b.z)
}

/** 维度 ID 统一成命名空间形式：overworld → minecraft:overworld */
export function namespaceDimension(d: string): string {
  return d.includes(":") ? d : `minecraft:${d}`
}

/** 维度 ID 转文件名片段：minecraft:the_nether → the_nether */
function dimensionSlug(d: string): string {
  return d.replace(/^minecraft:/, "").replace(/[^a-z0-9_-]/gi, "_")
}

/** 分析器是否声明了适用维度；没声明 = 全部适用 */
function appliesTo(mod: AnalyzerModule, dim: string): boolean {
  if (!mod.dimensions?.length) return true
  const ns = namespaceDimension(dim)
  return mod.dimensions.some(d => namespaceDimension(d) === ns)
}

export interface RangeInfo {
  shape: "circle" | "square" | "all"
  center: [number, number] | null
  radius: number | null
  boundChunks: { x: [number, number], z: [number, number] } | null
  /** 范围内的区块数（含完全没有方块的空区块） */
  chunksScanned: number
  /** 范围内但 extent() 为 null 的区块数：末地中间是虚空、区块从未生成过等 */
  chunksEmpty: number
  /** 实际有方块、可被分析器统计的区块数 */
  chunksWithBlocks: number
  chunksSkipped: number
  /** chunksSkipped 的含义：是「范围内未生成」还是「范围外已生成」 */
  skippedReason: string | null
}

function rangeInfo(area: Area | null, scanned: number, skipped: number, empty = 0): RangeInfo {
  if (!area) {
    return {
      shape: "all",
      center: null,
      radius: null,
      boundChunks: null,
      chunksScanned: scanned,
      chunksEmpty: empty,
      chunksWithBlocks: scanned - empty,
      chunksSkipped: skipped,
      // 全量统计时 skipped 恒为 0；但作为多维度汇总行时这里可能带的是各维度之和，
      // 所以不能无条件写 null，按实际值给出原因
      skippedReason: skipped > 0 ? "部分维度按范围过滤，此处为各维度汇总" : null,
    }
  }
  const b = area.chunkBounds
  return {
    shape: area.shape,
    center: area.center,
    radius: area.radius,
    boundChunks: b ? { x: [b.minX, b.maxX], z: [b.minZ, b.maxZ] } : null,
    chunksScanned: scanned,
    chunksEmpty: empty,
    chunksWithBlocks: scanned - empty,
    chunksSkipped: skipped,
    // skipped 是「world 内存在、但落在统计范围外」的区块数，不是范围内还没生成的
    skippedReason: skipped > 0 ? "world 内含超出该统计范围的区块，已跳过" : null,
  }
}

/**
 * 跑一个分析器，独立 try/catch，一个崩了不影响其它。
 *
 * 每个维度用独立的 analyzer 实例：分析器内部不需要自己按维度分桶，
 * 结果天然落到 result[namespaceDimension(dim)] 下，跨维度的数字不会混在同一个键里。
 */
/**
 * 单个分析器在一次运行里的累积状态。
 *
 * 只含**可结构化克隆**的字段（没有函数、没有类实例）：这样它既能留在主线程，
 * 也能从 worker 线程回传。分析器模块本身按 `name` 在主线程重新对上。
 */
export interface AnalyzerRunSnapshot {
  name: string
  /** 只统计真正花在该分析器里的时间，不含共享的区块解码 */
  durationMs: number
  result: Record<string, unknown>
  errors: { dimension: string, message: string }[]
  unsupported: { item: string, reason: string }[]
  ranges: Record<string, RangeInfo>
  scanned: number
  skipped: number
  /** 范围内但没有方块的区块数 */
  empty: number
}

/** 某个分析器在当前维度上的实例；dead 表示已抛错，后续区块不再调用 */
interface ActiveRun {
  mod: AnalyzerModule
  run: AnalyzerRunSnapshot
  analyzer: Analyzer
  ctx: AnalyzerContext
  store: Record<string, unknown>
  dead: boolean
}

const elapsed = async <T>(holder: ActiveRun, fn: () => Promise<T> | T): Promise<T> => {
  const t = Date.now()
  try {
    return await fn()
  } finally {
    holder.run.durationMs += Date.now() - t
  }
}

export interface ProgressTick {
  dimension: string
  /** 已处理完的 region 数 / 该维度 region 总数 */
  regionsDone: number
  regionsTotal: number
  /** 已处理的区块数 */
  chunks: number
  /** 该维度的区块总数；范围未定时为 null（例如全量统计，只有遍历完才知道） */
  chunksTotal: number | null
}

/**
 * 跑一组分析器（不含产物写入），返回每个分析器的累积快照。
 *
 * 循环顺序是「维度 → region → 区块 → 分析器」，而不是「分析器 → 维度 → region → 区块」。
 * 这样同一个区块只会被解码一次，各分析器的 ChunkHandle.memo 共用同一份结果：
 * 9 个分析器里 6 个要的本来都是同一张 grid，逐个跑就是同一块解 9 遍。
 *
 * 各分析器的累积状态互不影响：onRegion 在每个 region 的全部 onChunk 之前调用，
 * 与逐个跑的时序一致；finalize 仍在「该维度的全部 region 跑完」之后调用。
 *
 * 这个函数是并行的最小单元：worker 线程里跑的就是它，主线程收集快照后统一写盘。
 * 因此它不写任何文件（`lava-lakes` 的可视化除外——那是分析器自己的行为）。
 *
 * `onProgress` 在每个 region 处理完时回调一次（worker 里由 worker.ts 转成 postMessage）。
 */
export async function runModules(
  opts: AnalyzeOptions,
  modules: AnalyzerModule[],
  outDir: string,
  onProgress?: (tick: ProgressTick) => void,
): Promise<AnalyzerRunSnapshot[]> {
  const { cfg } = opts
  const params = cfg.analyze.params as Record<string, unknown>
  const runtime = { worldDir: opts.worldDir, serverJar: opts.serverJar ?? null, outDir }

  const runs: AnalyzerRunSnapshot[] = modules.map(mod => ({
    name: mod.name,
    durationMs: 0,
    result: {},
    errors: [],
    unsupported: [],
    ranges: {},
    scanned: 0,
    skipped: 0,
    empty: 0,
  }))

  for (const dim of cfg.analyze.dimensions) {
    const ns = namespaceDimension(dim)
    const area = opts.areas.get(dim) ?? null

    // 每个适用模块建一个维度级实例（跨 region 累积，与逐个跑一致）
    const active: ActiveRun[] = []
    for (let i = 0; i < modules.length; i++) {
      const mod = modules[i]
      const run = runs[i]
      // 声明了适用维度的分析器，在不适用维度上不建实例、不存 result 键，
      // 只留一条 unsupported 说明「为什么这个维度没有它」，避免下游把缺席误读成 0
      if (!appliesTo(mod, dim)) {
        const why = `分析器口径只适用于 ${mod.dimensions!.map(namespaceDimension).join(", ")}`
        log.info(`${mod.name}: 跳过 ${dim}（${why}）`)
        run.unsupported.push({ item: `dimension:${ns}`, reason: why })
        // 不给 range：result 里也没有这个键，两处保持一致，
        // 免得下游看到 chunksScanned: 0 误以为「测了但一个区块都没有」
        continue
      }
      const analyzer = mod.create(params)
      const { ctx, store } = contextFor(analyzer, params, runtime)
      active.push({ mod, run, analyzer, ctx, store, dead: false })
    }
    if (!active.length) continue

    const regions = await listRegions(opts.worldDir, dim)
    if (!regions.length) {
      log.warn(`${dim} 没找到 region 文件（${opts.worldDir}）`)
      for (const a of active) {
        a.run.unsupported.push({ item: `dimension:${ns}`, reason: "没有 region 文件" })
        a.run.result[ns] = null
        a.run.ranges[ns] = rangeInfo(area, 0, 0)
      }
      continue
    }
    log.info(`${dim} ${regions.length} 个 region${area ? "，按范围过滤区块" : ""}，${active.length} 个分析器`)

    /** 进度百分比的分母：范围内区块总数。范围定了才能事前算出来，全量统计只能画区块累计数 */
    const estChunks = area?.chunkBounds
      ? (area.chunkBounds.maxX - area.chunkBounds.minX + 1) * (area.chunkBounds.maxZ - area.chunkBounds.minZ + 1)
      : null

    let dimScanned = 0, dimSkipped = 0, dimEmpty = 0
    let dimChunksSeen = 0
    let regionsDone = 0
    for (const r of regions) {
      // 单个 .mca 整文件读入（10MB 级）；reader 的 blob 惰性读取只对 zip 世界生效。
      // world.chunks 只列 header 里真实存在的区块，不是 1024 个槽位。
      const bytes = await readFile(r.path)
      if (!bytes.length) continue
      const world = await read(bytes, { region: [r.x, r.z] }) as World
      // 按行列序（先 z 后 x）遍历：需要邻块数据的分析器（ore-stats 查 6 面、
      // biome-patch 洪泛、lava-lakes 地形）在行主序下走的都是刚读过的邻块。
      // reader 的 world.chunks 是 header 顺序，按它走会让邻块反复冷解码。
      const picked = area ? world.chunks.filter(c => chunkInArea(c.cx, c.cz, area)) : world.chunks
      const chunks = [...picked].sort((a, b) => a.cz - b.cz || a.cx - b.cx)
      dimScanned += chunks.length
      dimSkipped += world.chunks.length - chunks.length
      dimChunksSeen += chunks.length
      regionsDone++
      onProgress?.({
        dimension: dim,
        regionsDone,
        regionsTotal: regions.length,
        chunks: dimChunksSeen,
        chunksTotal: estChunks,
      })
      if (!chunks.length) continue

      const session: RegionSession = { dimension: dim, x: r.x, z: r.z, path: r.path, world, chunks, bytes, entityPath: r.entityPath }
      for (const a of active) {
        if (a.dead || !a.analyzer.onRegion) continue
        try {
          await elapsed(a, () => a.analyzer.onRegion!(session, a.ctx))
        } catch (e) {
          a.dead = true
          const message = (e as Error).message
          a.run.errors.push({ dimension: ns, message })
          a.run.result[ns] = null
          log.error(`${a.mod.name} @ ${ns} 失败：${message}`)
        }
      }

      // 实体文件只读到一次，且只在分析器真的调 entities() 时才会读
      let entityBytesPromise: Promise<Uint8Array | null> | null = null
      const getEntityBytes = () => (entityBytesPromise ??= r.entityPath
        ? readFile(r.entityPath).catch(() => null)
        : Promise.resolve(null))

      for (const ref of chunks) {
        // 同一个 handle 给所有分析器：grid/blocks/extent 的 memo 因此可以互相命中
        const handle = makeHandle(world, ref, bytes, getEntityBytes)
        // 空区块（末地中间的虚空、从未写入方块的区块等）：各分析器会自己跳过，
        // 但报告里要把「范围内区块」与「真正可统计的区块」分开，否则
        // chunksScanned 会比各分析器实际处理的块数多出一大截。
        // extent 走 handle 的 memo，分析器本来就要它，这里几乎零成本。
        if (!(await handle.extent())) dimEmpty++
        const live = active.filter(a => !a.dead && a.analyzer.onChunk)
        if (!live.length) break
        for (const a of live) {
          try {
            await elapsed(a, () => a.analyzer.onChunk!(handle, a.ctx))
          } catch (e) {
            a.dead = true
            const message = (e as Error).message
            a.run.errors.push({ dimension: ns, message })
            a.run.result[ns] = null
            log.error(`${a.mod.name} @ ${ns} 失败：${message}`)
          }
        }
      }
    }

    for (const a of active) {
      a.run.scanned += dimScanned
      a.run.skipped += dimSkipped
      a.run.empty += dimEmpty
      a.run.ranges[ns] = rangeInfo(area, dimScanned, dimSkipped, dimEmpty)
      if (a.dead) continue
      try {
        const finalized = await elapsed(a, () => a.analyzer.finalize?.(a.ctx))
        a.run.result[ns] = finalized === undefined ? { ...a.store } : { ...a.store, ...(finalized as object) }
      } catch (e) {
        const message = (e as Error).message
        a.run.errors.push({ dimension: ns, message })
        a.run.result[ns] = null
        log.error(`${a.mod.name} @ ${ns} 失败：${message}`)
      }
    }
  }

  return runs
}

/* ------------------------------------------------------------------ */
/* 并行执行                                                            */
/* ------------------------------------------------------------------ */

/** worker 线程的启动参数；字段必须都能被结构化克隆 */
export interface WorkerInit {
  names: string[]
  cfg: Config
  worldDir: string
  /** 已经创建好的本次运行目录 */
  runOutDir: string
  serverJar: string | null
  areas: [string, Area | null][]
  /** 已解析成绝对路径的外部分析器目录 */
  pluginDir: string
}

/**
 * 每个 worker 都要自己解码一遍区块，这份固定成本必须计进组代价。
 *
 * 不计的话贪心会把所有大分析器塞进同一组（「这组还剩很多余量」），
 * 而每个 worker 起手先付一遍解码钱，其实早就满了。
 *
 * 这是**框架**概念（一个 worker = 一遍完整遍历），所以留在这里；
 * 各分析器自己的代价与亲和关系由它们声明（`AnalyzerModule.parallelCost`
 * / `.parallelGroup`），框架不认识任何具体插件。
 */
const DECODE_HINT = 4

/** 未声明代价时的默认权重：取中等值，避免既不抢 CPU 也不被无限后置 */
const DEFAULT_COST = 2

/**
 * 把分析器装进 `n` 个组（最长优先 + 最空组优先 + 亲和合并）。
 *
 * 只做均衡，不做正确性判断：任何分组跑出来的结果都与串行一致。
 *
 * 代价与亲和全部来自分析器自己的声明，框架不做任何按名字的特判——
 * 新增分析器时只需在自己的模块里写 `parallelCost` / `parallelGroup`。
 */
function packGroups(modules: AnalyzerModule[], n: number): AnalyzerModule[][] {
  const costOf = (m: AnalyzerModule) => m.parallelCost ?? DEFAULT_COST
  const sorted = [...modules].sort((a, b) => costOf(b) - costOf(a))

  const groups: AnalyzerModule[][] = Array.from({ length: n }, () => [])
  const load = new Array<number>(n).fill(DECODE_HINT)
  /** 亲和键 → 已落在哪个组；同键的后来者优先并进去，省掉重复解码 */
  const groupOfAffinity = new Map<string, number>()

  for (const mod of sorted) {
    const key = mod.parallelGroup
    // 亲和命中且那个组还有余量（不超最空组 1.5 倍）→ 直接进去，避免重复解码
    const pinned = key ? groupOfAffinity.get(key) : undefined
    if (pinned !== undefined && groups[pinned].length) {
      const minLoad = Math.min(...load)
      if (load[pinned] <= minLoad * 1.5) {
        groups[pinned].push(mod)
        load[pinned] += costOf(mod)
        continue
      }
    }
    let pick = 0
    for (let i = 1; i < n; i++) if (load[i] < load[pick]) pick = i
    groups[pick].push(mod)
    load[pick] += costOf(mod)
    if (key && !groupOfAffinity.has(key)) groupOfAffinity.set(key, pick)
  }
  return groups.filter(g => g.length > 0)
}

/** 在一个 worker 里跑一组分析器，拿回快照 */
function runInWorker(
  opts: AnalyzeOptions,
  group: AnalyzerModule[],
  runOutDir: string,
  onProgress?: (tick: ProgressTick) => void,
): Promise<AnalyzerRunSnapshot[]> {
  const init: WorkerInit = {
    names: group.map(m => m.name),
    cfg: opts.cfg,
    worldDir: opts.worldDir,
    runOutDir,
    serverJar: opts.serverJar ?? null,
    areas: [...opts.areas.entries()],
    pluginDir: resolve(ROOT, opts.cfg.analyze.pluginDir),
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: init })
    let settled = false
    worker.on("message", (msg: unknown) => {
      // 两种消息：进度心跳 { type: "progress" } 与最终快照数组
      if (!Array.isArray(msg)) {
        const tick = (msg as { type?: string, tick?: ProgressTick })?.tick
        if (tick) onProgress?.(tick)
        return
      }
      settled = true
      resolvePromise(msg as AnalyzerRunSnapshot[])
    })
    worker.once("error", (err) => {
      if (settled) return
      settled = true
      rejectPromise(err)
    })
    worker.once("exit", (code) => {
      if (settled) return
      settled = true
      rejectPromise(new Error(`分析 worker 提前退出（code=${code}）`))
    })
  })
}

/**
 * 单行进度：`分析 overworld 128/324 region · 4,120 chunks · 39.5% (3m12s)`
 *
 * 只在 TTY 下画（`progressWrite` 自己判断），且任何日志输出前会被 `log` 抹掉，
 * 所以日志永远是完整独立行，不会和进度条叠在一起。
 */
class ProgressLine {
  private start = Date.now()
  private lastWrite = 0

  constructor(private label: string) {}

  /** 节流到 100ms：进度条自己不能成为开销，也不需要比这更密的刷新 */
  update(text: string, force = false): void {
    const now = Date.now()
    if (!force && now - this.lastWrite < 100) return
    this.lastWrite = now
    progressWrite(`${this.label} ${text} (${elapsedText(now - this.start)})`)
  }

  done(): void {
    progressClear()
  }
}

/** 秒 → `3m12s` / `42s` / `1h05m` */
function elapsedText(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), rs = s % 60
  if (m < 60) return `${m}m${String(rs).padStart(2, "0")}s`
  const h = Math.floor(m / 60), rm = m % 60
  return `${h}h${String(rm).padStart(2, "0")}m`
}

function progressText(tick: ProgressTick): string {
  // 百分比优先用区块（与 `chunksTotal` 对应，是真进度）；范围未知时退回 region 进度
  const pctText = tick.chunksTotal && tick.chunksTotal > 0
    ? `${((tick.chunks / tick.chunksTotal) * 100).toFixed(1)}%`
    : `${((tick.regionsDone / tick.regionsTotal) * 100).toFixed(0)}%`
  return `${tick.dimension} ${tick.regionsDone}/${tick.regionsTotal} region`
    + ` · ${tick.chunks.toLocaleString("en-US")} chunks · ${pctText}`
}

/**
 * 执行全部分析器：`analyze.parallel > 1` 时分到多个 worker 线程，否则串行。
 *
 * 返回顺序恒与 `modules` 一致，保证产物内容与串行逐字节相同
 * （各分析器的 `result` 本来就互不依赖，并行只改变 `durationMs`）。
 */
async function executeModules(
  opts: AnalyzeOptions,
  modules: AnalyzerModule[],
  outDir: string,
): Promise<AnalyzerRunSnapshot[]> {
  const cores = availableParallelism()
  const want = Math.max(0, Math.trunc(Number(opts.cfg.analyze.parallel ?? 0)))
  if (!Number.isFinite(want) || want <= 1 || modules.length <= 1) {
    // 串行：产物与并行完全一致，只是墙钟长得多。核数够时提示一句，
    // 但尊重用户的显式选择（内存紧张时串行是合理取舍）。
    if (cores >= 4 && modules.length >= 4) {
      log.info(
        `提示：检测到 ${cores} 个可用核，可用 --parallel ${Math.min(4, Math.max(2, Math.floor(cores / 2)))}`
        + " 并行（实测约 2 倍加速、产物与串行一致）",
      )
    }
    const line = new ProgressLine("分析")
    try {
      return await runModules(opts, modules, outDir, tick => line.update(progressText(tick)))
    } finally {
      line.done()
    }
  }

  // 默认值是 4，但核数不够时按可用核数封顶：每个 worker 都要自己解码一遍区块，
  // 4 个 worker 抢 2 个核只会把重复解码的成本叠加上去，比串行还慢。
  const effective = Math.min(want, cores)
  if (effective < want) {
    log.info(`并行度 ${want} 超过可用核数 ${cores}，按 ${effective} 执行`)
  }

  const groups = packGroups(modules, Math.min(effective, modules.length))
  if (groups.length <= 1) {
    const line = new ProgressLine("分析")
    try {
      return await runModules(opts, modules, outDir, tick => line.update(progressText(tick)))
    } finally {
      line.done()
    }
  }

  log.info(
    `并行执行：${groups.length} 个 worker（`
    + groups.map(g => g.map(m => m.name).join("+")).join(" | ")
    + "）",
  )

  // 并行进度：每个 worker 都在跑「全部 region」，所以进度取**最慢那个**
  // （regionsDone 最小），那才是“还差多少”的真实答案；墙钟由最慢的组决定。
  const latest = new Map<number, ProgressTick>()
  const line = new ProgressLine(`分析 ${groups.length} worker`)
  const render = () => {
    if (!latest.size) return
    let slowest: ProgressTick | null = null
    for (const t of latest.values()) {
      if (!slowest || t.regionsDone < slowest.regionsDone) slowest = t
    }
    if (!slowest) return
    const done = [...latest.values()].reduce((a, t) => a + t.regionsDone, 0)
    const total = [...latest.values()].reduce((a, t) => a + t.regionsTotal, 0)
    const chunks = [...latest.values()].reduce((a, t) => a + t.chunks, 0)
    const pctText = slowest.chunksTotal && slowest.chunksTotal > 0
      ? `${((slowest.chunks / slowest.chunksTotal) * 100).toFixed(1)}%`
      : `${((slowest.regionsDone / slowest.regionsTotal) * 100).toFixed(0)}%`
    line.update(
      `${slowest.dimension} 最慢 ${slowest.regionsDone}/${slowest.regionsTotal} region`
      + ` · ${pctText} · 合计 ${done}/${total} · ${chunks.toLocaleString("en-US")} chunks`,
    )
  }

  const parts = await Promise.all(
    groups.map((g, i) => runInWorker(opts, g, outDir, tick => {
      latest.set(i, tick)
      render()
    })),
  ).finally(() => line.done())
  const byName = new Map(parts.flat().map(r => [r.name, r]))
  return modules.map(m => byName.get(m.name)).filter((r): r is AnalyzerRunSnapshot => Boolean(r))
}

export async function runAnalysis(opts: AnalyzeOptions, modules: AnalyzerModule[]): Promise<AnalysisRunResult[]> {
  const { cfg } = opts
  const params = cfg.analyze.params as Record<string, unknown>
  const results: AnalysisRunResult[] = []
  const runId = new Date().toISOString().replace(/[:.]/g, "-")
  const outDir = join(opts.outDir, runId)
  await mkdir(outDir, { recursive: true })
  // 字段说明随产物一起写进同一目录：下游拿到一批 JSON 时不必再去找仓库文档
  const fieldDoc = await loadFieldDoc()
  if (fieldDoc) await writeFieldDoc(outDir, fieldDoc)
  else log.warn(`找不到字段说明 OUTPUTS.md，${FIELD_DOC_FILE} 未写入 ${outDir}`)
  const dimensions = cfg.analyze.dimensions.map(namespaceDimension)
  let lastRanges: Record<string, RangeInfo> = {}
  let summaryScanned = 0, summarySkipped = 0, summaryEmpty = 0

  const runs = await executeModules(opts, modules, outDir)
  const byName = new Map(runs.map(r => [r.name, r]))

  // 按输入顺序写盘：并行时分析器的完成顺序是乱的，产物顺序必须与串行一致
  for (const mod of modules) {
    const run = byName.get(mod.name)
    if (!run) continue
    const { durationMs, result, errors, unsupported, ranges, scanned, skipped, empty } = run
    lastRanges = { ...lastRanges, ...ranges }
    // 各分析器扫的是同一批区块，取最大值即可代表本次运行的扫描量
    if (scanned > summaryScanned) summaryScanned = scanned
    if (skipped > summarySkipped) summarySkipped = skipped
    if (empty > summaryEmpty) summaryEmpty = empty
    const ok = errors.length === 0
    const payload = {
      analyzer: mod.name,
      description: mod.description,
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      target: opts.target,
      /** 全局汇总（各维度之和）；分维度明细见 rangeByDimension */
      range: rangeInfo(null, scanned, skipped, empty),
      rangeByDimension: ranges,
      /** 分析器声明的适用维度；null = 未声明，即全部维度 */
      appliesToDimensions: mod.dimensions?.length ? mod.dimensions.map(namespaceDimension) : null,
      units: mod.units ?? {},
      config: (params[mod.name] ?? {}) as Record<string, unknown>,
      /** 同目录下的字段说明文件；找不到源文档时字段缺席 */
      ...(fieldDoc ? { fieldDoc: FIELD_DOC_FILE } : {}),
      ok,
      errors,
      unsupported,
      durationMs,
      result,
    }
    if (mod.splitByDimension) {
      // 每维度一个文件：单维度结果可能很大（主世界的矿石统计近 1MB 内容），
      // 拆开后下游可以只读自己关心的维度。
      //
      // 维度文件用紧凑格式（无缩进）：这些文件动辄上百万字符，缩进会让体积翻倍，
      // 而它们本来就是给程序读的。主文件保持缩进，便于人眼确认元信息。
      const files: Record<string, string> = {}
      for (const [dim, value] of Object.entries(result)) {
        const file = `${mod.name}.${dimensionSlug(dim)}.json`
        files[dim] = file
        await writeFile(join(outDir, file), JSON.stringify({ ...payload, result: { [dim]: value } }), "utf8")
      }
      // 主文件只留元信息 + 文件映射；result 置空避免两处重复
      await writeFile(
        join(outDir, `${mod.name}.json`),
        JSON.stringify({ ...payload, result: {}, resultFiles: files }, null, 2),
        "utf8",
      )
    } else {
      await writeFile(join(outDir, `${mod.name}.json`), JSON.stringify(payload, null, 2), "utf8")
    }
    results.push({ analyzer: mod.name, description: mod.description, ok, error: errors[0]?.message, durationMs, result })
    log.info(`${mod.name} 完成 ${(durationMs / 1000).toFixed(2)}s`)
  }

  await writeFile(join(outDir, "summary.json"), JSON.stringify({
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    target: opts.target,
    world: opts.worldDir,
    dimensions,
    /** 全局汇总（各维度之和）；分维度明细见 rangeByDimension */
    range: rangeInfo(null, summaryScanned, summarySkipped, summaryEmpty),
    rangeByDimension: lastRanges,
    fieldDoc: fieldDoc ? FIELD_DOC_FILE : null,
    analyzers: results.map(r => ({ name: r.analyzer, ok: r.ok, error: r.error, durationMs: r.durationMs })),
  }, null, 2), "utf8")
  log.info(`结果已写入 ${outDir}`)
  return results
}
