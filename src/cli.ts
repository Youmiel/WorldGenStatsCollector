#!/usr/bin/env node
import { readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, serverDir, type Config, type PregenTarget } from "./lib/config.js"
import { ensureInstaller, installServer, type InstalledServer } from "./lib/fabric.js"
import { installMods } from "./lib/mods.js"
import { ensureDir, exists, log, setLogLevel } from "./lib/util.js"
import { MinecraftServer, dimensionDirs, tuneC2me, tuneChunky, vanillaServerJar, writeServerConfigs } from "./lib/server.js"
import { runPregen } from "./lib/pregen.js"
import { ensureWorldgenReports } from "./lib/datagen.js"
import { ensureSeed } from "./lib/seed.js"
import { productionNames, resolveAnalyzers } from "./analyze/registry.js"
import { describeArea } from "./analyze/range.js"
import { runAnalysis } from "./analyze/runner.js"
import { buildTarget, readLevelSeed } from "./analyze/target.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.WGS_ROOT ? resolve(process.env.WGS_ROOT) : resolve(HERE, "..")

interface Args {
  _: string[]
  [k: string]: string | boolean | string[]
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith("--")) { out[key] = next; i++ }
      else out[key] = true
    } else out._.push(a)
  }
  return out
}

const num = (v: unknown): number | undefined => (v === undefined ? undefined : Number(v))

/** CLI 参数只影响本次运行，不写回配置文件（避免一次 --analyzers 影响后续 run） */
async function applyOverrides(cfg: Config, args: Args): Promise<Config> {
  const c = structuredClone(cfg)
  if (args.version) c.minecraft.version = String(args.version)
  if (args["server-dir"]) c.server.dir = String(args["server-dir"])
  if (args.loader) c.minecraft.loader = String(args.loader)
  if (args.seed !== undefined) {
    c.server.seed = String(args.seed)
    c.server.seedSource = "explicit"
  }
  if (args.mem) c.server.memoryMB = Number(args.mem)
  // 预生成范围参数作用于 `--dimension` 指定的维度；不指定维度时作用于全部维度，
  // 这样 `--radius 1100` 可以一次性改掉多维度配置里的所有半径
  const touched = (): PregenTarget[] => {
    if (args.dimension) {
      const dim = String(args.dimension)
      const found = c.pregen.dimensions.filter(t => t.dimension === dim)
      if (found.length) return found
      // 配置里没有这个维度 → 追加一个默认目标
      const created: PregenTarget = { dimension: dim, shape: "square", center: [0, 0], radius: 256 }
      c.pregen.dimensions.push(created)
      return [created]
    }
    return c.pregen.dimensions
  }
  if (args.radius) for (const t of touched()) t.radius = Number(args.radius)
  if (args.shape) for (const t of touched()) t.shape = String(args.shape) as PregenTarget["shape"]
  if (args.center) {
    const [x, z] = String(args.center).split(",").map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error(`--center 需要 x,z（收到 ${args.center}）`)
    for (const t of touched()) t.center = [x, z]
  }
  // `--dimension` 单独给（无范围参数）表示「只预生成这个维度」
  if (args.dimension && !args.radius && !args.shape && !args.center) {
    const dim = String(args.dimension)
    const found = c.pregen.dimensions.find(t => t.dimension === dim)
    c.pregen.dimensions = [found ?? { dimension: dim, shape: "square", center: [0, 0], radius: 256 }]
  }
  if (args.all) c.analyze.range = "all"
  if (args.area) {
    const [x, z, r] = String(args.area).split(",").map(Number)
    if (![x, z, r].every(Number.isFinite)) throw new Error(`--area 需要 x,z,radius（收到 ${args.area}）`)
    c.analyze.area = { shape: (args["area-shape"] ? String(args["area-shape"]) : "square") as "circle" | "square", center: [x, z], radius: r }
  }
  if (args.timeout) c.pregen.timeoutMinutes = Number(args.timeout)
  if (args.analyzers) c.analyze.analyzers = String(args.analyzers).split(",").map(s => s.trim()).filter(Boolean)
  if (args.parallel !== undefined) c.analyze.parallel = Number(args.parallel)
  return c
}

