#!/usr/bin/env node
import { readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, serverDir, type Config } from "./lib/config.js"
import { ensureInstaller, installServer, type InstalledServer } from "./lib/fabric.js"
import { installMods } from "./lib/mods.js"
import { ensureDir, exists, log, setLogLevel } from "./lib/util.js"
import { MinecraftServer, dimensionDirs, tuneC2me, tuneChunky, vanillaServerJar, writeServerConfigs } from "./lib/server.js"
import { runPregen } from "./lib/pregen.js"
import { productionNames, resolveAnalyzers } from "./analyze/registry.js"
import { describeArea } from "./analyze/range.js"
import { runAnalysis } from "./analyze/runner.js"

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
  if (args.seed !== undefined) c.server.seed = String(args.seed)
  if (args.mem) c.server.memoryMB = Number(args.mem)
  if (args.radius) c.pregen.radius = Number(args.radius)
  if (args.shape) c.pregen.shape = String(args.shape) as Config["pregen"]["shape"]
  if (args.center) {
    const [x, z] = String(args.center).split(",").map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error(`--center 需要 x,z（收到 ${args.center}）`)
    c.pregen.center = [x, z]
  }
  if (args.dimension) c.pregen.dimension = String(args.dimension)
  if (args.all) c.analyze.range = "all"
  if (args.area) {
    const [x, z, r] = String(args.area).split(",").map(Number)
    if (![x, z, r].every(Number.isFinite)) throw new Error(`--area 需要 x,z,radius（收到 ${args.area}）`)
    c.analyze.area = { shape: (args["area-shape"] ? String(args["area-shape"]) : "circle") as "circle" | "square", center: [x, z], radius: r }
  }
  if (args.timeout) c.pregen.timeoutMinutes = Number(args.timeout)
  if (args.analyzers) c.analyze.analyzers = String(args.analyzers).split(",").map(s => s.trim()).filter(Boolean)
  return c
}

function serverLogPath(serverDir: string) {
  return join(serverDir, "wgs-server.log")
}

async function cmdSetup(cfg: Config, args: Args): Promise<InstalledServer> {
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
  await import("node:fs/promises").then(fs => fs.writeFile(out, JSON.stringify(res, null, 2)))
  log.info(`预生成记录 ${out}`)
}

/** 统计范围：显式 area > pregen 记录 > 全量 */
async function resolveArea(cfg: Config): Promise<Config["analyze"]["area"]> {
  if (cfg.analyze.area) return cfg.analyze.area
  if (cfg.analyze.range === "all") return null
  const p = join(serverDir(ROOT, cfg), "pregen-last.json")
  if (!(await exists(p))) {
    log.warn("没有预生成范围记录，按全量统计")
    return null
  }
  const rec = JSON.parse(await readFile(p, "utf8")) as { range?: { shape: "circle" | "square", center: [number, number], radius: number, chunkBounds?: { minX: number, maxX: number, minZ: number, maxZ: number } } }
  if (!rec.range) {
    log.warn("pregen-last.json 里没有 range 字段（旧记录），按全量统计")
    return null
  }
  return { ...rec.range }
}

async function cmdAnalyze(cfg: Config): Promise<void> {
  const srvDir = serverDir(ROOT, cfg)
  const worldDir = join(srvDir, cfg.server.levelName)
  const dimDirs = cfg.analyze.dimensions.flatMap(d => dimensionDirs(worldDir, d))
  const found = await Promise.all(dimDirs.map(d => exists(d)))
  if (!found.some(Boolean)) throw new Error(`找不到存档 region 目录（试过：${dimDirs.join(", ")}）`)
  const modules = await resolveAnalyzers(cfg.analyze.analyzers, resolve(ROOT, cfg.analyze.pluginDir))
  const outDir = resolve(ROOT, cfg.analyze.outDir)
  const area = await resolveArea(cfg)
  log.info(area ? `统计范围：${describeArea(area)}` : "统计范围：全量")
  const serverJar = await vanillaServerJar(srvDir, cfg.minecraft.version)
  const results = await runAnalysis({ cfg, worldDir, outDir, area, serverJar }, modules)

  console.log("\n=== 统计结果 ===")
  for (const r of results) {
    console.log(`- ${r.analyzer}: ${r.ok ? "ok" : "失败"} (${(r.durationMs / 1000).toFixed(2)}s)`)
    if (r.error) console.log(`    ${r.error}`)
    if (!r.ok) continue
    const lines = modules.find(m => m.name === r.analyzer)?.format?.(r.result) ?? []
    for (const line of lines) console.log(`    ${line}`)
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
  console.log(`预生成: ${cfg.pregen.dimension} ${cfg.pregen.shape} r=${cfg.pregen.radius} center=${cfg.pregen.center.join(",")}`)
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
      await cmdSetup(cfg, args)
      await cmdInfo(cfg)
      break
    case "pregen":
      await cmdPregen(cfg)
      break
    case "analyze":
      await cmdAnalyze(cfg)
      break
    case "run":
      await cmdSetup(cfg, args)
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
  --area <x,z,r>         手动指定统计范围
  --area-shape <circle|square>
  --timeout <min>        预生成超时
  --analyzers <a,b>      指定分析器（默认只跑生产分析器；all = 全部，examples = 示例）
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
