import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { listZipEntries, readJarJson, readJarJsonEntry, readZipEntry } from "./jar.js"
import { log } from "./util.js"

/** 结构集合（data/<ns>/worldgen/structure_set/*.json） */
export interface StructureSet {
  /** 集合 id，如 minecraft:villages */
  id: string
  /** 集合里的结构 id（同一集合的变体共用一个 placement） */
  structures: string[]
  /** placement.spacing，单位区块 */
  spacing: number | null
  /** placement.separation，单位区块 */
  separation: number | null
  salt: number | null
}

export interface StructureSetIndex {
  sets: StructureSet[]
  /** 结构 id → 所属集合 */
  byStructure: Map<string, StructureSet>
}

/** Subdirectory of the server directory holding datagen reports */
export const DATAGEN_DIRNAME = ".wgs-datagen"

const EMPTY: StructureSetIndex = { sets: [], byStructure: new Map() }
const cache = new Map<string, Promise<StructureSetIndex>>()
const SET_PATH = /^data\/([^/]+)\/worldgen\/structure_set\/(.+)\.json$/
/** Datagen report layout: `<ns>/worldgen/structure_set/<name>.json` */
const REPORT_SET_PATH = /^([^/]+)\/worldgen\/structure_set\/(.+)\.json$/

type Format = [number, number]

function parseSet(id: string, json: unknown): StructureSet {
  const doc = json as {
    structures?: { structure?: unknown, weight?: unknown }[]
    placement?: { spacing?: unknown, separation?: unknown, salt?: unknown }
  }
  const nums = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
  return {
    id,
    structures: (doc.structures ?? []).map(s => String(s.structure)).filter(Boolean),
    spacing: nums(doc.placement?.spacing),
    separation: nums(doc.placement?.separation),
    salt: nums(doc.placement?.salt),
  }
}

async function walkJson(root: string): Promise<string[]> {
  const out: string[] = []
  const visit = async (dir: string) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) await visit(abs)
      else if (e.name.endsWith(".json")) out.push(abs)
    }
  }
  await visit(root)
  return out.sort()
}

/** Data pack format from the jar `version.json`. */
async function dataFormat(jarPath: string): Promise<Format | null> {
  const version = await readJarJsonEntry("version.json", jarPath) as { pack_version?: unknown } | null
  const pv = version?.pack_version
  if (typeof pv === "number") return [pv, 0]
  if (pv && typeof pv === "object") {
    const o = pv as Record<string, unknown>
    if (typeof o.data_major === "number") return [o.data_major, typeof o.data_minor === "number" ? o.data_minor : 0]
    if (typeof o.data === "number") return [o.data, 0]
  }
  return null
}

function asFormat(v: unknown): Format | null {
  if (typeof v === "number") return [v, 0]
  if (Array.isArray(v) && typeof v[0] === "number") return [v[0], typeof v[1] === "number" ? v[1] : 0]
  return null
}

const cmp = (a: Format, b: Format) => a[0] - b[0] || a[1] - b[1]

/** Overlay directories active for this format, in declaration order. */
function activeOverlays(meta: unknown, format: Format | null): string[] {
  const entries = (meta as { overlays?: { entries?: unknown[] } } | null)?.overlays?.entries
  if (!format || !Array.isArray(entries)) return []
  const out: string[] = []
  for (const raw of entries) {
    const e = raw as Record<string, unknown>
    if (typeof e.directory !== "string") continue
    let low = asFormat(e.min_format)
    let high = asFormat(e.max_format)
    const formats = e.formats
    if (!low && !high && formats !== undefined) {
      if (typeof formats === "number") low = high = [formats, 0]
      else if (Array.isArray(formats)) { low = asFormat(formats[0]); high = asFormat(formats[1]) }
      else if (formats && typeof formats === "object") {
        const f = formats as Record<string, unknown>
        low = asFormat(f.min_inclusive); high = asFormat(f.max_inclusive)
      }
    }
    if (low && cmp(format, low) < 0) continue
    if (high && cmp(format, high) > 0) continue
    out.push(e.directory)
  }
  return out
}