function serverLogPath(serverDir: string) {
  return join(serverDir, "wgs-server.log")
}

async function cmdSetup(cfg: Config, args: Args, disk: Config): Promise<InstalledServer> {
  cfg = await ensureSeed(cfg, disk, ROOT)
  // 世界已经生成过时，改配置不会重建已有区块；不提醒的话，下一次统计的 target.seed 会和预想不符
  const worldDir = join(serverDir(ROOT, cfg), cfg.server.levelName)
  if (await exists(join(worldDir, "level.dat"))) {
    const existing = await readLevelSeed(worldDir)
    if (existing && existing !== cfg.server.seed) {
      log.warn(`世界已存在且种子不同（存档 ${existing} / 配置 ${cfg.server.seed}）；已有区块不会重建，要复现请先删除 ${worldDir}`)
    }
  }
  const installer = await ensureInstaller(ROOT, Boolean(args["update-installer"]))
  const srv = await installServer(ROOT, cfg, { installer, force: Boolean(args.force) })
  const mods = await installMods(cfg, srv.dir)
  await writeServerConfigs(cfg, srv.dir, { mods: mods.map(m => m.slug) })
  await ensureDir(join(srv.dir, "logs"))

  if (!args["no-boot"]) {
    // 首启：生成 c2me.toml / chunky 配置，并验证服务端确实能起来
    const server = new MinecraftServer({ dir: srv.dir, launcher: srv.launcher, memoryMB: cfg.server.memoryMB, javaPath: cfg.server.javaPath, javaArgs: cfg.server.javaArgs, logPath: serverLogPath(srv.dir) })
    try {
      log.info("首次启动以生成配置（不预生成）…")
      await server.start()
      await server.waitReady(600_000)
      await server.stop()
    } catch (e) {
      log.error(`服务端启动失败，见 ${serverLogPath(srv.dir)}`)
      throw e
    }
    await tuneC2me(srv.dir, cfg.mods.c2meThreads, cfg.mods.c2mePriority)
    await tuneChunky(srv.dir, { updateInterval: 3 })
    log.info(`服务端配置：${srv.dir}`)
  }
  return srv
}

async function loadServer(cfg: Config): Promise<InstalledServer> {
  const dir = serverDir(ROOT, cfg)
  const marker = join(dir, ".install.json")
  if (!(await exists(marker))) throw new Error(`服务端未安装（${marker}），先运行 setup`)
  return JSON.parse(await readFile(marker, "utf8")) as InstalledServer
}

async function cmdPregen(cfg: Config): Promise<void> {
  const srv = await loadServer(cfg)
  await tuneC2me(srv.dir, cfg.mods.c2meThreads, cfg.mods.c2mePriority)
  await tuneChunky(srv.dir, { updateInterval: 3 })
  const server = new MinecraftServer({
    dir: srv.dir,
    launcher: srv.launcher,
    memoryMB: cfg.server.memoryMB,
    javaPath: cfg.server.javaPath,
    javaArgs: cfg.server.javaArgs,
    logPath: serverLogPath(srv.dir),
  })
  const res = await runPregen({ server, cfg, logPath: serverLogPath(srv.dir) })
  const out = join(srv.dir, "pregen-last.json")
  // 只覆盖本次跑过的维度：用 --dimension 单独补跑某个维度时，
  // 其它维度已生成的范围记录仍然有效，不该被丢掉
  const merged = mergePregenRecord(await readPregenRecord(out), res)
  await import("node:fs/promises").then(fs => fs.writeFile(out, JSON.stringify(merged, null, 2)))
  log.info(`预生成记录 ${out}`)
}

interface PregenRangeRecord {
  dimension: string
  shape: "circle" | "square"
  center: [number, number]
  radius: number
  chunkBounds: { minX: number, maxX: number, minZ: number, maxZ: number }
}

interface PregenRecord {
  ranges: PregenRangeRecord[]
  started?: string
  finished?: string
  chunks?: number
  percent?: number
  elapsedMs?: number
  logPath?: string
}

