import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readFile, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

export type LogLevel = "debug" | "info" | "warn" | "error"
let level: LogLevel = "info"
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function setLogLevel(l: LogLevel) { level = l }
const t0 = Date.now()
const stamp = () => {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6, " ")
  return `[${s}s]`
}
export const log = {
  debug: (...a: unknown[]) => order[level] <= 10 && console.log(stamp(), ...a),
  info: (...a: unknown[]) => order[level] <= 20 && console.log(stamp(), ...a),
  warn: (...a: unknown[]) => order[level] <= 30 && console.warn(stamp(), "WARN", ...a),
  error: (...a: unknown[]) => order[level] <= 40 && console.error(stamp(), "ERR ", ...a),
}

export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

export async function ensureDir(path: string) { await mkdir(path, { recursive: true }) }

export function sha1(buf: Uint8Array | string): string {
  return createHash("sha1").update(buf).digest("hex")
}

export interface RunResult { code: number, stdout: string, stderr: string, cmd: string }

export function run(cmd: string, args: string[], opts: { cwd?: string, env?: NodeJS.ProcessEnv, echo?: boolean } = {}): Promise<RunResult> {
  const line = `${cmd} ${args.map(a => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`
  log.debug("$", line)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env })
    let stdout = "", stderr = ""
    child.stdout.on("data", d => { stdout += d; if (opts.echo) process.stdout.write(d) })
    child.stderr.on("data", d => { stderr += d; if (opts.echo) process.stderr.write(d) })
    child.on("error", reject)
    child.on("close", code => resolve({ code: code ?? -1, stdout, stderr, cmd: line }))
  })
}

export async function getJson<T>(url: string, headers: Record<string, string> = {}, attempts = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "WorldGenStatsCollector/0.1", ...headers } })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      return await res.json() as T
    } catch (e) {
      lastErr = e
      await new Promise(r => setTimeout(r, 800 * (i + 1)))
    }
  }
  throw lastErr
}

/** 下载并校验（可选 sha1），返回落盘路径。已存在且校验通过则跳过。 */
export async function download(url: string, dest: string, opts: { sha1?: string, label?: string } = {}): Promise<string> {
  const label = opts.label ?? dest.split("/").pop()
  if (await exists(dest)) {
    if (!opts.sha1) { log.debug(`${label} 已存在，跳过`); return dest }
    const cur = sha1(await readFile(dest))
    if (cur === opts.sha1) { log.debug(`${label} 已存在且校验通过`); return dest }
    log.warn(`${label} 校验不符，重新下载`)
  }
  await ensureDir(dirname(dest))
  log.info(`下载 ${label} …`)
  const res = await fetch(url, { headers: { "User-Agent": "WorldGenStatsCollector/0.1" } })
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  const total = Number(res.headers.get("content-length") ?? 0)
  let done = 0, lastPrint = 0
  const body = Readable.fromWeb(res.body as any)
  body.on("data", (c: Buffer) => {
    done += c.length
    const now = Date.now()
    if (now - lastPrint > 1500) {
      lastPrint = now
      const pct = total ? ` (${((done / total) * 100).toFixed(0)}%)` : ""
      process.stdout.write(`\r  ${label} ${(done / 1048576).toFixed(1)}MB${pct}   `)
    }
  })
  await pipeline(body, createWriteStream(dest))
  process.stdout.write("\r")
  if (opts.sha1) {
    const got = sha1(await readFile(dest))
    if (got !== opts.sha1) throw new Error(`${label} sha1 不符: ${got} != ${opts.sha1}`)
  }
  log.info(`${label} 完成 ${(done / 1048576).toFixed(1)}MB`)
  return dest
}

export class TimeoutError extends Error {}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(`超时 ${ms}ms: ${what}`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/§[0-9a-fklmnor]/gi, "")
}

export function pct(n: number, d: number, digits = 2): string {
  if (!d) return "0%"
  return `${((n / d) * 100).toFixed(digits)}%`
}
