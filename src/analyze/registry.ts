import { readdir } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { join, resolve } from "node:path"
import type { AnalyzerModule } from "./types.js"
import { NOT_AN_ANALYZER_KEY } from "./types.js"
import { log } from "../lib/util.js"

/**
 * 分析器全部按目录发现，进程内没有逐项注册表：
 * - 生产分析器：本文件同级的 ./production（编译产物），analyze 默认只跑这些
 * - 示例分析器：本文件同级的 ./examples，需要 --analyzers 点名
 * - 外部分析器：config.analyze.pluginDir（默认 analyzers/），同样需要点名
 *
 * 三类共用同一个加载器，判定标准一致：默认导出或具名导出（`mod.default ?? mod`）
 * 一个 `{ name, create(params) }` 对象。加生产分析器只需往 production/ 丢一个文件。
 *
 * 目录里也可以放共享库（被多个分析器复用的知识/工具），用 `notAnAnalyzer`
 * 声明后加载器会跳过——不需要为「辅助文件放哪」另外发明目录约定。
 */

const BUILTIN_DIRS = {
  production: fileURLToPath(new URL("./production/", import.meta.url)),
  examples: fileURLToPath(new URL("./examples/", import.meta.url)),
}

/**
 * 从目录加载分析器。
 *
 * 目录里除了分析器还可以放**共享库**（例如 `production/landmarks.ts`，由多个
 * 结构分析器共用）。这类文件用 `export const notAnAnalyzer = true` 声明自己，
 * 加载器见到就静默跳过——约定字段优先于按文件名或目录层级猜。
 *
 * reload=true 时给 import URL 加时间戳绕过模块缓存 —— 外部目录的文件用户可能边跑边改；
 * 内置目录不加，靠模块缓存避免重复解析（两者都在单次进程运行里只加载一次）。
 */
async function loadAnalyzersFromDir(
  dir: string,
  opts: { label: string, reload?: boolean },
): Promise<AnalyzerModule[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const out: AnalyzerModule[] = []
  for (const f of files.sort()) {
    if (!/\.(m?js|cjs)$/.test(f)) continue
    const url = pathToFileURL(resolve(join(dir, f))).href
    try {
      const mod = await import(opts.reload ? `${url}?t=${Date.now()}` : url)
      // 共享库：文件自己声明不是分析器，静默跳过
      if ((mod as Record<string, unknown>)[NOT_AN_ANALYZER_KEY] === true) continue
      const m = (mod.default ?? mod) as Partial<AnalyzerModule>
      if (typeof m?.create !== "function" || typeof m?.name !== "string") {
        log.warn(`${opts.label} ${f} 不是有效的分析器（需要 name + create()；共享库请加 export const notAnAnalyzer = true）`)
        continue
      }
      out.push(m as AnalyzerModule)
    } catch (e) {
      log.warn(`${opts.label} ${f} 载入失败：${(e as Error).message}`)
    }
  }
  return out
}

export function productionAnalyzers(): Promise<AnalyzerModule[]> {
  return loadAnalyzersFromDir(BUILTIN_DIRS.production, { label: "生产分析器" })
}

export function exampleAnalyzers(): Promise<AnalyzerModule[]> {
  return loadAnalyzersFromDir(BUILTIN_DIRS.examples, { label: "示例分析器" })
}

/** 外部分析器：analyzers/*.js|mjs，模块需导出 { name, create(params) } */
export function loadPlugins(dir: string): Promise<AnalyzerModule[]> {
  return loadAnalyzersFromDir(dir, { label: "插件", reload: true })
}

export async function productionNames(): Promise<string[]> {
  return (await productionAnalyzers()).map(m => m.name)
}

export async function exampleNames(): Promise<string[]> {
  return (await exampleAnalyzers()).map(m => m.name)
}

/** 选择器：all = 生产 + 示例 + 插件，examples = 只看示例 */
const SELECTORS = new Set(["all", "examples"])

/**
 * 解析要跑的分析器。
 * names 为空 = 只跑生产分析器；否则按名字选取，可用 all / examples 选择器。
 * 同名时外部插件覆盖内置（方便临时替换某个统计的实现）。
 */
export async function resolveAnalyzers(names: string[], pluginDir: string): Promise<AnalyzerModule[]> {
  const [production, examples, plugins] = await Promise.all([
    productionAnalyzers(),
    exampleAnalyzers(),
    loadPlugins(pluginDir),
  ])

  const pool = new Map<string, AnalyzerModule>()
  for (const m of [...production, ...examples, ...plugins]) pool.set(m.name, m)

  const wanted = names.filter(n => !SELECTORS.has(n))
  const picked: string[] = []
  if (!names.length) picked.push(...production.map(m => m.name))
  else {
    if (names.includes("all")) picked.push(...pool.keys())
    if (names.includes("examples")) picked.push(...examples.map(m => m.name))
    picked.push(...wanted)
  }

  const out: AnalyzerModule[] = []
  const seen = new Set<string>()
  for (const n of picked) {
    if (seen.has(n)) continue
    seen.add(n)
    const m = pool.get(n)
    if (!m) {
      log.warn(`未知分析器 ${n}，可选：${[...pool.keys()].join(", ")}（另有 all / examples）`)
      continue
    }
    out.push(m)
  }
  if (!out.length) throw new Error("没有可用的分析器")
  return out
}
