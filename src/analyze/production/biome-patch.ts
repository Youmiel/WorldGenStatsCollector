import type { Analyzer, AnalyzerModule, ChunkHandle } from "../types.js"
import { packXZ, unpackX, unpackZ } from "../terrain.js"

/**
 * 群系斑块（biome patch）：某群系在世界里是连成大片还是碎成小块。
 *
 * biome-histogram 只给面积占比，给不出「走进这个群系要走多远」；这个分析器把每列的地表群系
 * 做 4 连通洪泛，得到每个群系的连通斑块规模。
 *
 * 口径：
 * - 群系取每列最高的非空气方块处的群系，与 biome-histogram 的地表口径一致。
 * - 一列 = 1 方块²，所以斑块面积（区块²）直接就是连通列数。
 * - 4 连通（不认斜角）；跨区块、跨 region 的连通都是一次洪泛，不会被文件边界切断。
 * - areaVariance 是变异系数平方（var / mean²），不是原始方差 —— 原始方差随尺度变，跨群系不可比。
 * - openSurfaceShare = 「地表本身非水/冰，且其上一格是空气」的列占比。
 *   这是「能站上去并垂直进入该群系」的口径；水下群系计 0。
 * - neighbors = 该群系边界列上与不同群系相邻的次数占比（分母 = 它与其他群系的接触总数）。
 * - edgeTouchCount = 触及扫描范围边界的斑块数。这类斑块可能被范围裁断、面积偏小；
 *   均值包含它们（note 里写明），需要「完整斑块」的下游可用 columns / patches.count 自行剔除。
 *
 * params:
 *   top?: number   控制台摘要里列出的群系数（默认 12），不影响产物
 */

const KEY = "biome-patch"
const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"])
const WATER = /(^|:)(water|bubble_column|ice|frosted_ice|blue_ice|packed_ice)$/
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/** 一个区块的 256 列：地表群系编号 + 开放性 + 洪泛访问标记 */
interface ChunkColumns {
  /** 全局群系编号（1-based，0 = 无数据） */
  biome: Uint16Array
  open: Uint8Array
  seen: Uint8Array
}

interface PatchStat {
  count: number
  meanAreaBlocks: number | null
  medianAreaBlocks: number | null
  /** 变异系数平方 var / mean² */
  areaVariance: number | null
  maxAreaBlocks: number | null
  edgeTouchCount: number
}

