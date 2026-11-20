import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"

/**
 * 实体统计：按实体 id 统计数量与每区块平均密度，并把生物分成
 * 陆生动物 / 水生生物 / 敌对生物 / NPC-傀儡 / 其他。
 *
 * 数据来自区块句柄的 entities()：1.17+ 实体存在独立的 entities/r.x.z.mca 里，
 * reader 的 chunkBlocks().entities 在单 region 文件模式下读不到，这里走的是自己的通道。
 *
 * 口径：
 * - 每区块平均的分母是「扫描到的区块数」，含没有实体的区块 —— 这是世界平均密度。
 *   只在有实体的区块里平均会高估，所以另给 chunksWithEntities 和 perLoadedChunk。
 * - 分类是原版生物类别（Animal / WaterAnimal / Monster 等）的硬编码表，模组实体会落到 other。
 * - 掉落物、经验球、矿车、船也算实体，默认计入 other；只想看生物可设 onlyLiving（默认 true）。
 *
 * params:
 *   onlyLiving?: boolean  只统计生物（剔除 item / experience_orb / 矿车 / 船 / 投射物等），默认 true
 *   filter?: string[]     只统计这些实体 id（可写 sheep 或 minecraft:sheep）
 *   top?: number          控制台每种列表展示条数（默认 12）
 */

const KEY = "entity-census"

/** 陆生动物（Animal 及其子类） */
const LAND = new Set([
  "armadillo", "axolotl", "bee", "camel", "cat", "chicken", "cow", "donkey", "fox", "frog",
  "goat", "horse", "llama", "mooshroom", "mule", "ocelot", "panda", "parrot", "pig",
  "polar_bear", "rabbit", "sheep", "sniffer", "strider", "trader_llama", "turtle", "wolf",
  "skeleton_horse", "zombie_horse", "happy_ghast",
])

/** 水生生物（WaterAnimal） */
const WATER = new Set([
  "dolphin", "squid", "glow_squid", "cod", "salmon", "tropical_fish", "pufferfish", "tadpole",
])

/** 敌对生物（Monster） */
const MONSTER = new Set([
  "zombie", "husk", "drowned", "skeleton", "stray", "bogged", "wither_skeleton", "creeper",
  "spider", "cave_spider", "silverfish", "endermite", "enderman", "witch", "slime", "magma_cube",
  "blaze", "ghast", "guardian", "elder_guardian", "shulker", "phantom", "pillager", "vindicator",
  "evoker", "illusioner", "ravager", "vex", "zoglin", "hoglin", "piglin_brute", "zombified_piglin",
  "breeze", "warden", "wither", "ender_dragon", "creaking",
])

/** 中立 / NPC 类生物（不算 Animal，但也不是 hostile） */
const NEUTRAL = new Set([
  "villager", "wandering_trader", "iron_golem", "snow_golem", "piglin",
])

/** 非生物实体：掉落物、经验球、载具、投射物、方块实体等 */
const NON_LIVING = new Set([
  "item", "experience_orb", "arrow", "spectral_arrow", "trident", "snowball", "egg", "ender_pearl",
  "eye_of_ender", "potion", "firework_rocket", "boat", "chest_boat", "minecart", "chest_minecart",
  "hopper_minecart", "tnt_minecart", "command_block_minecart", "spawner_minecart", "furnace_minecart",
  "lead_knot", "leash_knot", "area_effect_cloud", "lightning_bolt", "marker", "interaction", "item_frame",
  "glow_item_frame", "painting", "fishing_bobber", "llama_spit", "shulker_bullet",
  "small_fireball", "large_fireball", "dragon_fireball", "wither_skull", "thrown_exp_bottle",
  "falling_block", "tnt", "end_crystal", "armor_stand", "evoker_fangs", "ominous_item_spawner",
])

type Category = "land" | "water" | "monster" | "neutral" | "other"

const shortId = (id: string) => id.replace(/^minecraft:/, "")

function categoryOf(id: string): Category {
  const s = shortId(id)
  if (LAND.has(s)) return "land"
  if (WATER.has(s)) return "water"
  if (MONSTER.has(s)) return "monster"
  if (NEUTRAL.has(s)) return "neutral"
  return "other"
}

const isLiving = (id: string) => !NON_LIVING.has(shortId(id))

interface TypeStat { count: number, sumY: number, points: Point3[] }
interface Point3 { x: number, y: number, z: number }

