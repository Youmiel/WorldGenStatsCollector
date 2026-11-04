import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { serverDir as resolveServerDir, type Config } from "./config.js"
import { download, ensureDir, exists, getJson, log, run, sha1 } from "./util.js"

const INSTALLER_RE = /^fabric-installer-(\d+\.\d+(?:\.\d+)?)\.jar$/

function cmpVer(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

export async function localInstallers(root: string): Promise<{ path: string, version: string }[]> {
  const out: { path: string, version: string }[] = []
  for (const f of await readdir(root)) {
    const m = f.match(INSTALLER_RE)
    if (m) out.push({ path: resolve(root, f), version: m[1] })
  }
  return out.sort((a, b) => cmpVer(b.version, a.version))
}

interface GhRelease {
  tag_name: string
  assets: { name: string, browser_download_url: string }[]
}

interface MetaInstaller {
  url: string
  maven: string
  version: string
  stable: boolean
}

const MAVEN = "https://maven.fabricmc.net/net/fabricmc/fabric-installer"

/**
 * 首选 Fabric 官方 meta API：JSON，带 stable 标记，并直接给出 jar 的下载地址。
 * 这是官网 fabricmc.net 的下载按钮背后的接口。
 */
async function latestFromMeta(): Promise<{ version: string, url: string }> {
  const list = await getJson<MetaInstaller[]>("https://meta.fabricmc.net/v2/versions/installer", {}, 3)
  const pick = list.find(v => v.stable) ?? list[0]
  if (!pick?.url || !pick.version) throw new Error("meta API 没有返回可用的 installer")
  return { version: pick.version, url: pick.url }
}

/** 次选：maven 的 maven-metadata.xml（meta API 不可用时） */
async function latestFromMaven(): Promise<{ version: string, url: string }> {
  const res = await fetch(`${MAVEN}/maven-metadata.xml`, { headers: { "User-Agent": "WorldGenStatsCollector/0.1" } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for maven-metadata.xml`)
  const xml = await res.text()
  const version = /<release>([^<]+)<\/release>/.exec(xml)?.[1] ?? /<latest>([^<]+)<\/latest>/.exec(xml)?.[1]
  if (!version) throw new Error("maven-metadata.xml 里没有版本号")
  return { version, url: `${MAVEN}/${version}/fabric-installer-${version}.jar` }
}

/** 兜底：GitHub releases */
async function latestFromGithub(): Promise<{ version: string, url: string }> {
  const rel = await getJson<GhRelease>("https://api.github.com/repos/FabricMC/fabric-installer/releases/latest", { Accept: "application/vnd.github+json" })
  const version = rel.tag_name.replace(/^v/, "")
  const asset = rel.assets.find(a => a.name.startsWith("fabric-installer") && a.name.endsWith(".jar"))
  if (!asset) throw new Error(`release ${version} 没有 installer jar`)
  return { version, url: asset.browser_download_url }
}

export async function latestInstaller(): Promise<{ version: string, url: string }> {
  try {
    return await latestFromMeta()
  } catch (e) {
    log.warn(`meta API 查询失败（${(e as Error).message}），改试 maven`)
  }
  try {
    return await latestFromMaven()
  } catch (e) {
    log.warn(`maven 查询失败（${(e as Error).message}），改试 GitHub releases`)
  }
  return latestFromGithub()
}

/**
 * 保证项目根有可用的 installer：
 *  - 没有则下载最新；
 *  - update=true 时对比官方 meta 的最新版本并覆盖更新。
 */
export async function ensureInstaller(root: string, update: boolean): Promise<string> {
  const locals = await localInstallers(root)
  const newest = locals[0]
  if (newest && !update) {
    log.info(`使用本地 fabric-installer ${newest.version}`)
    return newest.path
  }
  try {
    const latest = await latestInstaller()
    if (newest && cmpVer(newest.version, latest.version) >= 0) {
      log.info(`本地 installer ${newest.version} 已是最新`)
      return newest.path
    }
    log.info(`下载 fabric-installer ${latest.version}`)
    return await download(latest.url, join(root, `fabric-installer-${latest.version}.jar`), { label: `fabric-installer-${latest.version}.jar` })
  } catch (e) {
    if (newest) {
      log.warn(`检查最新 installer 失败（${(e as Error).message}），继续用本地 ${newest.version}`)
      return newest.path
    }
    throw e
  }
}

export interface InstalledServer {
  dir: string
  launcher: string
  mcVersion: string
  loaderVersion: string | null
}

/** 找出 installer 产出的启动 jar（不同版本命名不一致） */
async function findLauncher(dir: string): Promise<string | null> {
  const files = await readdir(dir)
  const cands = files.filter(f => /^fabric-server.*\.jar$/i.test(f))
  // 优先 launcher 命名的 jar，其次 fabric-server.jar
  cands.sort((a, b) => Number(/launcher/.test(b)) - Number(/launcher/.test(a)))
  return cands[0] ? join(dir, cands[0]) : null
}

/**
 * 安装服务端，等价于手工执行 installer 的 CLI：
 *   java -jar fabric-installer-<v>.jar server -dir <目录> -mcversion <版本> [-loader <loader>] -downloadMinecraft
 * 版本号不确定时，installer 的 `help` 子命令会打印 Latest Version / Latest Loader，可作无网兜底。
 *
 * fabric-server-launcher.properties（serverJar=server.jar）是启动器首次运行时生成的，
 * 不在安装产物里，所以这里只认 fabric-server*.jar。
 */
export async function installServer(root: string, cfg: Config, opts: { installer: string, force?: boolean }): Promise<InstalledServer> {
  const dir = resolveServerDir(root, cfg)
  await ensureDir(dir)

  const marker = join(dir, ".install.json")
  if (!opts.force && (await exists(marker))) {
    const prev = JSON.parse(await readFile(marker, "utf8")) as InstalledServer
    if (prev.mcVersion === cfg.minecraft.version && (prev.loaderVersion ?? null) === (cfg.minecraft.loader ?? null) && (await exists(prev.launcher))) {
      log.info(`服务端已安装：MC ${prev.mcVersion} / ${prev.loaderVersion ?? "latest loader"}`)
      return prev
    }
  }

  const args = ["-jar", opts.installer, "server", "-dir", dir, "-mcversion", cfg.minecraft.version, "-downloadMinecraft"]
  if (cfg.minecraft.loader) args.push("-loader", cfg.minecraft.loader)

  log.info(`安装 Fabric 服务端 MC ${cfg.minecraft.version} …（首次需下载原版服务端，耗时较长）`)
  const r = await run("java", args, { cwd: root, echo: true })
  if (r.code !== 0) throw new Error(`fabric-installer 失败 (code ${r.code})\n${r.stdout}\n${r.stderr}`)

  const launcher = await findLauncher(dir)
  if (!launcher) throw new Error(`安装完成但 ${dir} 下没有 fabric-server*.jar`)
  const info: InstalledServer = {
    dir,
    launcher,
    mcVersion: cfg.minecraft.version,
    loaderVersion: cfg.minecraft.loader,
  }
  await import("node:fs/promises").then(fs => fs.writeFile(marker, JSON.stringify(info, null, 2)))
  await verifyServerJar(dir)
  return info
}

/** 原版 server.jar 与 launcher 是否就位（installer 偶尔下载中断） */
async function verifyServerJar(dir: string) {
  const jar = join(dir, "server.jar")
  if (!(await exists(jar))) {
    log.warn("未找到 server.jar，若启动失败请重新安装")
    return
  }
  const buf = await readFile(jar)
  log.debug(`server.jar ${(buf.length / 1048576).toFixed(1)}MB sha1=${sha1(buf).slice(0, 12)}`)
}
