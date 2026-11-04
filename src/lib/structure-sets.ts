import { readJarJson } from "./jar.js"
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

const EMPTY: StructureSetIndex = { sets: [], byStructure: new Map() }
const cache = new Map<string, Promise<StructureSetIndex>>()

const SET_PATH = /^data\/([^/]+)\/worldgen\/structure_set\/(.+)\.json$/

/**
 * 从原版服务端 jar 读结构集合表，用来把区块里的结构 id（village_plains、ocean_ruin_cold…）
 * 归并到集合（villages、ocean_ruins…）。读不到就返回空表，调用方自己退化成按 id 归组。
 */
export function loadStructureSets(jarPath: string | null | undefined): Promise<StructureSetIndex> {
  if (!jarPath) return Promise.resolve(EMPTY)
  const hit = cache.get(jarPath)
  if (hit) return hit
  const task = (async () => {
    try {
      const files = await readJarJson("data/", jarPath)
      const sets: StructureSet[] = []
      const byStructure = new Map<string, StructureSet>()
      for (const f of files) {
        const m = f.path.match(SET_PATH)
        if (!m) continue
        const json = f.json as {
          structures?: { structure?: unknown, weight?: unknown }[]
          placement?: { spacing?: unknown, separation?: unknown, salt?: unknown }
        }
        const nums = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
        const set: StructureSet = {
          id: `${m[1]}:${m[2]}`,
          structures: (json.structures ?? []).map(s => String(s.structure)).filter(Boolean),
          spacing: nums(json.placement?.spacing),
          separation: nums(json.placement?.separation),
          salt: nums(json.placement?.salt),
        }
        sets.push(set)
        // 同一结构理论上只属于一个集合；真撞车时保留先读到的，不重复计
        for (const s of set.structures) if (!byStructure.has(s)) byStructure.set(s, set)
      }
      log.debug(`结构集合：${sets.length} 个，覆盖 ${byStructure.size} 种结构（${jarPath}）`)
      return { sets, byStructure }
    } catch (e) {
      log.warn(`读取结构集合失败（${jarPath}）：${(e as Error).message}`)
      return EMPTY
    }
  })()
  cache.set(jarPath, task)
  return task
}
