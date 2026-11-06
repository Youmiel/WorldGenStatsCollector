import { writeFile } from "node:fs/promises"
import { PNG } from "pngjs"
import { NO_Y, TerrainIndex } from "./terrain.js"
import type { TerrainMask } from "./mask.js"

/**
 * 地形 / mask / 湖泊 / mesh 的可视化输出（PNG）。
 *
 * 定位：分析器的一个固定输出阶段，不是通用命令 —— 只有需要「肉眼看地形对不对」的
 * 分析器才调它（目前是 lava-lakes）。默认输出 1/4 分辨率（4 方块 / 像素），
 * 一张 r=1100 的图约 570x570，够看清 mask 边界与 mesh 连线，也不至于几 MB。
 *
 * 图例：
 *   深蓝 = 水域；灰暗 = mask 判定的不可用 tile；褐斑 = 3x3 高差超阈值的陡坡列
 *   绿到黄 = 可用陆地的地面高度；白点 = 合格湖；红点 = 因陡坡/水域剔除的湖
 *   黄线 = 通过 mask 校验的 mesh 边；红线 = 直线穿越不可用地形因而被剔除的边
 *   黑线 = mask 连通区边界（1px）
 */

export interface VizLake {
  x: number
  z: number
  /** 被地形过滤剔除 */
  filtered: boolean
}

export interface VizEdge {
  x0: number
  z0: number
  x1: number
  z1: number
  /** 直线穿越不可用地形，不计入间距 */
  crosses: boolean
}

export interface VizInput {
  terrain: TerrainIndex
  mask: TerrainMask
  slopeThreshold: number
  lakes: VizLake[]
  edges: VizEdge[]
}

export interface VizOptions {
  /** 方块 / 像素，默认 4（1/4 分辨率） */
  scale?: number
}

const COLORS = {
  noData: [22, 22, 26] as const,
  water: [32, 62, 104] as const,
  steep: [108, 88, 68] as const,
  tileBorder: [0, 0, 0] as const,
  lake: [255, 255, 255] as const,
  lakeFiltered: [255, 70, 70] as const,
  edgeKept: [255, 212, 0] as const,
  edgeCrosses: [190, 60, 60] as const,
  outline: [0, 0, 0] as const,
  unusableShade: 0.62,
}

/** 地面高度 → 颜色（低处偏绿，高处偏黄） */
function groundColor(y: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (y - 50) / 90))
  return [
    Math.round(58 + (176 - 58) * t),
    Math.round(96 + (158 - 96) * t),
    Math.round(48 + (124 - 48) * t),
  ]
}

/**
 * 渲染并写出一张 PNG。
 * 每像素取该像素左上角对应的那一列作为代表 —— 地表是连续的，1/4 降采样下足够。
 */
export async function renderTerrainMap(input: VizInput, filePath: string, opts: VizOptions = {}): Promise<void> {
  const scale = Math.max(1, Math.trunc(opts.scale ?? 4))
  const bounds = input.terrain.worldBounds()
  if (!bounds) throw new Error("没有地形数据，无法生成可视化")

  const width = Math.ceil((bounds.maxX - bounds.minX + 1) / scale)
  const height = Math.ceil((bounds.maxZ - bounds.minZ + 1) / scale)
  const png = new PNG({ width, height })
  const data = png.data

  const put = (px: number, py: number, rgb: readonly [number, number, number]) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return
    const o = (py * width + px) * 4
    data[o] = rgb[0]
    data[o + 1] = rgb[1]
    data[o + 2] = rgb[2]
    data[o + 3] = 255
  }
  const shade = (px: number, py: number, k: number) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return
    const o = (py * width + px) * 4
    data[o] = Math.round(data[o] * k)
    data[o + 1] = Math.round(data[o + 1] * k)
    data[o + 2] = Math.round(data[o + 2] * k)
  }
  const worldToPx = (wx: number, wz: number): [number, number] => [
    Math.floor((wx - bounds.minX) / scale),
    Math.floor((wz - bounds.minZ) / scale),
  ]
  const line = (x0: number, z0: number, x1: number, z1: number, rgb: readonly [number, number, number]) => {
    const dx = x1 - x0, dz = z1 - z0
    const steps = Math.max(Math.abs(dx), Math.abs(dz))
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps
      const [px, py] = worldToPx(Math.round(x0 + dx * t), Math.round(z0 + dz * t))
      put(px, py, rgb)
    }
  }

  /* 1. 地形底色 */
  input.terrain.eachChunk((cx, cz, t) => {
    for (let i = 0; i < 256; i++) {
      const g = t.groundY[i]
      if (g === NO_Y) continue
      const wx = cx * 16 + (i & 15)
      const wz = cz * 16 + (i >> 4)
      // 同一像素可能被多列命中，只画每个像素一次（取左上角代表）
      if ((wx - bounds.minX) % scale !== 0 || (wz - bounds.minZ) % scale !== 0) continue
      const [px, py] = worldToPx(wx, wz)
      if (t.water[i]) { put(px, py, COLORS.water); continue }
      const s = input.terrain.slope(wx, wz)
      put(px, py, s !== null && s >= input.slopeThreshold ? COLORS.steep : groundColor(g))
    }
  })

  /* 2. mask 不可用 tile 暗化 */
  for (let py = 0; py < height; py++) {
    const wz = bounds.minZ + py * scale
    for (let px = 0; px < width; px++) {
      const wx = bounds.minX + px * scale
      if (input.mask.componentAt(wx, wz) < 0) shade(px, py, COLORS.unusableShade)
    }
  }

  /* 3. mask 连通区边界（1px 黑线） */
  const ts = input.mask.tileSize
  const tx0 = Math.floor(bounds.minX / ts), tx1 = Math.floor(bounds.maxX / ts)
  const tz0 = Math.floor(bounds.minZ / ts), tz1 = Math.floor(bounds.maxZ / ts)
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let tz = tz0; tz <= tz1; tz++) {
      const bx = tx * ts, bz = tz * ts
      const c = input.mask.componentAt(bx, bz)
      if (c < 0) continue
      if (input.mask.componentAt(bx - 1, bz) !== c) line(bx, bz, bx, bz + ts - 1, COLORS.tileBorder)
      if (input.mask.componentAt(bx + ts, bz) !== c) line(bx + ts - 1, bz, bx + ts - 1, bz + ts - 1, COLORS.tileBorder)
      if (input.mask.componentAt(bx, bz - 1) !== c) line(bx, bz, bx + ts - 1, bz, COLORS.tileBorder)
      if (input.mask.componentAt(bx, bz + ts) !== c) line(bx, bz + ts - 1, bx + ts - 1, bz + ts - 1, COLORS.tileBorder)
    }
  }

  /* 4. mesh 边 */
  for (const e of input.edges) {
    line(e.x0, e.z0, e.x1, e.z1, e.crosses ? COLORS.edgeCrosses : COLORS.edgeKept)
  }

  /* 5. 湖泊点位（带黑描边，保证小湖在任何底色上可见） */
  const r = Math.max(2, Math.round(scale * 0.75))
  for (const l of input.lakes) {
    const [cx, cy] = worldToPx(l.x, l.z)
    const rgb = l.filtered ? COLORS.lakeFiltered : COLORS.lake
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy
        if (d2 <= r * r) put(cx + dx, cy + dy, rgb)
        else if (d2 <= (r + 1) * (r + 1)) put(cx + dx, cy + dy, COLORS.outline)
      }
    }
  }

  await writeFile(filePath, PNG.sync.write(png))
}
