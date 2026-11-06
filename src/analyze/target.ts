import { createHash } from "node:crypto"
import { createReadStream, type Dirent } from "node:fs"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readNBT } from "minecraft-block-reader"
import type { Config } from "../lib/config.js"
import { exists, log } from "../lib/util.js"

/**
 * 产物头部标识（schemaVersion 2 的 `target`）：证明这批统计来自哪个版本、哪个种子、
 * 哪份地形数据包。下游按 `dataPacks[].sha256` 认包版本，包内容一改哈希就变，
 * 所以哈希的是目录树内容，不是目录名。
 */

export interface DataPackInfo {
  id: string
  source: "world" | "server"
  enabled: boolean
  sha256: string | null
}

export interface TargetInfo {
  minecraftVersion: string
  levelName: string
  loader: string
  /** 实际生成的种子（十进制字符串）；读不到为 null */
  seed: string | null
  /** explicit = 配置/命令行指定；random = 服务端随机生成 */
  seedMode: "explicit" | "random" | "unknown"
  dataPacks: DataPackInfo[]
  serverJarSha256: string | null
}

async function sha256File(path: string): Promise<string | null> {
  try {
    const h = createHash("sha256")
    for await (const chunk of createReadStream(path)) h.update(chunk as Uint8Array)
    return h.digest("hex")
  } catch {
    return null
  }
}

/**
 * 目录树哈希：按名字排序后逐条喂「类型 + 相对路径 + 内容」，
 * 这样重命名文件和改内容都会变，且与文件系统遍历顺序无关。
 */
export async function hashPath(path: string): Promise<string | null> {
  try {
    const st = await stat(path)
    if (st.isFile()) return await sha256File(path)
    if (!st.isDirectory()) return null
    const h = createHash("sha256")
    const walk = async (dir: string, rel: string) => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
      for (const e of entries) {
        const abs = join(dir, e.name)
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          h.update(`dir\0${r}\0`)
          await walk(abs, r)
        } else if (e.isFile()) {
          h.update(`file\0${r}\0`)
          h.update(await readFile(abs))
        }
      }
    }
    await walk(path, "")
    return h.digest("hex")
  } catch {
    return null
  }
}

/** 目录下每个 .zip 或目录算作一个数据包；`.disabled` 后缀表示未启用 */
async function scanPacks(dir: string, source: DataPackInfo["source"]): Promise<DataPackInfo[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: DataPackInfo[] = []
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const disabled = /\.disabled$/i.test(e.name)
    if (e.isDirectory()) {
      out.push({ id: e.name, source, enabled: !disabled, sha256: await hashPath(join(dir, e.name)) })
      continue
    }
    if (!e.isFile() || !/\.zip(\.disabled)?$/i.test(e.name)) continue
    out.push({
      id: e.name.replace(/\.disabled$/i, ""),
      source,
      enabled: !disabled,
      sha256: await hashPath(join(dir, e.name)),
    })
  }
  return out
}

/**
 * 存档里的实际种子。
 *
 * 26.x 起世界生成设置独立存在 world/data/minecraft/world_gen_settings.dat（根键 data.seed）；
 * 更早的版本在 level.dat 的 Data.WorldGenSettings.seed 或 Data.RandomSeed。
 * 配置里的 seed 只代表「要求用什么」，世界一旦生成，只有存档是事实。
 */
export async function readLevelSeed(worldDir: string): Promise<string | null> {
  const sources: { path: string, pick: (root: Record<string, unknown>) => unknown }[] = [
    {
      path: join(worldDir, "data", "minecraft", "world_gen_settings.dat"),
      pick: root => (root.data as Record<string, unknown> | undefined)?.seed,
    },
    {
      path: join(worldDir, "level.dat"),
      pick: root => {
        const data = root.Data as Record<string, unknown> | undefined
        const wgs = data?.WorldGenSettings as Record<string, unknown> | undefined
        return wgs?.seed ?? data?.RandomSeed
      },
    },
  ]

  for (const src of sources) {
    if (!(await exists(src.path))) continue
    try {
      const root = await readNBT(await readFile(src.path)) as Record<string, unknown>
      const raw = src.pick(root ?? {})
      if (typeof raw === "bigint") return raw.toString()
      if (typeof raw === "number") return String(raw)
      if (typeof raw === "string") return raw
    } catch (e) {
      log.warn(`${src.path} 解析失败，继续尝试下一种来源：${(e as Error).message}`)
    }
  }
  return null
}

interface JarCacheEntry {
  path: string
  size: number
  mtimeMs: number
  sha256: string
}

/**
 * 原版服务端 jar 的哈希。jar 有几百 MB，按 size + mtime 缓存到服务端目录，
 * 文件没换过就不重复读。
 */
async function jarSha256(jarPath: string, cacheDir: string): Promise<string | null> {
  let st
  try {
    st = await stat(jarPath)
  } catch {
    return null
  }
  const cachePath = join(cacheDir, ".target-cache.json")
  let cache: JarCacheEntry[] = []
  try {
    const raw = JSON.parse(await readFile(cachePath, "utf8")) as unknown
    if (Array.isArray(raw)) cache = raw as JarCacheEntry[]
  } catch { /* 没有缓存就重算 */ }

  const hit = cache.find(c => c.path === jarPath && c.size === st.size && c.mtimeMs === st.mtimeMs)
  if (hit) return hit.sha256

  const sha = await sha256File(jarPath)
  if (!sha) return null
  const next = cache.filter(c => c.path !== jarPath)
  next.push({ path: jarPath, size: st.size, mtimeMs: st.mtimeMs, sha256: sha })
  try {
    await writeFile(cachePath, JSON.stringify(next, null, 2), "utf8")
  } catch { /* 缓存写不进去不影响结果 */ }
  return sha
}

export interface TargetOptions {
  cfg: Config
  serverDir: string
  worldDir: string
  serverJar: string | null
}

export async function buildTarget(opts: TargetOptions): Promise<TargetInfo> {
  const { cfg, serverDir, worldDir, serverJar } = opts
  const [levelSeed, worldPacks, serverPacks, jarSha] = await Promise.all([
    readLevelSeed(worldDir),
    scanPacks(join(worldDir, "datapacks"), "world"),
    scanPacks(join(serverDir, "datapacks"), "server"),
    serverJar ? jarSha256(serverJar, serverDir) : Promise.resolve(null),
  ])

  const configured = cfg.server.seed?.trim() ?? ""
  const source = cfg.server.seedSource
  // 存档是事实：世界已经生成过，种子就是存档里那个；配置里的值只在没和存档冲突时才算 explicit
  const seedMode: TargetInfo["seedMode"] =
    levelSeed
      ? configured === levelSeed ? "explicit" : "random"
      : configured
        ? source === "random" ? "random" : "explicit"
        : "unknown"

  return {
    minecraftVersion: cfg.minecraft.version,
    levelName: cfg.server.levelName,
    loader: "fabric",
    seed: levelSeed ?? (configured || null),
    seedMode,
    dataPacks: [...worldPacks, ...serverPacks],
    serverJarSha256: jarSha,
  }
}
