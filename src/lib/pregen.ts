import type { Config, PregenTarget } from "./config.js"
import { chunkyWorldName, MinecraftServer } from "./server.js"
import { log, pct, sleep } from "./util.js"

export interface PregenRange {
  dimension: string
  shape: "circle" | "square"
  center: [number, number]
  radius: number
  /** Chunky 实际按区块切比雪夫方形铺开：r=128 → 17x17=289，与 processed 数一致 */
  chunkBounds: { minX: number, maxX: number, minZ: number, maxZ: number }
}

export interface PregenResult {
  /** 每个维度一份；顺序与 cfg.pregen.dimensions 一致 */
  ranges: PregenRange[]
  started: string
  finished: string
  /** 各维度 processed 区块数之和 */
  chunks: number
  percent: number
  elapsedMs: number
  logPath: string
}

// Chunky 的日志原文（lang/en.json）：
//   Task running  for minecraft:overworld. Processed: 33 chunks (11.42%), ETA: 0:00:21, Rate: 11.8 cps
//   Task finished for minecraft:overworld. Processed: 289 chunks (100.00%), Total time: 0:00:07
//   Task stopped  for minecraft:overworld.
// 完成判定只看 Task finished（有 Processed 数）；被 cancel 时只有 Task stopped。
const RUNNING = /Task running for .*?Processed:\s*([\d,]+) chunks \((\d+(?:\.\d+)?)%\)/
const FINISHED = /Task finished for .*?Processed:\s*([\d,]+) chunks/
const STOPPED = /Task stopped for/

/**
 * 选区的外接方形区块包围盒（不区分形状）。
 *
 * - square：就是选区本身（切比雪夫方形）
 * - circle：外接正方形，只是「上限盒」，真正的圆要由 chunkInArea 再按欧氏距离裁一次
 *
 * 实测（r=1100 方块）：circle 落盘的是真欧氏圆 —— 每层区块数 ≈ 2πd，d=72 区块处归零；
 * square 则是切比雪夫方形（r=128 → 289 = 17x17）。所以这个盒不能单独当成统计范围。
 */
export function chunkBounds(center: [number, number], radius: number) {
  const r = Math.ceil(radius / 16)
  const cx = Math.floor(center[0] / 16)
  const cz = Math.floor(center[1] / 16)
  return { minX: cx - r, maxX: cx + r, minZ: cz - r, maxZ: cz + r }
}

/** 估算选区内的区块数（仅用于展示，实际以 chunky 的 processed 为准） */
export function estimateChunks(shape: string, radius: number): number {
  const area = shape === "circle" ? Math.PI * radius * radius : (radius * 2) ** 2
  return Math.ceil(area / 256)
}

export interface PregenOptions {
  server: MinecraftServer
  cfg: Config
  logPath: string
}

export async function runPregen({ server, cfg, logPath }: PregenOptions): Promise<PregenResult> {
  const targets = cfg.pregen.dimensions
  if (!targets.length) throw new Error("pregen.dimensions 为空，没有要预生成的维度")
  const { timeoutMinutes } = cfg.pregen

  await server.start()
  await server.waitReady()

  // chunky 的进度输出默认 1s 一条，拉长到 3s 减少刷屏
  server.send("chunky quiet 3")

  const startedAt = new Date()
  const ranges: PregenRange[] = []
  let totalChunks = 0
  let allFinished = true

  const timeoutMs = timeoutMinutes * 60_000
  try {
    for (const t of targets) {
      const r = await pregenOne(server, t, timeoutMs)
      ranges.push(r.range)
      totalChunks += r.chunks
      allFinished &&= r.finished
    }
  } catch (e) {
    await server.stop(60_000)
    throw new Error(`预生成未完成：${(e as Error).message}`)
  }

  log.info(`预生成全部完成：${ranges.length} 个维度，共 ${totalChunks} chunks，用时 ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s`)

  if (cfg.pregen.settleSeconds > 0) {
    log.info(`等待 ${cfg.pregen.settleSeconds}s 让在途区块落盘…`)
    await sleep(cfg.pregen.settleSeconds * 1000)
  }
  await server.stop()
  return {
    ranges,
    started: startedAt.toISOString(),
    finished: new Date().toISOString(),
    chunks: totalChunks,
    percent: allFinished ? 100 : 0,
    elapsedMs: Date.now() - startedAt.getTime(),
    logPath,
  }
}

/** 跑单个维度：切 world/shape/center/radius，等 Task finished */
async function pregenOne(
  server: MinecraftServer,
  t: PregenTarget,
  timeoutMs: number,
): Promise<{ range: PregenRange, chunks: number, finished: boolean }> {
  const world = chunkyWorldName(t.dimension)
  const { shape, center, radius } = t

  let lastLogged = 0
  let lastPercent = 0
  let lastChunks = 0
  const unbind = server.onLine(line => {
    const m = line.match(RUNNING)
    if (!m) return
    lastChunks = Number(m[1].replace(/,/g, ""))
    lastPercent = Number(m[2])
    const now = Date.now()
    if (now - lastLogged > 5000) {
      lastLogged = now
      log.info(`预生成 ${world} ${pct(lastPercent, 100, 1)} (${lastChunks} chunks)`)
    }
  })

  log.info(`预生成 ${world} ${shape} center=${center.join(",")} radius=${radius}（约 ${estimateChunks(shape, radius)} 区块）`)

  try {
    server.send(`chunky world ${world}`)
    server.send(`chunky shape ${shape}`)
    server.send(`chunky center ${center[0]} ${center[1]}`)
    server.send(`chunky radius ${radius}`)
    server.send("chunky start")

    const finishedLine = await server.waitFor(l => FINISHED.test(l) || STOPPED.test(l), { timeoutMs })
    const fm = finishedLine.match(FINISHED)
    const chunks = fm ? Number(fm[1].replace(/,/g, "")) : lastChunks
    log.info(`预生成 ${world} 完成：${fm ? `${chunks} chunks` : "任务被停止"}`)
    return {
      range: { dimension: t.dimension, shape, center, radius, chunkBounds: chunkBounds(center, radius) },
      chunks,
      finished: Boolean(fm),
    }
  } finally {
    unbind()
  }
}
