import type { World, ChunkRef } from "minecraft-block-reader"
import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"

/**
 * 矿石暴露统计：空气暴露 / 水暴露分开计数，并按 16 格高的区段（Y section）分层。
 * 数量一律给平均值：整体数字是「每区块」，分层数字是「每区段每区块」（分母 = 包含该区段的区块数）。
 *
 * params:
 *   ores?: string[]      自定义矿石 id 列表（默认原版主世界 + 下界）
 *   yMin?, yMax?: number 只统计该高度范围
 *   sections?: boolean   是否输出分层（默认 true）
 *
 * 判定：矿石 6 个面邻居里任意一个是空气 → 空气暴露；任意一个是水 → 水暴露；
 * 两者都有 → 同时计入（air / water 各 +1，并单独记 both）。
 * 跨区块的邻居会去读相邻区块（同 region 内），读不到才记为 unknownEdge：
 * 只读本区块的话，贴边的矿石会大面积误判成「全埋」，unknownEdge 会虚高。
 */

const DEFAULT_ORES = [
  "minecraft:coal_ore", "minecraft:deepslate_coal_ore",
  "minecraft:iron_ore", "minecraft:deepslate_iron_ore",
  "minecraft:copper_ore", "minecraft:deepslate_copper_ore",
  "minecraft:gold_ore", "minecraft:deepslate_gold_ore",
  "minecraft:redstone_ore", "minecraft:deepslate_redstone_ore",
  "minecraft:lapis_ore", "minecraft:deepslate_lapis_ore",
  "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore",
  "minecraft:emerald_ore", "minecraft:deepslate_emerald_ore",
  "minecraft:nether_gold_ore", "minecraft:nether_quartz_ore",
  "minecraft:ancient_debris",
]

const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"])
const WATER = new Set(["minecraft:water", "minecraft:bubble_column"])
const DIRS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

/** deepslate_/nether_ 前缀归并到同一矿种，用于汇总 */
export function oreFamily(id: string): string {
  return id
    .replace(/^minecraft:/, "")
    .replace(/^deepslate_/, "")
    .replace(/^nether_gold_ore$/, "gold_ore")
    .replace(/^nether_quartz_ore$/, "quartz_ore")
    .replace(/^ancient_debris$/, "debris")
}

interface Counts { total: number, air: number, water: number, both: number, buried: number, unknownEdge: number }
const empty = (): Counts => ({ total: 0, air: 0, water: 0, both: 0, buried: 0, unknownEdge: 0 })

/** 区块内局部坐标压成一维 key，用 Map 查邻居比扫 grid 快得多 */
const packed = (x: number, y: number, z: number) => ((y + 512) * 16 + x) * 16 + z

interface ChunkSolids { ids: string[], solid: Map<number, number> }

/** 一组矿量的平均值（每区块或每区段每区块） */
interface AvgStat {
  avgTotal: number
  avgAirExposed: number
  avgWaterExposed: number
  avgBoth: number
  avgBuried: number
  avgUnknownEdge: number
  airPct: number
  waterPct: number
}

/** matrix 的形态：行 = 区段，列 = 矿种 family；数值是「每区块该区段」的平均 */
interface OreMatrix {
  families: string[]
  rows: { section: number, yRange: [number, number], chunks: number, avgTotal: number, cells: Record<string, AvgStat> }[]
}

const fmtAvg = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2))

/** 种类 × 区段 交叉表；mode=total 显示平均总数，mode=exposure 显示平均空气/水暴露；footer 是每区块总体 */
function oreMatrixLines(m: OreMatrix, mode: "total" | "exposure", footer: Record<string, AvgStat>): string[] {
  const short = (f: string) => f.replace(/_ore$/, "")
  const fams = m.families
  const cellText = (c: AvgStat | undefined) => {
    if (!c) return "-"
    if (mode === "total") return fmtAvg(c.avgTotal)
    return c.avgAirExposed || c.avgWaterExposed ? `${fmtAvg(c.avgAirExposed)}/${fmtAvg(c.avgWaterExposed)}` : "-"
  }
  const cells = m.rows.map(r => fams.map(f => cellText(r.cells[f])))
  const foot = fams.map(f => cellText(footer[f]))
  const labels = m.rows.map(r => `${r.yRange[0]}~${r.yRange[1]}`)
  const widths = fams.map((f, i) => Math.max(short(f).length, foot[i].length, ...cells.map(row => row[i].length)))
  const labelW = Math.max(9, ...labels.map(l => l.length), "每区块".length)
  const pad = (s: string, w: number, right = false) => right ? s.padStart(w) : s.padEnd(w)
  const lines = ["    " + pad("区段", labelW) + fams.map((f, i) => " " + pad(short(f), widths[i], true)).join("")]
  m.rows.forEach((r, ri) => {
    lines.push("    " + pad(labels[ri], labelW) + cells[ri].map((c, i) => " " + pad(c, widths[i], true)).join(""))
  })
  lines.push("    " + pad("每区块", labelW) + foot.map((c, i) => " " + pad(c, widths[i], true)).join(""))
  return lines
}