/** Structure sets in one datapack (zip or directory); the pack root overrides overlays. */
async function datapackSets(path: string, format: Format | null): Promise<Map<string, StructureSet>> {
  const found = new Map<string, StructureSet>()
  const take = (rel: string, json: () => unknown) => {
    const m = rel.match(SET_PATH)
    if (m) found.set(`${m[1]}:${m[2]}`, parseSet(`${m[1]}:${m[2]}`, json()))
  }
  if (path.endsWith(".zip")) {
    const bytes = new Uint8Array(await readFile(path))
    const entries = listZipEntries(bytes)
    const dec = new TextDecoder()
    const read = (name: string) => JSON.parse(dec.decode(readZipEntry(bytes, entries.find(e => e.name === name)!)))
    const meta = entries.some(e => e.name === "pack.mcmeta") ? read("pack.mcmeta") : null
    for (const prefix of [...activeOverlays(meta, format).reverse().map(d => `${d}/`), ""]) {
      for (const e of entries) {
        if (!e.name.startsWith(prefix) || !e.name.endsWith(".json")) continue
        take(e.name.slice(prefix.length), () => read(e.name))
      }
    }
    return found
  }
  let meta: unknown = null
  try { meta = JSON.parse(await readFile(join(path, "pack.mcmeta"), "utf8")) } catch { /* no pack.mcmeta: root only */ }
  for (const root of [...activeOverlays(meta, format).reverse().map(d => join(path, d)), path]) {
    for (const file of await walkJson(join(root, "data"))) {
      const rel = relative(root, file).split("\\").join("/")
      const text = await readFile(file, "utf8")
      take(rel, () => JSON.parse(text))
    }
  }
  return found
}

/**
 * Structure set table mapping structure ids to sets. Layers, later ones override:
 * the vanilla jar, datagen reports when the jar has none, then world datapacks
 * (sorted by file name). Returns an empty table when nothing is readable.
 */
export function loadStructureSets(jarPath: string | null | undefined, worldDir?: string | null): Promise<StructureSetIndex> {
  if (!jarPath) return Promise.resolve(EMPTY)
  const key = `${jarPath}|${worldDir ?? ""}`
  const hit = cache.get(key)
  if (hit) return hit
  const task = (async () => {
    try {
      const byId = new Map<string, StructureSet>()
      const origin: string[] = []
      for (const f of await readJarJson("data/", jarPath)) {
        const m = f.path.match(SET_PATH)
        if (m) byId.set(`${m[1]}:${m[2]}`, parseSet(`${m[1]}:${m[2]}`, f.json))
      }
      if (byId.size) origin.push(`jar ${byId.size}`)
      if (!byId.size && worldDir) {
        const reports = join(dirname(worldDir), DATAGEN_DIRNAME, "reports", "worldgen")
        for (const file of await walkJson(reports)) {
          const m = relative(reports, file).split("\\").join("/").match(REPORT_SET_PATH)
          if (m) byId.set(`${m[1]}:${m[2]}`, parseSet(`${m[1]}:${m[2]}`, JSON.parse(await readFile(file, "utf8"))))
        }
        if (byId.size) origin.push(`datagen reports ${byId.size}`)
      }
      if (worldDir) {
        const packsDir = join(worldDir, "datapacks")
        let names: string[] = []
        try { names = (await readdir(packsDir)).sort() } catch { /* no datapacks */ }
        const format = names.length ? await dataFormat(jarPath) : null
        for (const name of names) {
          const sets = await datapackSets(join(packsDir, name), format)
          for (const [id, set] of sets) byId.set(id, set)
          if (sets.size) origin.push(`${name} ${sets.size}`)
        }
      }
      const sets = [...byId.values()]
      const byStructure = new Map<string, StructureSet>()
      // 同一结构理论上只属于一个集合；真撞车时保留先读到的，不重复计
      for (const set of sets) for (const s of set.structures) if (!byStructure.has(s)) byStructure.set(s, set)
      log.debug(`structure sets: ${sets.length}, covering ${byStructure.size} structures (${origin.join("; ") || "no source"})`)
      return { sets, byStructure }
    } catch (e) {
      log.warn(`读取结构集合失败（${jarPath}）：${(e as Error).message}`)
      return EMPTY
    }
  })()
  cache.set(key, task)
  return task
}
