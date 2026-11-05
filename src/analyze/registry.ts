import { readdir } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { join, resolve } from "node:path"
import type { AnalyzerModule } from "./types.js"
import { log } from "../lib/util.js"

/**
 * 分析器分三类：
 * - production：生产分析器（最终出统计结果用的），analyze 默认只跑这些
 * - examples：示例分析器，需要 --analyzers 点名
 * - plugins：analyzers/ 里的外部分析器，同样需要点名
 */
const production = new Map<string, () => Promise<AnalyzerModule>>()
const examples = new Map<string, () => Promise<AnalyzerModule>>()

/** 注册生产分析器（惰性 import，避免没用到也加载） */
export function registerProduction(name: string, loader: () => Promise<AnalyzerModule>) {
  production.set(name, loader)
}

/** 注册示例分析器 */
export function registerExample(name: string, loader: () => Promise<AnalyzerModule>) {
  examples.set(name, loader)
}

registerProduction("biome-histogram", () => import("./production/biome-histogram.js").then(m => m.default))
registerProduction("ore-exposure", () => import("./production/ore-exposure.js").then(m => m.default))
registerProduction("structure-spacing", () => import("./production/structure-spacing.js").then(m => m.default))
registerProduction("section-block-histogram", () => import("./production/section-block-histogram.js").then(m => m.default))
registerProduction("lava-lakes", () => import("./production/lava-lakes.js").then(m => m.default))

registerExample("chunk-index", () => import("./examples/chunk-index.js").then(m => m.default))
registerExample("block-histogram", () => import("./examples/block-histogram.js").then(m => m.default))
registerExample("surface-profile", () => import("./examples/surface-profile.js").then(m => m.default))
registerExample("ore-scan", () => import("./examples/ore-scan.js").then(m => m.default))

export function productionNames(): string[] {
  return [...production.keys()]
}

export function exampleNames(): string[] {
  return [...examples.keys()]
}

/**
 * 外部分析器：analyzers/*.js|mjs，模块需导出 { name, create(params) } 或默认导出该对象。
 * 这样加统计只要丢一个文件进 analyzers/，不用改主程序。
 */
export async function loadPlugins(dir: string): Promise<AnalyzerModule[]> {
  const out: AnalyzerModule[] = []
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return out
  }
  for (const f of files.sort()) {
    if (!/\.(m?js|cjs)$/.test(f)) continue
    const full = resolve(join(dir, f))
    try {
      const mod = await import(pathToFileURL(full).href + `?t=${Date.now()}`)
      const m = (mod.default ?? mod) as Partial<AnalyzerModule>
      if (typeof m?.create !== "function" || typeof m?.name !== "string") {
        log.warn(`插件 ${f} 不是有效的分析器（需要 name + create()）`)
        continue
      }
      out.push(m as AnalyzerModule)
      log.info(`载入插件分析器 ${m.name} (${f})`)
    } catch (e) {
      log.warn(`插件 ${f} 载入失败：${(e as Error).message}`)
    }
  }
  return out
}

/** 预留的选择器：all = 生产 + 示例 + 插件，examples = 只看示例 */
const SELECTORS = new Set(["all", "examples"])

/**
 * 解析要跑的分析器。
 * names 为空 = 只跑生产分析器；否则按名字选取，可用 all / examples 选择器。
 */
export async function resolveAnalyzers(names: string[], pluginDir: string): Promise<AnalyzerModule[]> {
  const plugins = await loadPlugins(pluginDir)
  const pool = new Map<string, AnalyzerModule | (() => Promise<AnalyzerModule>)>()
  for (const [k, v] of production) pool.set(k, v)
  for (const [k, v] of examples) pool.set(k, v)
  for (const p of plugins) pool.set(p.name, p)

  const wanted = names.filter(n => !SELECTORS.has(n))
  const picked: string[] = []
  if (!names.length) picked.push(...productionNames())
  else {
    if (names.includes("all")) picked.push(...productionNames(), ...exampleNames(), ...plugins.map(p => p.name))
    if (names.includes("examples")) picked.push(...exampleNames())
    picked.push(...wanted)
  }

  const out: AnalyzerModule[] = []
  const seen = new Set<string>()
  for (const n of picked) {
    if (seen.has(n)) continue
    seen.add(n)
    const entry = pool.get(n)
    if (!entry) {
      log.warn(`未知分析器 ${n}，可选：${[...pool.keys()].join(", ")}（另有 all / examples）`)
      continue
    }
    out.push(typeof entry === "function" ? await entry() : entry)
  }
  if (!out.length) throw new Error("没有可用的分析器")
  return out
}
