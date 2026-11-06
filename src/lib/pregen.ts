import type { Config } from "./config.js"
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
  range: PregenRange
  started: string
  finished: string
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
  const world = chunkyWorldName(cfg.pregen.dimension)
  const { shape, center, radius, timeoutMinutes } = cfg.pregen

  await server.start()
  await server.waitReady()

  // chunky 的进度输出默认 1s 一条，拉长到 3s 减少刷屏
  server.send("chunky quiet 3")

  let lastLogged = 0
  let lastPercent = 0
  let lastChunks = 0
  const unbind = server.onLine(line => {
    const m = line.match(RUNNING)
    if (m) {
      lastChunks = Number(m[1].replace(/,/g, ""))
      lastPercent = Number(m[2])
      const now = Date.now()
      if (now - lastLogged > 5000) {
        lastLogged = now
        log.info(`预生成 ${pct(lastPercent, 100, 1)} (${lastChunks} chunks)`)
      }
    }
  })

  const startedAt = new Date()
  log.info(`预生成 ${world} ${shape} center=${center.join(",")} radius=${radius}（约 ${estimateChunks(shape, radius)} 区块）`)

  server.send(`chunky world ${world}`)
  server.send(`chunky shape ${shape}`)
  server.send(`chunky center ${center[0]} ${center[1]}`)
  server.send(`chunky radius ${radius}`)
  server.send("chunky start")

  const timeoutMs = timeoutMinutes * 60_000
  let finishedLine: string
  try {
    finishedLine = await server.waitFor(l => FINISHED.test(l) || STOPPED.test(l), { timeoutMs })
  } catch (e) {
    await server.stop(60_000)
    throw new Error(`预生成未完成：${(e as Error).message}`)
  } finally {
    unbind()
  }

  const fm = finishedLine.match(FINISHED)
  const chunks = fm ? Number(fm[1].replace(/,/g, "")) : lastChunks
  log.info(`预生成完成：${fm ? `${chunks} chunks` : "任务被停止"}，用时 ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s`)

  if (cfg.pregen.settleSeconds > 0) {
    log.info(`等待 ${cfg.pregen.settleSeconds}s 让在途区块落盘…`)
    await sleep(cfg.pregen.settleSeconds * 1000)
  }
  await server.stop()
  return {
    range: {
      dimension: cfg.pregen.dimension,
      shape,
      center,
      radius,
      chunkBounds: chunkBounds(center, radius),
    },
    started: startedAt.toISOString(),
    finished: new Date().toISOString(),
    chunks,
    percent: fm ? 100 : lastPercent,
    elapsedMs: Date.now() - startedAt.getTime(),
    logPath,
  }
}
