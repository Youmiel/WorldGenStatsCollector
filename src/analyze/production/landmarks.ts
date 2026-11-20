/**
 * 地形特征（placed feature）类地标识别。
 *
 * 本文件与两个结构分析器（`structure-interior` / `structure-spacing`）放在同一目录，
 * 由它们共用；它自己**不是分析器**，靠下面那行声明让加载器跳过。
 *
 * 这类「结构」不写 `structures.starts`、没有片段 BB，只能靠方块实体上的
 * 考古战利品表反查。当前只有沙漠水井属于这一类：它的
 * `worldgen/placed_feature/desert_well.json` 用 `rarity_filter` 放置，
 * 可疑沙由模板 processor 附上 `archaeology/desert_well`。
 *
 * 其余 `archaeology/*` 表都对应真正的 jigsaw 结构（金字塔、海洋废墟、遗迹小径），
 * 那些表由 `structure-interior` 的 `LOOT_OWNERS` 归属，不能当独立地标。
 */

/**
 * 「我不是分析器」的约定声明。
 *
 * 分析器目录下也可以放共享库；加载器见到这个字段就静默跳过，
 * 不再因为它缺少 `name` / `create()` 而打警告。
 * 与 `AnalyzerModule.parallelCost` / `.parallelGroup` 同一思路：
 * 插件用声明告诉框架自己是什么，框架只做通用检测，不按文件名猜。
 */
export const notAnAnalyzer = true

/** 有对应 jigsaw 结构的考古表 owner；出现它们说明是结构方块，不是地标 */
export const ARCHAEOLOGY_STRUCTURE_OWNERS: ReadonlySet<string> = new Set([
  "desert_pyramid",
  "ocean_ruin_cold",
  "ocean_ruin_warm",
  "trail_ruins",
])

/**
 * 考古战利品表 → 归属对象短名。
 *
 * 只处理 `archaeology/*`：这类表由方块实体 processor 用 `append_loot` 直接写在可疑方块上，
 * 一个方块对应哪张表是确定的，比「按距离找最近的结构」可靠。
 *
 * `_common` / `_rare` 是同一结构的多张表（遗迹小径），去掉后归到同一结构。
 */
export function archaeologyOwner(loot: string): string | null {
  const m = loot.match(/^minecraft:archaeology\/(.+)$/)
  if (!m) return null
  return m[1].replace(/_(common|rare|uncommon)$/, "")
}

/**
 * 这张考古表是否属于「无 start 的地形特征」；是则返回 owner 短名。
 *
 * 只认白名单以外的表：已知结构的考古表返回 null，交给结构归属逻辑，
 * 免得把「结构实例没落在扫描范围内」误报成独立地标。
 */
export function landmarkOwnerOf(loot: string): string | null {
  const owner = archaeologyOwner(loot)
  if (!owner) return null
  return ARCHAEOLOGY_STRUCTURE_OWNERS.has(owner) ? null : owner
}

/**
 * 地标 owner → 结构集合 ID。
 *
 * 下游 `structure_sets.toml` 的 `template_prefixes` 用 `desert_well/` →
 * `minecraft:desert_wells`，这里必须给集合名而不是变体名，`structure_density`
 * 才能按集合聚合。未登记的地标退回 `minecraft:<owner>`。
 */
const LANDMARK_SETS: Record<string, string> = {
  desert_well: "minecraft:desert_wells",
}

export function landmarkSetId(owner: string): string {
  return LANDMARK_SETS[owner] ?? `minecraft:${owner}`
}

/** 地标实例聚类半径（方块）：同一实例的可疑方块相距不超过几格，不同实例至少隔一个区块 */
export const LANDMARK_CLUSTER_RADIUS = 8