function median(v: number[]): number | null {
  if (!v.length) return null
  const s = [...v].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function patchStat(areas: number[], edgeTouches: number): PatchStat {
  if (!areas.length) {
    return { count: 0, meanAreaBlocks: null, medianAreaBlocks: null, areaVariance: null, maxAreaBlocks: null, edgeTouchCount: edgeTouches }
  }
  const mean = areas.reduce((a, b) => a + b, 0) / areas.length
  const variance = areas.reduce((a, b) => a + (b - mean) ** 2, 0) / areas.length
  const max = areas.reduce((a, b) => Math.max(a, b), -Infinity)
  return {
    count: areas.length,
    meanAreaBlocks: mean,
    medianAreaBlocks: median(areas),
    // 变异系数平方：无量纲，跨群系可比；0 方差时才为 0
    areaVariance: mean > 0 ? variance / (mean * mean) : null,
    maxAreaBlocks: max,
    edgeTouchCount: edgeTouches,
  }
}

const analyzer: AnalyzerModule = {
  name: KEY,
  description: "群系斑块规模：4 连通连通分量的面积分布、边界接触、邻接与地表开放性",
  parallelCost: 0.5,
  units: {
    area: "block^2",
    distance: "block",
    share: "fraction",
  },
  create(params): Analyzer {
    const p = (params[KEY] ?? {}) as Record<string, unknown>
    const top = Math.max(1, Math.trunc(Number(p.top) || 12))

    const chunks = new Map<number, ChunkColumns>()
    const palette = new Map<string, number>()
    const ids: string[] = [""]

    const idOf = (id: string): number => {
      let i = palette.get(id)
      if (i === undefined) {
        ids.push(id)
        i = ids.length - 1
        palette.set(id, i)
      }
      return i
    }

    return {
      name: KEY,
      async onChunk(c: ChunkHandle) {
        const ext = await c.extent()
        if (!ext) return
        const grid = await c.grid({ yMin: ext.bottom, yMax: ext.top })
        const h = ext.top - ext.bottom + 1
        if (h <= 0 || grid.biomes.grid.length !== h * 256) return

        const cols: ChunkColumns = {
          biome: new Uint16Array(256),
          open: new Uint8Array(256),
          seen: new Uint8Array(256),
        }

        for (let col = 0; col < 256; col++) {
          // 地表 = 该列最高的非空气方块（水算方块，与 biome-histogram 同口径）
          let topOff = -1
          for (let yi = h - 1; yi >= 0; yi--) {
            if (grid.grid[yi * 256 + col] !== 0) { topOff = yi; break }
          }
          if (topOff < 0) continue
          const bIdx = grid.biomes.grid[topOff * 256 + col]
          if (!bIdx) continue
          const bId = grid.biomes.palette[bIdx - 1]
          if (!bId) continue
          cols.biome[col] = idOf(bId)

          // 开放性：地表本身不是水/冰，且上一格是空气（超出高度也算空气）
          const topVal = grid.grid[topOff * 256 + col]
          const topId = grid.palette[topVal - 1]?.id ?? ""
          if (WATER.test(topId)) continue
          const above = topOff + 1
          if (above >= h) { cols.open[col] = 1; continue }
          const aboveVal = grid.grid[above * 256 + col]
          if (aboveVal === 0) { cols.open[col] = 1; continue }
          const aboveId = grid.palette[aboveVal - 1]?.id ?? ""
          if (AIR.has(aboveId)) cols.open[col] = 1
        }

        if (cols.biome.some(v => v !== 0)) chunks.set(packXZ(c.x, c.z), cols)
      },
      finalize() {
        if (!chunks.size) {
          return { columns: 0, boundaryColumns: 0, biomes: [], note: "没有可统计的列" }
        }

        let minCX = Infinity, maxCX = -Infinity, minCZ = Infinity, maxCZ = -Infinity
        for (const key of chunks.keys()) {
          const cx = unpackX(key), cz = unpackZ(key)
          if (cx < minCX) minCX = cx
          if (cx > maxCX) maxCX = cx
          if (cz < minCZ) minCZ = cz
          if (cz > maxCZ) maxCZ = cz
        }
        const minX = minCX * 16, maxX = maxCX * 16 + 15
        const minZ = minCZ * 16, maxZ = maxCZ * 16 + 15

        const cellOf = (wx: number, wz: number): number => {
          const c = chunks.get(packXZ(wx >> 4, wz >> 4))
          if (!c) return 0
          return c.biome[((wz & 15) << 4) | (wx & 15)]
        }

        /* ---------------- 列数 / 开放性 / 边界接触 ---------------- */
        const columns = new Map<number, number>()
        const openColumns = new Map<number, number>()
        const touches = new Map<number, Map<number, number>>()
        let totalColumns = 0
        let boundaryColumns = 0

        for (const [key, c] of chunks) {
          const wx0 = unpackX(key) * 16, wz0 = unpackZ(key) * 16
          for (let i = 0; i < 256; i++) {
            const b = c.biome[i]
            if (!b) continue
            totalColumns++
            columns.set(b, (columns.get(b) ?? 0) + 1)
            if (c.open[i]) openColumns.set(b, (openColumns.get(b) ?? 0) + 1)

            const wx = wx0 + (i & 15), wz = wz0 + (i >> 4)
            let boundary = false
            for (const [dx, dz] of DIRS) {
              const nx = wx + dx, nz = wz + dz
              // 扫描范围外群系未知，不臆造邻接
              if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) continue
              const nb = cellOf(nx, nz)
              if (!nb || nb === b) continue
              boundary = true
              let m = touches.get(b)
              if (!m) { m = new Map(); touches.set(b, m) }
              m.set(nb, (m.get(nb) ?? 0) + 1)
            }
            if (boundary) boundaryColumns++
          }
        }

        /* ---------------- 4 连通斑块 ---------------- */
        const areas = new Map<number, number[]>()
        const edgePatches = new Map<number, number>()

        for (const [key, c] of chunks) {
          const cx = unpackX(key), cz = unpackZ(key)
          for (let i = 0; i < 256; i++) {
            const b = c.biome[i]
            if (!b || c.seen[i]) continue
            let area = 0
            let edge = false
            const stx = [cx * 16 + (i & 15)]
            const stz = [cz * 16 + (i >> 4)]
            c.seen[i] = 1
            while (stx.length) {
              const x = stx.pop()!, z = stz.pop()!
              area++
              for (const [dx, dz] of DIRS) {
                const nx = x + dx, nz = z + dz
                // 贴扫描范围边界：这块斑块可能被范围裁断
                if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) { edge = true; continue }
                const nc = chunks.get(packXZ(nx >> 4, nz >> 4))
                // 范围内缺区块 = 该处没有地表列，连通本来就断了，不算范围裁断
                if (!nc) continue
                const idx = ((nz & 15) << 4) | (nx & 15)
                if (nc.biome[idx] !== b || nc.seen[idx]) continue
                nc.seen[idx] = 1
                stx.push(nx)
                stz.push(nz)
              }
            }
            let list = areas.get(b)
            if (!list) { list = []; areas.set(b, list) }
            list.push(area)
            if (edge) edgePatches.set(b, (edgePatches.get(b) ?? 0) + 1)
          }
        }

        /* ---------------- 输出 ---------------- */
        const biomes = [...columns.entries()]
          .sort((a, b) => b[1] - a[1] || ids[a[0]].localeCompare(ids[b[0]]))
          .map(([b, n]) => {
            const t = touches.get(b)
            const contacts = t ? [...t.values()].reduce((a, c) => a + c, 0) : 0
            const neighbors = t && contacts
              ? Object.fromEntries(
                  [...t.entries()]
                    .sort((a, b) => b[1] - a[1] || ids[a[0]].localeCompare(ids[b[0]]))
                    .map(([nb, cnt]) => [ids[nb], cnt / contacts]),
                )
              : {}
            return {
              id: ids[b],
              columns: n,
              areaFraction: n / (totalColumns || 1),
              patches: patchStat(areas.get(b) ?? [], edgePatches.get(b) ?? 0),
              openSurfaceShare: (openColumns.get(b) ?? 0) / (n || 1),
              neighbors,
            }
          })

        return {
          columns: totalColumns,
          boundaryColumns,
          top,
          biomes,
          note: "columns/areaFraction 的分母是该维度参与统计的总列数；一列 = 1 方块²，斑块面积为连通列数；areaVariance 为变异系数平方 var/mean²；openSurfaceShare 要求地表本身非水/冰且上一格为空气；neighbors 的分母是该群系与其他群系的接触总数；edgeTouchCount 的斑块贴扫描范围边界、面积可能被裁小，均值包含它们",
        }
      },
    }
  },
  format(result) {
    const r = result as {
      columns: number
      boundaryColumns: number
      top?: number
      biomes: { id: string, columns: number, patches: { count: number, meanAreaBlocks: number | null, maxAreaBlocks: number | null }, openSurfaceShare: number }[]
    }
    if (!r.biomes?.length) return ["没有可统计的列"]
    // 产物保留原始浮点（下游不要四舍五入），控制台只做显示层的取舍
    const fmtArea = (v: number | null) => (v === null ? "-" : v.toFixed(1))
    return [
      `列数 ${r.columns}，群系 ${r.biomes.length} 个，边界列 ${r.boundaryColumns}`,
      ...r.biomes.slice(0, r.top ?? 12).map(b =>
        `  ${b.id.padEnd(34)} ${String(b.columns).padStart(8)} 列  斑块 ${String(b.patches.count).padStart(4)}  平均 ${fmtArea(b.patches.meanAreaBlocks).padStart(10)}  开放 ${(b.openSurfaceShare * 100).toFixed(1)}%`,
      ),
    ]
  },
}

export default analyzer
