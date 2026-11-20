/**
 * 分析 worker：跑一组分析器，把快照回传给主线程。
 *
 * 为什么要进程内的 worker 而不是子进程：分析器的 `result` 动辄几百 KB 到 1 MB
 * （`ore-stats` 主世界近 1 MB），走文件或 stdout 都要序列化两遍；worker_threads
 * 的结构化克隆一次到位，而且能共用同一份 `AnalyzerRunSnapshot` 类型。
 *
 * 这个文件只做三件事：解出模块、跑 `runModules`、postMessage 回传。
 * 产物写盘仍由主线程负责，所以顺序与串行完全一致。
 */

import { parentPort, workerData } from "node:worker_threads"
import { resolveAnalyzers } from "./registry.js"
import { runModules } from "./runner.js"
import type { AnalyzeOptions, AnalyzerRunSnapshot, ProgressTick, WorkerInit } from "./runner.js"

const init = workerData as WorkerInit

async function main(): Promise<void> {
  const modules = await resolveAnalyzers(init.names, init.pluginDir)
  const opts: AnalyzeOptions = {
    cfg: init.cfg,
    worldDir: init.worldDir,
    outDir: init.runOutDir,
    areas: new Map(init.areas),
    serverJar: init.serverJar,
    // 本进程不写产物头部，`target` 只用于 payload，这里给一个占位即可
    target: {
      minecraftVersion: init.cfg.minecraft.version,
      levelName: init.cfg.server.levelName,
      loader: init.cfg.minecraft.loader ?? "vanilla",
      seed: null,
      seedMode: "unknown",
      dataPacks: [],
      serverJarSha256: null,
    },
  }
  const snapshots: AnalyzerRunSnapshot[] = await runModules(
    opts,
    modules,
    init.runOutDir,
    // 进度心跳：只回传计数，主线程汇总后画同一条进度线
    (tick: ProgressTick) => parentPort?.postMessage({ type: "progress", tick }),
  )
  parentPort?.postMessage(snapshots)
}

main().catch((err: unknown) => {
  // 直接把异常抛给 worker 的 `error` 事件，主线程据此判定这一组失败
  throw err
})
