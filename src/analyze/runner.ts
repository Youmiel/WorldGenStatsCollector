import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { read } from "minecraft-block-reader"
import type { ChunkRef, Entity, World } from "minecraft-block-reader"
import { dimensionDirs, dimensionEntityDirs } from "../lib/server.js"
import type { Area, Config } from "../lib/config.js"
import { chunkInArea } from "./range.js"
import { readRegionChunkNbt } from "./chunk-nbt.js"
import { log } from "../lib/util.js"
import type { TargetInfo } from "./target.js"
import type { Analyzer, AnalyzerContext, AnalyzerModule, AnalysisRunResult, ChunkHandle, RegionSession } from "./types.js"

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

export interface RangeInfo {
  shape: "circle" | "square" | "all"
  center: [number, number] | null
  radius: number | null
  boundChunks: { x: [number, number], z: [number, number] } | null
  chunksScanned: number
  chunksSkipped: number
  /** chunksSkipped 的含义：是「范围内未生成」还是「范围外已生成」 */
  skippedReason: string | null
}

function rangeInfo(area: Area | null, scanned: number, skipped: number): RangeInfo {
  if (!area) {
    return {
      shape: "all",
      center: null,
      radius: null,
      boundChunks: null,
      chunksScanned: scanned,
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
export async function runAnalysis(opts: AnalyzeOptions, modules: AnalyzerModule[]): Promise<AnalysisRunResult[]> {
  const { cfg } = opts
  const params = cfg.analyze.params as Record<string, unknown>
  const results: AnalysisRunResult[] = []
  const runId = new Date().toISOString().replace(/[:.]/g, "-")
  const outDir = join(opts.outDir, runId)
  await mkdir(outDir, { recursive: true })
  const runtime = { worldDir: opts.worldDir, serverJar: opts.serverJar ?? null, outDir }
  const dimensions = cfg.analyze.dimensions.map(namespaceDimension)
  // 各分析器扫的是同一批区块，总量在循环里重置累计，最后一份即 summary 用的数字
  let lastScanned = 0, lastSkipped = 0
  let lastRanges: Record<string, RangeInfo> = {}

  for (const mod of modules) {
    const t0 = Date.now()
    const result: Record<string, unknown> = {}
    const errors: { dimension: string, message: string }[] = []
    const unsupported: { item: string, reason: string }[] = []
    /** 每个维度各自的范围统计；单维度的旧字段取第一个维度的值，保持向后可读 */
    const ranges: Record<string, RangeInfo> = {}
    let scanned = 0, skipped = 0

    for (const dim of cfg.analyze.dimensions) {
      const ns = namespaceDimension(dim)
      const area = opts.areas.get(dim) ?? null
      const analyzer = mod.create(params)
      const { ctx, store } = contextFor(analyzer, params, runtime)
      let dimScanned = 0, dimSkipped = 0
      try {
        const regions = await listRegions(opts.worldDir, dim)
        if (!regions.length) {
          log.warn(`${mod.name}: ${dim} 没找到 region 文件（${opts.worldDir}）`)
          unsupported.push({ item: `dimension:${ns}`, reason: "没有 region 文件" })
          result[ns] = null
          ranges[ns] = rangeInfo(area, 0, 0)
          continue
        }
        log.info(`${mod.name}: ${dim} ${regions.length} 个 region${area ? "，按范围过滤区块" : ""}`)
        for (const r of regions) {
          // 单个 .mca 整文件读入（10MB 级）；reader 的 blob 惰性读取只对 zip 世界生效。
          // world.chunks 只列 header 里真实存在的区块，不是 1024 个槽位。
          const bytes = await readFile(r.path)
          if (!bytes.length) continue
          const world = await read(bytes, { region: [r.x, r.z] }) as World
          const chunks = area ? world.chunks.filter(c => chunkInArea(c.cx, c.cz, area)) : world.chunks
          dimScanned += chunks.length
          dimSkipped += world.chunks.length - chunks.length
          if (!chunks.length) continue
          const session: RegionSession = { dimension: dim, x: r.x, z: r.z, path: r.path, world, chunks, bytes, entityPath: r.entityPath }
          await analyzer.onRegion?.(session, ctx)
          if (analyzer.onChunk) {
            // 实体文件只读到一次，且只在分析器真的调 entities() 时才会读
            let entityBytesPromise: Promise<Uint8Array | null> | null = null
            const getEntityBytes = () => (entityBytesPromise ??= r.entityPath
              ? readFile(r.entityPath).catch(() => null)
              : Promise.resolve(null))
            for (const ref of chunks) {
              await analyzer.onChunk(makeHandle(world, ref, bytes, getEntityBytes), ctx)
            }
          }
        }
        const finalized = await analyzer.finalize?.(ctx)
        result[ns] = finalized === undefined ? { ...store } : { ...store, ...(finalized as object) }
      } catch (e) {
        const message = (e as Error).message
        errors.push({ dimension: ns, message })
        result[ns] = null
        log.error(`${mod.name} @ ${ns} 失败：${message}`)
      }
      scanned += dimScanned
      skipped += dimSkipped
      ranges[ns] = rangeInfo(area, dimScanned, dimSkipped)
    }

    const durationMs = Date.now() - t0
    lastScanned = scanned
    lastSkipped = skipped
    lastRanges = ranges
    const ok = errors.length === 0
    const payload = {
      analyzer: mod.name,
      description: mod.description,
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      target: opts.target,
      /** 全局汇总（各维度之和）；分维度明细见 rangeByDimension */
      range: rangeInfo(null, scanned, skipped),
      rangeByDimension: ranges,
      units: mod.units ?? {},
      config: (params[mod.name] ?? {}) as Record<string, unknown>,
      ok,
      errors,
      unsupported,
      durationMs,
      result,
    }
    await writeFile(join(outDir, `${mod.name}.json`), JSON.stringify(payload, null, 2), "utf8")
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
    range: rangeInfo(null, lastScanned, lastSkipped),
    rangeByDimension: lastRanges,
    analyzers: results.map(r => ({ name: r.analyzer, ok: r.ok, error: r.error, durationMs: r.durationMs })),
  }, null, 2), "utf8")
  log.info(`结果已写入 ${outDir}`)
  return results
}