/** 读已有的预生成记录；旧版单 range 形态也认 */
async function readPregenRecord(path: string): Promise<PregenRecord | null> {
  if (!(await exists(path))) return null
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<PregenRecord> & { range?: PregenRangeRecord }
    const ranges = raw.ranges ?? (raw.range ? [raw.range] : [])
    return ranges.length ? { ...raw, ranges } : null
  } catch {
    return null
  }
}

/** 本次跑过的维度覆盖旧记录，其余维度保留 */
function mergePregenRecord(prev: PregenRecord | null, cur: PregenRecord): PregenRecord {
  const ran = new Set(cur.ranges.map(r => r.dimension))
  const kept = (prev?.ranges ?? []).filter(r => !ran.has(r.dimension))
  const ranges = [...kept, ...cur.ranges].sort((a, b) => a.dimension.localeCompare(b.dimension))
  return { ...cur, ranges }
}

/**
 * 按维度解析统计范围：显式 area > pregen 记录 > 全量。
 *
 * 每个维度范围不同（下界坐标 1:8，半径取主世界 1/8 才对应"走过同等距离"），
 * 所以不能再用单一 Area。返回值键是配置里的维度名（overworld / the_nether）。
 * 显式 `--area` 是单值的，会应用到所有维度。
 */
async function resolveAreas(cfg: Config): Promise<Map<string, Config["analyze"]["area"]>> {
  const out = new Map<string, Config["analyze"]["area"]>()
  const explicit = cfg.analyze.area
  if (explicit) {
    for (const d of cfg.analyze.dimensions) out.set(d, explicit)
    return out
  }
  if (cfg.analyze.range === "all") {
    for (const d of cfg.analyze.dimensions) out.set(d, null)
    return out
  }

  const p = join(serverDir(ROOT, cfg), "pregen-last.json")
  const rec = await readPregenRecord(p)
  if (!rec?.ranges.length) {
    log.warn("没有预生成范围记录，按全量统计")
    for (const d of cfg.analyze.dimensions) out.set(d, null)
    return out
  }
  for (const d of cfg.analyze.dimensions) {
    const hit = rec.ranges.find(r => r.dimension === d)
    if (!hit) {
      log.warn(`${d} 没有预生成范围记录，按全量统计`)
      out.set(d, null)
      continue
    }
    out.set(d, { shape: hit.shape, center: hit.center, radius: hit.radius, chunkBounds: hit.chunkBounds })
  }
  return out
}

async function cmdAnalyze(cfg: Config): Promise<void> {
  const srvDir = serverDir(ROOT, cfg)
  const worldDir = join(srvDir, cfg.server.levelName)
  const dimDirs = cfg.analyze.dimensions.flatMap(d => dimensionDirs(worldDir, d))
  const found = await Promise.all(dimDirs.map(d => exists(d)))
  if (!found.some(Boolean)) throw new Error(`找不到存档 region 目录（试过：${dimDirs.join(", ")}）`)
  const modules = await resolveAnalyzers(cfg.analyze.analyzers, resolve(ROOT, cfg.analyze.pluginDir))
  const outDir = resolve(ROOT, cfg.analyze.outDir)
  const areas = await resolveAreas(cfg)
  const areaDesc = [...areas.entries()]
    .map(([d, a]) => `${d}: ${a ? describeArea(a) : "全量"}`)
    .join(" | ")
  log.info(`统计范围：${areaDesc}`)
  const serverJar = await vanillaServerJar(srvDir, cfg.minecraft.version)
  await ensureWorldgenReports(srvDir, serverJar, cfg.server.javaPath)
  const target = await buildTarget({ cfg, serverDir: srvDir, worldDir, serverJar })
  const results = await runAnalysis({ cfg, worldDir, outDir, areas, serverJar, target }, modules)

  console.log("\n=== 统计结果 ===")
  for (const r of results) {
    console.log(`- ${r.analyzer}: ${r.ok ? "ok" : "失败"} (${(r.durationMs / 1000).toFixed(2)}s)`)
    if (r.error) console.log(`    ${r.error}`)
    if (!r.ok) continue
    const nested = (r.result ?? {}) as Record<string, unknown>
    for (const [dim, value] of Object.entries(nested)) {
      if (!value || typeof value !== "object") continue
      const lines = modules.find(m => m.name === r.analyzer)?.format?.(value) ?? []
      if (!lines.length) continue
      console.log(`    [${dim}]`)
      for (const line of lines) console.log(`      ${line}`)
    }
  }
}