/** 显示层取整：产物一律保留原始浮点，按契约不在采集侧四舍五入 */
const avg = (n: number, d: number) => (d > 0 ? n / d : 0)

/** 每区块平均的倒数：平均多少区块出现一个。期望值为 0 时无法取倒数，返回 null */
const inverse = (n: number, denom: number) => (n > 0 ? denom / n : null)

/**
 * 同种实体的群聚类：水平距离 <= radius 且垂直距离 <= height 的实体连成一群，
 * 返回每群的实体数。用 radius 大小的网格桶，距离 <= radius 的点只可能落在 3x3 邻桶内，
 * 不必全量两两比较。
 *
 * 同一类型才聚类：原版 herd 生成出来的是同种生物，混种「群」没有对应概念。
 */
function clusterSizes(points: Point3[], radius: number, height: number): number[] {
  const n = points.length
  if (!n) return []
  const size = Math.max(1, radius)
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (a: number): number => {
    let root = a
    while (parent[root] !== root) root = parent[root]
    while (parent[a] !== root) {
      const next = parent[a]
      parent[a] = root
      a = next
    }
    return root
  }

  const buckets = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const k = `${Math.floor(points[i].x / size)},${Math.floor(points[i].z / size)}`
    const b = buckets.get(k)
    if (b) b.push(i)
    else buckets.set(k, [i])
  }

  const r2 = radius * radius
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const bx = Math.floor(a.x / size), bz = Math.floor(a.z / size)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = buckets.get(`${bx + dx},${bz + dz}`)
        if (!list) continue
        for (const j of list) {
          if (j <= i) continue
          const b = points[j]
          if (Math.abs(a.y - b.y) > height) continue
          const ddx = a.x - b.x, ddz = a.z - b.z
          if (ddx * ddx + ddz * ddz > r2) continue
          const ri = find(i), rj = find(j)
          if (ri !== rj) parent[rj] = ri
        }
      }
    }
  }

  const sizes = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    sizes.set(root, (sizes.get(root) ?? 0) + 1)
  }
  return [...sizes.values()]
}