const analyzer: AnalyzerModule = {
  name: "ore-exposure",
  description: "矿石的空气/水暴露数量，每区块/每区段平均",
  create(params): Analyzer {
    const p = (params["ore-exposure"] ?? {}) as Record<string, unknown>
    const oreSet = new Set(((p.ores as string[] | undefined) ?? DEFAULT_ORES).map(o => (o.includes(":") ? o : `minecraft:${o}`)))
    const yMin = p.yMin as number | undefined
    const yMax = p.yMax as number | undefined
    const wantSections = p.sections !== false

    const totals = new Map<string, Counts>()
    const families = new Map<string, Counts>()
    const sections = new Map<number, { total: number, byOre: Map<string, Counts> }>()
    /** 每个区段被多少个区块覆盖（区段平均的分母） */
    const sectionChunks = new Map<number, number>()
    let chunks = 0
    let oreBlocks = 0

    // region 内跨区块邻居查询
    let world: World | null = null
    let refs = new Map<string, ChunkRef>()
    const cache = new Map<string, ChunkSolids | null>()

    const chunkKey = (cx: number, cz: number) => `${cx},${cz}`

    async function solidsAt(cx: number, cz: number): Promise<ChunkSolids | null> {
      const k = chunkKey(cx, cz)
      if (cache.has(k)) return cache.get(k)!
      const ref = refs.get(k)
      if (!ref || !world) { cache.set(k, null); return null }
      const res = await world.chunkBlocks(ref, { includeAir: false })
      let entry: ChunkSolids | null = null
      if (res) {
        entry = { ids: res.palette.map(s => s.id), solid: new Map() }
        for (let i = 0; i < res.raw.length; i += 4) {
          entry.solid.set(packed(res.raw[i + 1], res.raw[i + 2], res.raw[i + 3]), res.raw[i])
        }
      }
      cache.set(k, entry)
      if (cache.size > 6) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined && oldest !== k) cache.delete(oldest)
      }
      return entry
    }

    const bump = (map: Map<string, Counts>, id: string, c: Counts) => {
      const t = map.get(id) ?? empty()
      t.total += c.total; t.air += c.air; t.water += c.water
      t.both += c.both; t.buried += c.buried; t.unknownEdge += c.unknownEdge
      map.set(id, t)
    }

    return {
      name: "ore-exposure",
      onRegion(session) {
        world = session.world
        refs = new Map(session.chunks.map(c => [chunkKey(c.cx, c.cz), c]))
        cache.clear()
      },
      async onChunk(c: ChunkHandle) {
        const res = await c.blocks({ includeAir: false, yMin, yMax })
        if (!res) return
        chunks++

        // 区段平均的分母：该区块覆盖了哪些区段（chunkExtent 很便宜，实测半秒级/2286 区块）
        const ext = await c.extent()
        if (ext) {
          for (let sec = Math.floor(ext.bottom / 16); sec <= Math.floor(ext.top / 16); sec++) {
            sectionChunks.set(sec, (sectionChunks.get(sec) ?? 0) + 1)
          }
        }

        const ids = res.palette.map(s => s.id)
        const { raw } = res
        const self: ChunkSolids = { ids, solid: new Map() }
        for (let i = 0; i < raw.length; i += 4) self.solid.set(packed(raw[i + 1], raw[i + 2], raw[i + 3]), raw[i])
        cache.set(chunkKey(c.x, c.z), self)

        const bx = c.x * 16
        const bz = c.z * 16
        const idAt = async (gx: number, y: number, gz: number): Promise<string | null> => {
          const cx = Math.floor(gx / 16), cz = Math.floor(gz / 16)
          const cs = cx === c.x && cz === c.z ? self : await solidsAt(cx, cz)
          if (!cs) return null
          const idx = cs.solid.get(packed(gx - cx * 16, y, gz - cz * 16))
          return idx === undefined ? "minecraft:air" : cs.ids[idx]
        }

        for (let i = 0; i < raw.length; i += 4) {
          const id = ids[raw[i]]
          if (!oreSet.has(id)) continue
          const gx = raw[i + 1], y = raw[i + 2], gz = raw[i + 3]
          oreBlocks++
          let air = false, water = false, unknown = false
          for (const [dx, dy, dz] of DIRS) {
            const nid = await idAt(gx + dx, y + dy, gz + dz)
            if (nid === null) { unknown = true; continue }
            if (AIR.has(nid)) air = true
            else if (WATER.has(nid)) water = true
          }
          const cnt = empty()
          cnt.total = 1
          if (air && water) { cnt.air = 1; cnt.water = 1; cnt.both = 1 }
          else if (air) cnt.air = 1
          else if (water) cnt.water = 1
          else if (unknown) cnt.unknownEdge = 1
          else cnt.buried = 1

          bump(totals, id, cnt)
          bump(families, oreFamily(id), cnt)
          if (wantSections) {
            const sec = Math.floor(y / 16)
            const s = sections.get(sec) ?? { total: 0, byOre: new Map<string, Counts>() }
            s.total++
            bump(s.byOre, id, cnt)
            sections.set(sec, s)
          }
        }
      },
      finalize() {
        /** 平均值（分母 = 区块数或区段覆盖区块数），保留两位小数 */
        const avgStat = (c: Counts, denom: number): AvgStat => {
          const a = (n: number) => (denom > 0 ? Number((n / denom).toFixed(2)) : 0)
          return {
            avgTotal: a(c.total), avgAirExposed: a(c.air), avgWaterExposed: a(c.water),
            avgBoth: a(c.both), avgBuried: a(c.buried), avgUnknownEdge: a(c.unknownEdge),
            airPct: c.total ? Number((c.air / c.total * 100).toFixed(2)) : 0,
            waterPct: c.total ? Number((c.water / c.total * 100).toFixed(2)) : 0,
          }
        }
        const avgNum = (n: number, denom: number) => (denom > 0 ? Number((n / denom).toFixed(2)) : 0)
        const sum = [...totals.values()].reduce((a, c) => {
          a.total += c.total; a.air += c.air; a.water += c.water; a.both += c.both; a.buried += c.buried; a.unknownEdge += c.unknownEdge
          return a
        }, empty())

        const familyOrder = [...families.entries()].sort((a, b) => b[1].total - a[1].total).map(([k]) => k)
        const byFamily = Object.fromEntries([...families.entries()]
          .sort((a, b) => b[1].total - a[1].total)
          .map(([k, v]) => [k, avgStat(v, chunks)])) as Record<string, AvgStat>

        // 种类 × 区段 交叉表：行 = 区段（深→浅），列 = 矿种 family，值为每区块该区段的平均
        const matrix: OreMatrix = {
          families: familyOrder,
          rows: [...sections.entries()].sort((a, b) => b[0] - a[0]).map(([sec, v]) => {
            const denom = sectionChunks.get(sec) ?? 0
            const byFam = new Map<string, Counts>()
            for (const [id, c] of v.byOre) bump(byFam, oreFamily(id), c)
            return {
              section: sec,
              yRange: [sec * 16, sec * 16 + 15],
              /** 包含该区段的区块数（平均值分母） */
              chunks: denom,
              avgTotal: avgNum(v.total, denom),
              cells: Object.fromEntries(familyOrder.map(f => [f, avgStat(byFam.get(f) ?? empty(), denom)])),
            }
          }),
        }

        return {
          chunks,
          /** 每区块平均矿石数 */
          avgOresPerChunk: avgNum(oreBlocks, chunks),
          note: "数量均为平均值：perChunk/byOre/byFamily 为每区块，matrix/sections 为每区段每区块；airExposed/waterExposed 可重叠（both 表示同时接触空气和水）",
          perChunk: avgStat(sum, chunks),
          byOre: Object.fromEntries([...totals.entries()].sort((a, b) => b[1].total - a[1].total).map(([k, v]) => [k, avgStat(v, chunks)])),
          byFamily,
          matrix: wantSections ? matrix : undefined,
          sections: wantSections
            ? Object.fromEntries([...sections.entries()].sort((a, b) => b[0] - a[0]).map(([sec, v]) => {
                const denom = sectionChunks.get(sec) ?? 0
                return [String(sec * 16), {
                  section: sec,
                  yRange: [sec * 16, sec * 16 + 15],
                  /** 包含该区段的区块数（平均值分母） */
                  chunks: denom,
                  avgTotal: avgNum(v.total, denom),
                  byOre: Object.fromEntries([...v.byOre.entries()].sort((a, b) => b[1].total - a[1].total).map(([k, c]) => [k, avgStat(c, denom)])),
                }]
              }))
            : undefined,
        }
      },
    }
  },
  format(result) {
    const r = result as { perChunk: AvgStat, byFamily: Record<string, AvgStat>, matrix?: OreMatrix }
    const ex = r.perChunk
    const lines = [
      `每区块矿石 ${ex.avgTotal}：空气暴露 ${ex.avgAirExposed} (${ex.airPct}%)，水暴露 ${ex.avgWaterExposed} (${ex.waterPct}%)，两者 ${ex.avgBoth}，全埋 ${ex.avgBuried}`,
      ...Object.entries(r.byFamily).slice(0, 6).map(([f, v]) =>
        `  ${f.padEnd(14)} 每区块 ${String(v.avgTotal).padStart(7)}  空气 ${String(v.avgAirExposed).padStart(5)}  水 ${String(v.avgWaterExposed).padStart(5)}`),
    ]
    if (r.matrix) {
      lines.push("", "数量（每区段每区块平均，行=区段，列=矿种）", ...oreMatrixLines(r.matrix, "total", r.byFamily))
      lines.push("", "暴露（空气/水，每区段每区块平均，行=区段，列=矿种）", ...oreMatrixLines(r.matrix, "exposure", r.byFamily))
    }
    return lines
  },
}

export default analyzer
