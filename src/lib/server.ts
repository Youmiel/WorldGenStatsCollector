import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createWriteStream } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Config } from "./config.js"
import { ensureDir, exists, log, stripAnsi, TimeoutError } from "./util.js"

/**
 * 原版服务端 jar：bundler 里的 versions/<mc>/server-<mc>.jar。
 * 数据包（结构集合、世界预设等）只在这里面，取不到返回 null。
 */
export async function vanillaServerJar(serverDir: string, version: string): Promise<string | null> {
  const exact = join(serverDir, "versions", version, `server-${version}.jar`)
  if (await exists(exact)) return exact
  try {
    const dirs = (await readdir(join(serverDir, "versions"))).sort().reverse()
    for (const d of dirs) {
      const p = join(serverDir, "versions", d, `server-${d}.jar`)
      if (await exists(p)) return p
    }
  } catch { /* 1.17.1 及更早没有 versions/ */ }
  return null
}

/**
 * 26.x 起存档按维度分目录：world/dimensions/minecraft/<dim>/region。
 * 旧版（<=1.21）是 world/region、world/DIM-1/region、world/DIM1/region，这里两套都返回。
 */
export function dimensionDirs(worldDir: string, dimension: string): string[] {
  const legacy = dimension === "overworld" ? "" : dimension === "the_nether" ? "DIM-1" : dimension === "the_end" ? "DIM1" : dimension
  return [
    join(worldDir, "dimensions", "minecraft", dimension, "region"),
    join(worldDir, legacy, "region"),
  ]
}

/** Chunky 在 26.x 里用维度 id 选世界（overworld / the_nether / the_end），不是 level-name */
export function chunkyWorldName(dimension: string): string {
  return dimension
}

export interface ServerConfigs { mods: string[] }

/** 写 eula / server.properties / chunky 配置；c2me 的 toml 由 mod 首次启动生成后再调 */
export async function writeServerConfigs(cfg: Config, serverDir: string, opts: { mods: string[] }): Promise<ServerConfigs> {
  await ensureDir(serverDir)
  await writeFile(join(serverDir, "eula.txt"), `# 由 WorldGenStatsCollector 生成\neula=true\n`, "utf8")

  const props: Record<string, string> = {
    "level-name": cfg.server.levelName,
    "level-seed": cfg.server.seed,
    "level-type": cfg.server.levelType,
    "online-mode": "false",
    "view-distance": String(cfg.server.viewDistance),
    "simulation-distance": String(cfg.server.simulationDistance),
    "max-players": "1",
    "spawn-protection": "0",
    "difficulty": "peaceful",
    // 无玩家时服务端会暂停 tick，预生成会卡住
    "pause-when-empty-seconds": "0",
    "sync-chunk-writes": "true",
    "motd": "WorldGenStatsCollector",
    "enable-rcon": "false",
    "enable-query": "false",
  }
  const propsPath = join(serverDir, "server.properties")
  const existing = (await exists(propsPath)) ? await readFile(propsPath, "utf8") : ""
  const merged = mergeProperties(existing, props)
  await writeFile(propsPath, merged, "utf8")

  return { mods: opts.mods }
}

function mergeProperties(existing: string, overrides: Record<string, string>): string {
  const lines = existing.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith("#"))
  const map = new Map<string, string>()
  for (const l of lines) {
    const i = l.indexOf("=")
    if (i > 0) map.set(l.slice(0, i), l.slice(i + 1))
  }
  for (const [k, v] of Object.entries(overrides)) map.set(k, v)
  const out = ["# 由 WorldGenStatsCollector 生成/合并"]
  for (const [k, v] of map) out.push(`${k}=${v}`)
  return out.join("\n") + "\n"
}

/**
 * Chunky 的 fabric 版读 config/chunky/config.json（bukkit 版才是 config.yml），
 * 文件由 mod 首启生成，这里只合并我们关心的键。
 */
export async function tuneChunky(serverDir: string, opts: { updateInterval?: number } = {}): Promise<boolean> {
  const p = join(serverDir, "config", "chunky", "config.json")
  if (!(await exists(p))) return false
  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>
  } catch {
    log.warn(`chunky config.json 解析失败，跳过调整`)
    return false
  }
  cfg.continueOnRestart = false
  cfg.forceLoadExistingChunks = false
  cfg.silent = false
  if (opts.updateInterval) cfg.updateInterval = opts.updateInterval
  await writeFile(p, JSON.stringify(cfg, null, 2), "utf8")
  return true
}

/**
 * c2me 的 config/c2me.toml 只有首次启动后才会有。
 * 这里只改已存在的键，避免把未知键写坏。
 */
export async function tuneC2me(serverDir: string, threads: number | null, priority: string | null): Promise<boolean> {
  const p = join(serverDir, "config", "c2me.toml")
  if (!(await exists(p))) return false
  let text = await readFile(p, "utf8")
  let changed = false
  if (threads !== null) {
    const before = text
    // c2me 0.4.x 的并行度是 globalExecutorParallelism（默认哨兵值 "default"）
    text = text.replace(/^(\s*globalExecutorParallelism\s*=\s*).*$/m, `$1${threads}`)
    text = text.replace(/^(\s*defaultGlobalExecutorParallelismExpression\s*=\s*).*$/m, `$1"${threads}"`)
    if (text !== before) changed = true
  }
  if (priority !== null) {
    const before = text
    // 小机器/ARM 上设 LOW 让出 CPU，桌面多核机器可以 HIGH
    text = text.replace(/^(\s*threadPoolPriorityPreset\s*=\s*).*$/m, `$1"${priority}"`)
    if (text !== before) changed = true
  }
  if (changed) {
    await writeFile(p, text, "utf8")
    log.info(`c2me 调整：parallelism=${threads ?? "default"}, priority=${priority ?? "default"}`)
  }
  return true
}