const analyzer: AnalyzerModule = {
  name: KEY,
  description: "实体/动物数量与每区块平均密度（分陆生、水生、敌对、NPC）",
  // 测的是世界生成时放置的实体（被动生物群），只有主世界有；
  // 怪物是刷怪产物，与这里的口径无关，不要靠本分析器统计。
  dimensions: ["overworld"],
  units: { density: "per_chunk", count: "entity" },
  parallelCost: 0.5,
  create(params): Analyzer {
    const p = (params[KEY] ?? {}) as Record<string, unknown>
    const onlyLiving = p.onlyLiving !== false
    const top = Number.isFinite(Number(p.top)) ? Math.max(1, Math.trunc(Number(p.top))) : 12
    /** 群聚类开关与阈值：水平 radius 方块内、垂直 height 方块内的同种实体算同一群 */
    const wantGroups = p.groups !== false
    const clusterRadius = Number.isFinite(Number(p.clusterRadius)) ? Math.max(0, Number(p.clusterRadius)) : 12
    const clusterHeight = Number.isFinite(Number(p.clusterHeight)) ? Math.max(0, Number(p.clusterHeight)) : 8
    const filter = Array.isArray(p.filter)
      ? new Set((p.filter as unknown[]).map(s => {
          const id = String(s)
          return id.includes(":") ? id : `minecraft:${id}`
        }))
      : null

    const byType = new Map<string, TypeStat>()
    let chunks = 0
    let chunksWithEntities = 0
    let entities = 0
    let skipped = 0

    return {
      name: KEY,
      async onChunk(c: ChunkHandle) {
        chunks++
        const list = await c.entities()
        if (!list.length) return
        chunksWithEntities++
        for (const e of list) {
          const id = String(e.nbt?.id ?? "unknown")
          if (filter && !filter.has(id)) continue
          if (onlyLiving && !isLiving(id)) { skipped++; continue }
          entities++
          const y = Number.isFinite(e.pos[1]) ? e.pos[1] : 0
          const t = byType.get(id) ?? { count: 0, sumY: 0, points: [] }
          t.count++
          t.sumY += y
          if (wantGroups) t.points.push({ x: e.pos[0], y, z: e.pos[2] })
          byType.set(id, t)
        }
      },
      finalize() {
        const cats: Record<Category, number> = { land: 0, water: 0, monster: 0, neutral: 0, other: 0 }

        // 按类型分别聚类：原版 herd 出来的是同种生物，不同种不合并成一群
        const groupSizes = new Map<string, number[]>()
        if (wantGroups) {
          for (const [id, t] of byType) groupSizes.set(id, clusterSizes(t.points, clusterRadius, clusterHeight))
        }

        const groupStat = (id: string, count: number) => {
          if (!wantGroups) return null
          const sizes = groupSizes.get(id) ?? []
          const groups = sizes.length
          return {
            groups,
            perChunk: avg(groups, chunks),
            chunksPer: inverse(groups, chunks),
            avgSize: groups ? count / groups : 0,
            singletons: sizes.filter(s => s === 1).length,
            maxSize: sizes.length ? Math.max(...sizes) : 0,
          }
        }

        // 展示顺序：数量降序
        const sorted = [...byType.entries()].sort((a, b) => b[1].count - a[1].count)
        const typeRows = sorted.map(([id, t]) => ({
          id,
          category: categoryOf(id),
          count: t.count,
          perChunk: avg(t.count, chunks),
          /** 平均每多少个区块出现一只 */
          chunksPer: inverse(t.count, chunks),
          avgY: t.sumY / t.count,
          group: groupStat(id, t.count),
        }))
        for (const r of typeRows) cats[r.category] += r.count

        const catGroup = (k: Category) => {
          if (!wantGroups) return null
          const rows = typeRows.filter(r => r.category === k)
          const groups = rows.reduce((a, r) => a + (r.group?.groups ?? 0), 0)
          const count = cats[k]
          return {
            groups,
            perChunk: avg(groups, chunks),
            chunksPer: inverse(groups, chunks),
            avgSize: groups ? count / groups : 0,
          }
        }

        const byCategory = Object.fromEntries((Object.entries(cats) as [Category, number][]).map(([k, v]) => [k, {
          count: v,
          perChunk: avg(v, chunks),
          chunksPer: inverse(v, chunks),
          types: typeRows.filter(r => r.category === k).length,
          group: catGroup(k),
        }]))

        // 「动物」= 陆生 + 水生，用户最关心的口径
        const animalTypes = typeRows.filter(r => r.category === "land" || r.category === "water")
        const animalCount = cats.land + cats.water
        const landCount = cats.land
        const waterCount = cats.water
        const animalGroups = animalTypes.reduce((a, r) => a + (r.group?.groups ?? 0), 0)
        const allGroups = wantGroups
          ? typeRows.reduce((a, r) => a + (r.group?.groups ?? 0), 0)
          : null

        return {
          chunks,
          entities,
          chunksWithEntities,
          /** 每区块平均实体数（分母含空区块） */
          perChunk: avg(entities, chunks),
          /** perChunk 的倒数：平均每多少个区块一个实体 */
          chunksPer: inverse(entities, chunks),
          /** 只在有实体的区块里平均 */
          perLoadedChunk: avg(entities, chunksWithEntities),
          skippedNonLiving: skipped,
          top,
          clustering: wantGroups
            ? { radius: clusterRadius, height: clusterHeight, unit: "同种实体水平距离 <= radius 且垂直距离 <= height 连成一群" }
            : null,
          animals: {
            /** 陆生 + 水生 */
            count: animalCount,
            perChunk: avg(animalCount, chunks),
            chunksPer: inverse(animalCount, chunks),
            land: { count: landCount, perChunk: avg(landCount, chunks), chunksPer: inverse(landCount, chunks), group: catGroup("land") },
            water: { count: waterCount, perChunk: avg(waterCount, chunks), chunksPer: inverse(waterCount, chunks), group: catGroup("water") },
            uniqueTypes: animalTypes.length,
            /** 动物全部群数（各类型群数之和，同种才算一群） */
            groups: wantGroups ? animalGroups : null,
            groupsPerChunk: wantGroups ? avg(animalGroups, chunks) : null,
            /** 平均多少区块出现一群动物 */
            chunksPerGroup: wantGroups ? inverse(animalGroups, chunks) : null,
            avgGroupSize: wantGroups && animalGroups ? animalCount / animalGroups : null,
            byType: Object.fromEntries(animalTypes.map(r => [r.id, {
              count: r.count, perChunk: r.perChunk, chunksPer: r.chunksPer, avgY: r.avgY, group: r.group,
            }])),
          },
          byCategory,
          byType: Object.fromEntries(typeRows.map(r => [r.id, {
            category: r.category, count: r.count, perChunk: r.perChunk, chunksPer: r.chunksPer, avgY: r.avgY, group: r.group,
          }])),
          totalGroups: allGroups,
          note: "每区块平均的分母为扫描区块数（对应 config 的统计范围/维度）；chunksPer 为平均值倒数（多少区块一只/一群）；群按同种实体聚类（默认水平 12 / 垂直 8 方块）；实体来自 entities/r.x.z.mca，非生物实体按 onlyLiving 过滤",
        }
      },
    }
  },
  format(result) {
    /** 显示用：两位小数，去掉无意义的尾随零 */
    const dsp = (v: number) => Number(v.toFixed(2))
    type GroupStat = { groups: number, perChunk: number, chunksPer: number | null, avgSize: number, singletons: number, maxSize: number }
    type TypeRow = { count: number, perChunk: number, chunksPer: number | null, avgY: number, group: GroupStat | null }
    const r = result as {
      chunks: number
      entities: number
      chunksWithEntities: number
      perChunk: number
      chunksPer: number | null
      skippedNonLiving: number
      top: number
      clustering: { radius: number, height: number } | null
      animals: {
        count: number
        perChunk: number
        chunksPer: number | null
        land: { count: number, perChunk: number, chunksPer: number | null, group: GroupStat | null }
        water: { count: number, perChunk: number, chunksPer: number | null, group: GroupStat | null }
        uniqueTypes: number
        groups: number | null
        groupsPerChunk: number | null
        chunksPerGroup: number | null
        avgGroupSize: number | null
        byType: Record<string, TypeRow>
      }
      byCategory: Record<string, { count: number, perChunk: number, chunksPer: number | null, types: number, group: GroupStat | null }>
      byType: Record<string, TypeRow & { category: string }>
    }
    const num = (v: number | null | undefined) => (v === null || v === undefined ? "-" : String(dsp(v)))
    const lines = [
      `区块 ${r.chunks}，实体 ${r.entities}（每区块 ${dsp(r.perChunk)}，即每 ${num(r.chunksPer)} 区块 1 个；${r.chunksWithEntities} 个区块有实体）`,
    ]
    if (r.skippedNonLiving) lines.push(`  已剔除非生物实体 ${r.skippedNonLiving}（掉落物/经验球/载具/方块实体等）`)
    const a = r.animals
    lines.push(
      `动物 ${a.count}（每区块 ${dsp(a.perChunk)}，即每 ${num(a.chunksPer)} 区块 1 只）：陆生 ${a.land.count}（每区块 ${dsp(a.land.perChunk)}，每 ${num(a.land.chunksPer)} 区块 1 只）  水生 ${a.water.count}（每区块 ${dsp(a.water.perChunk)}，每 ${num(a.water.chunksPer)} 区块 1 只）  种类 ${a.uniqueTypes}`,
    )
    if (a.groups !== null) {
      const cl = r.clustering
      const scope = cl ? `同种 ${cl.radius} 方块内、垂直 ${cl.height} 内` : ""
      lines.push(
        `动物群 ${a.groups}（每区块 ${num(a.groupsPerChunk)}，即每 ${num(a.chunksPerGroup)} 区块 1 群，平均 ${num(a.avgGroupSize)} 只/群；${scope}）`,
      )
    }
    const animals = Object.entries(a.byType).sort((x, y) => y[1].count - x[1].count)
    for (const [id, v] of animals.slice(0, r.top)) {
      const g = v.group
      const gtext = g ? `${String(g.groups).padStart(4)} 群（${dsp(g.avgSize)}/群）` : "-"
      lines.push(
        `  ${id.replace("minecraft:", "").padEnd(18)} ${String(v.count).padStart(5)}  每区块 ${String(dsp(v.perChunk)).padStart(8)}  每 ${num(v.chunksPer).padStart(7)} 区块 1 只  ${gtext}  y=${dsp(v.avgY)}`,
      )
    }
    const others = Object.entries(r.byCategory)
      .filter(([k]) => k === "monster" || k === "neutral" || k === "other")
      .filter(([, v]) => v.count > 0)
    if (others.length) {
      lines.push(`其他：${others.map(([k, v]) => {
        const g = v.group ? `${v.group.groups} 群/${dsp(v.group.avgSize)}只` : "-"
        return `${k} ${v.count}（每区块 ${dsp(v.perChunk)}，每 ${num(v.chunksPer)} 区块 1 个；${g}）`
      }).join("  ")}`)
    }
    return lines
  },
}

export default analyzer
