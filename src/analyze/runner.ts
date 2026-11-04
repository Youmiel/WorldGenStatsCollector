import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { read } from "minecraft-block-reader"
import type { ChunkRef, World } from "minecraft-block-reader"
import { dimensionDirs } from "../lib/server.js"
import type { Area, Config } from "../lib/config.js"
import { chunkInArea, describeArea } from "./range.js"
import { readRegionChunkNbt } from "./chunk-nbt.js"
import { log } from "../lib/util.js"
import type { Analyzer, AnalyzerContext, AnalyzerModule, AnalysisRunResult, ChunkHandle, RegionSession } from "./types.js"

export interface AnalyzeOptions {
  cfg: Config
  worldDir: string
  outDir: string
  /** 统计范围；null 表示全量 */
  area: Area | null
  /** 原版服务端 jar（数据包数据来源），没有就 null */
  serverJar?: string | null
}

function makeHandle(world: World, ref: ChunkRef, bytes: Uint8Array): ChunkHandle {
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
    rawNbt: only => memo(`r:${only?.join(",") ?? "*"}`, () => readRegionChunkNbt(bytes, ref, only)),
  }
}

function contextFor(
  analyzer: Analyzer,
  params: Record<string, unknown>,
  runtime: { worldDir: string, serverJar: string | null },
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

async function listRegions(worldDir: string, dim: string): Promise<{ x: number, z: number, path: string }[]> {
  let dir = ""
  let files: string[] = []
  for (const cand of dimensionDirs(worldDir, dim)) {
    try { files = await readdir(cand); dir = cand; break } catch { /* 试下一种布局 */ }
  }
  if (!dir) return []
  const out: { x: number, z: number, path: string }[] = []
  for (const f of files) {
    const m = f.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/)
    if (m) out.push({ x: Number(m[1]), z: Number(m[2]), path: join(dir, f) })
  }
  return out.sort((a, b) => a.x - b.x || a.z - b.z)
}

/** 跑一个分析器，独立 try/catch，一个崩了不影响其它 */
export async function runAnalysis(opts: AnalyzeOptions, modules: AnalyzerModule[]): Promise<AnalysisRunResult[]> {
  const { cfg } = opts
  const params = cfg.analyze.params as Record<string, unknown>
  const runtime = { worldDir: opts.worldDir, serverJar: opts.serverJar ?? null }
  const results: AnalysisRunResult[] = []
  const runId = new Date().toISOString().replace(/[:.]/g, "-")
  const outDir = join(opts.outDir, runId)
  await mkdir(outDir, { recursive: true })

  for (const mod of modules) {
    const analyzer = mod.create(params)
    const { ctx, store } = contextFor(analyzer, params, runtime)
    const t0 = Date.now()
    let ok = true, error: string | undefined, result: unknown
    let scanned = 0, skipped = 0
    try {
      for (const dim of cfg.analyze.dimensions) {
        const regions = await listRegions(opts.worldDir, dim)
        if (!regions.length) {
          log.warn(`${dim}: 没找到 region 文件（${opts.worldDir}）`)
          continue
        }
        log.info(`${analyzer.name}: ${dim} ${regions.length} 个 region${opts.area ? "，按范围过滤区块" : ""}`)
        for (const r of regions) {
          // 单个 .mca 整文件读入（10MB 级）；reader 的 blob 惰性读取只对 zip 世界生效。
          // world.chunks 只列 header 里真实存在的区块，不是 1024 个槽位。
          const bytes = await readFile(r.path)
          if (!bytes.length) continue
          const world = await read(bytes, { region: [r.x, r.z] }) as World
          const area = opts.area
          const chunks = area ? world.chunks.filter(c => chunkInArea(c.cx, c.cz, area)) : world.chunks
          scanned += chunks.length
          skipped += world.chunks.length - chunks.length
          if (!chunks.length) continue
          const session: RegionSession = { dimension: dim, x: r.x, z: r.z, path: r.path, world, chunks, bytes }
          await analyzer.onRegion?.(session, ctx)
          if (analyzer.onChunk) {
            for (const ref of chunks) {
              await analyzer.onChunk(makeHandle(world, ref, bytes), ctx)
            }
          }
        }
      }
      const finalized = await analyzer.finalize?.(ctx)
      result = finalized === undefined ? { ...store } : { ...store, ...(finalized as object) }
    } catch (e) {
      ok = false
      error = (e as Error).message
      log.error(`${analyzer.name} 失败：${error}`)
    }
    const durationMs = Date.now() - t0
    const payload = {
      analyzer: analyzer.name,
      description: analyzer.description,
      generatedAt: new Date().toISOString(),
      world: basename(opts.worldDir),
      dimensions: cfg.analyze.dimensions,
      area: opts.area ? describeArea(opts.area) : "all",
      chunksScanned: scanned,
      chunksSkipped: skipped,
      durationMs,
      ok,
      error,
      result,
    }
    await writeFile(join(outDir, `${analyzer.name}.json`), JSON.stringify(payload, null, 2), "utf8")
    results.push({ analyzer: analyzer.name, description: analyzer.description, ok, error, durationMs, result })
    log.info(`${analyzer.name} 完成 ${(durationMs / 1000).toFixed(2)}s`)
  }

  await writeFile(join(outDir, "summary.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    world: opts.worldDir,
    dimensions: cfg.analyze.dimensions,
    area: opts.area ? describeArea(opts.area) : "all",
    analyzers: results.map(r => ({ name: r.analyzer, ok: r.ok, error: r.error, durationMs: r.durationMs })),
  }, null, 2), "utf8")
  log.info(`结果已写入 ${outDir}`)
  return results
}