export interface WaitOptions {
  timeoutMs?: number
}

export class MinecraftServer {
  private proc: ChildProcessWithoutNullStreams | null = null
  private lines: string[] = []
  private waiters: { predicate: (l: string) => boolean, resolve: (l: string) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }[] = []
  private exited = false
  readonly logPath: string

  constructor(private opts: { dir: string, launcher: string, memoryMB: number, javaPath?: string | null, javaArgs: string[], logPath: string }) {
    this.logPath = opts.logPath
  }

  get isRunning() { return this.proc !== null && !this.exited }

  async start(): Promise<void> {
    await ensureDir(this.opts.dir)
    const file = createWriteStream(this.logPath, { flags: "a" })
    const java = this.opts.javaPath ?? "java"
    // 预生成是持续满载任务，Xms 给得太小会让堆反复扩容；小堆直接拉满，大堆从 2G 起步
    const xms = Math.min(this.opts.memoryMB, 2048)
    const args = [
      `-Xms${xms}M`,
      `-Xmx${this.opts.memoryMB}M`,
      ...this.opts.javaArgs,
      "-jar", this.opts.launcher, "nogui",
    ]
    log.info(`启动服务端：java -Xms${xms}M -Xmx${this.opts.memoryMB}M -jar ${this.opts.launcher.split("/").pop()} nogui`)
    const proc = spawn(java, args, { cwd: this.opts.dir })
    this.proc = proc
    this.exited = false
    const handle = (chunk: Buffer, stream: NodeJS.WriteStream) => {
      const text = chunk.toString()
      file.write(text)
      if (process.env.WGS_VERBOSE_SERVER) stream.write(text)
      for (const raw of text.split(/\r?\n/)) {
        const line = stripAnsi(raw).trimEnd()
        if (!line) continue
        this.lines.push(line)
        if (this.lines.length > 4000) this.lines.splice(0, 1000)
        for (const fn of this.listeners) {
          try { fn(line) } catch { /* 监听器异常不影响主流程 */ }
        }
        for (const w of [...this.waiters]) {
          if (w.predicate(line)) {
            clearTimeout(w.timer)
            this.waiters.splice(this.waiters.indexOf(w), 1)
            w.resolve(line)
          }
        }
      }
    }
    proc.stdout.on("data", (c: Buffer) => handle(c, process.stdout))
    proc.stderr.on("data", (c: Buffer) => handle(c, process.stderr))
    proc.on("exit", (code, signal) => {
      this.exited = true
      file.end()
      for (const w of [...this.waiters]) {
        clearTimeout(w.timer)
        w.reject(new Error(`服务端退出 (code=${code} signal=${signal})\n${this.tail(15)}`))
      }
      this.waiters = []
      log.info(`服务端进程结束 code=${code} signal=${signal}`)
    })
    proc.stdin.on("error", () => { /* 进程已退出时的 EPIPE，忽略 */ })
  }

  /** 等待匹配日志行 */
  waitFor(predicate: (l: string) => boolean, opts: WaitOptions): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 120_000
    // 先扫历史，避免竞态
    for (const l of this.lines) {
      if (predicate(l)) return Promise.resolve(l)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w.timer !== timer)
        reject(new TimeoutError(`等待日志超时（${timeoutMs}ms）\n最近日志：\n${this.tail(20)}`))
      }, timeoutMs)
      this.waiters.push({ predicate, resolve, reject, timer })
    })
  }

  /** 注册一个观察所有后续日志的监听（不消耗） */
  onLine(fn: (line: string) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private listeners = new Set<(l: string) => void>()

  async waitReady(timeoutMs = 300_000): Promise<void> {
    await this.waitFor(l => /\bDone \([\d.]+s\)!/.test(l), { timeoutMs })
    log.info("服务端就绪")
  }

  send(command: string) {
    if (!this.proc) throw new Error("服务端未启动")
    log.debug(`> ${command}`)
    this.proc.stdin.write(command + "\n")
  }

  tail(n = 20): string {
    return this.lines.slice(-n).join("\n")
  }

  async stop(timeoutMs = 120_000): Promise<void> {
    if (!this.isRunning) return
    try {
      this.send("stop")
      await this.waitForExit(timeoutMs)
    } catch {
      log.warn("服务端未按时退出，发送 SIGTERM")
      this.proc?.kill("SIGTERM")
      await new Promise(r => setTimeout(r, 3000))
      if (this.isRunning) this.proc?.kill("SIGKILL")
    }
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.proc) return resolve()
      const t = setTimeout(() => reject(new TimeoutError("等待退出超时")), timeoutMs)
      this.proc.once("exit", () => { clearTimeout(t); resolve() })
    })
  }
}