async function cmdInfo(cfg: Config) {
  const srvDir = serverDir(ROOT, cfg)
  const installed = await exists(join(srvDir, ".install.json"))
  console.log(`项目根: ${ROOT}`)
  console.log(`目标版本: MC ${cfg.minecraft.version} / loader ${cfg.minecraft.loader ?? "latest"}`)
  console.log(`服务端: ${installed ? srvDir : "未安装"}`)
  if (installed) {
    const mods = await exists(join(srvDir, "mods")) ? (await import("node:fs/promises")).readdir(join(srvDir, "mods")) : []
    console.log(`mods: ${(await mods).join(", ") || "(空)"}`)
  }
  console.log(`预生成: ${cfg.pregen.dimensions.map(t => `${t.dimension} ${t.shape} r=${t.radius} center=${t.center.join(",")}`).join(" | ")}`)
  const names = cfg.analyze.analyzers.length ? cfg.analyze.analyzers : await productionNames()
  console.log(`分析器: ${names.join(", ")}`)
  console.log(`统计目录: ${resolve(ROOT, cfg.analyze.outDir)}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] ?? "help"
  if (args.verbose) setLogLevel("debug")

  const base = await loadConfig(ROOT)
  const cfg = await applyOverrides(base, args)

  switch (cmd) {
    case "setup":
      await cmdSetup(cfg, args, base)
      await cmdInfo(cfg)
      break
    case "pregen":
      await cmdPregen(cfg)
      break
    case "analyze":
      await cmdAnalyze(cfg)
      break
    case "run":
      await cmdSetup(cfg, args, base)
      await cmdPregen(cfg)
      await cmdAnalyze(cfg)
      break
    case "info":
      await cmdInfo(cfg)
      break
    case "clean": {
      const targets = [resolve(ROOT, cfg.analyze.outDir)]
      if (args.all) targets.push(serverDir(ROOT, cfg))
      for (const t of targets) {
        log.info(`删除 ${t}`)
        await rm(t, { recursive: true, force: true })
      }
      break
    }
    default:
      console.log(`WorldGenStatsCollector

用法: node dist/cli.js <命令> [选项]

命令:
  setup     下载/更新 fabric-installer，安装指定版本服务端与模组，写配置并首启验证
  pregen    启动服务端并用 Chunky 预生成区块
  analyze   读取存档（minecraft-block-reader）并运行统计器
  run       setup → pregen → analyze
  info      显示当前配置与安装状态
  clean     删除统计结果（--all 同时删除服务端）

选项:
  --version <mc>         Minecraft 版本（默认 26.3）
  --server-dir <dir>     服务端目录（多版本并存用）
  --loader <ver>         Fabric loader 版本
  --seed <seed>          世界种子
  --mem <MB>             JVM 堆（默认 2048）
  --radius <blocks>      预生成半径（默认 256）
  --shape <circle|square>
  --center <x,z>         预生成中心
  --dimension <dim>      overworld / the_nether / the_end
  --all                  统计全量（忽略预生成范围）
  --area <x,z,r>         手动指定统计范围（默认方形，与 Chunky 的区块铺开一致）
  --area-shape <circle|square>
  --timeout <min>        预生成超时
  --analyzers <a,b>      指定分析器（默认只跑生产分析器；all = 全部，examples = 示例）
  --parallel <n>         分析器并行度（worker 线程数；默认 4，0/1 = 串行）
  --no-boot              setup 后不启动服务端
  --update-installer     强制检查/更新 fabric-installer
  --force                重装服务端
  --verbose              详细日志
      `)
  }
}

main().catch(e => {
  log.error((e as Error).message)
  process.exitCode = 1
})
