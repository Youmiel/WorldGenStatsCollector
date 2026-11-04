import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Config } from "./config.js"
import { download, ensureDir, getJson, log } from "./util.js"

interface ModrinthFile {
  url: string
  filename: string
  primary: boolean
  hashes: { sha1: string }
}

interface ModrinthVersion {
  id: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  date_published: string
  files: ModrinthFile[]
}

export interface ResolvedMod {
  slug: string
  version: string
  filename: string
  path: string
}

const MODS: { slug: string, key: keyof Config["mods"] }[] = [
  { slug: "chunky", key: "chunky" },
  { slug: "c2me-fabric", key: "c2me" },
  // Chunky 1.5.6x 硬依赖 fabric-api，缺了会以 HARD_DEP_NO_CANDIDATE 退出
  { slug: "fabric-api", key: "fabricApi" },
]

/** 按 MC 版本 + fabric 过滤，取最新发布的那个版本 */
export async function resolveMod(slug: string, mcVersion: string): Promise<ModrinthVersion> {
  const q = new URL(`https://api.modrinth.com/v2/project/${slug}/version`)
  q.searchParams.set("game_versions", JSON.stringify([mcVersion]))
  q.searchParams.set("loaders", JSON.stringify(["fabric"]))
  const versions = await getJson<ModrinthVersion[]>(q.toString(), {}, 3)
  if (!versions.length) throw new Error(`Modrinth 上 ${slug} 没有 MC ${mcVersion} 的 fabric 版本`)
  return versions.sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published))[0]
}

export async function installMods(cfg: Config, serverDir: string): Promise<ResolvedMod[]> {
  const modsDir = join(serverDir, "mods")
  await ensureDir(modsDir)
  const out: ResolvedMod[] = []
  for (const m of MODS) {
    if (!cfg.mods[m.key]) {
      log.info(`跳过模组 ${m.slug}（配置关闭）`)
      continue
    }
    const v = await resolveMod(m.slug, cfg.minecraft.version)
    const file = v.files.find(f => f.primary) ?? v.files[0]
    const dest = join(modsDir, file.filename)
    log.info(`模组 ${m.slug} ${v.version_number}`)
    await download(file.url, dest, { sha1: file.hashes.sha1, label: file.filename })
    out.push({ slug: m.slug, version: v.version_number, filename: file.filename, path: dest })
  }
  await pruneStaleMods(modsDir, out.map(o => o.filename))
  return out
}

/** 清掉 mods/ 里不认识的 jar（换版本后常见），避免混装导致崩溃 */
async function pruneStaleMods(modsDir: string, keep: string[]) {
  const keepSet = new Set(keep)
  for (const f of await readdir(modsDir)) {
    if (!f.endsWith(".jar") || keepSet.has(f)) continue
    if (/^(fabric-api|chunky|c2me)/i.test(f)) {
      log.info(`移除旧模组 ${f}`)
      await rm(join(modsDir, f), { force: true })
    }
  }
}
