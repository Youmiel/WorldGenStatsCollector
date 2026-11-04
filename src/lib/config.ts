import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { exists, log } from "./util.js"

export interface Area {
  shape: "circle" | "square"
  center: [number, number]
  radius: number
  /** 预生成实测的区块包围盒（Chebyshev）；有它就按包围盒过滤，最贴近 Chunky 实际生成范围 */
  chunkBounds?: { minX: number, maxX: number, minZ: number, maxZ: number }
}

export interface Config {
  minecraft: {
    /** Minecraft 版本，例如 "26.3"；null 表示用 installer 的 latest */
    version: string
    /** Fabric loader 版本；null 表示用 installer 的 latest */
    loader: string | null
  }
  server: {
    dir: string
    memoryMB: number
    /** java 可执行文件绝对路径；null 表示用 PATH 里的 java */
    javaPath: string | null
    levelName: string
    seed: string
    levelType: string
    viewDistance: number
    simulationDistance: number
    javaArgs: string[]
  }
  mods: {
    chunky: boolean
    c2me: boolean
    fabricApi: boolean
    /** c2me 线程数覆盖；null 表示沿用 mod 自动生成的值 */
    c2meThreads: number | null
    /** c2me threadPoolPriorityPreset（LOW / NORMAL / HIGH 等）；null 表示不干预 */
    c2mePriority: string | null
  }
  pregen: {
    dimension: string
    shape: "circle" | "square"
    center: [number, number]
    radius: number
    timeoutMinutes: number
    /** 任务完成后等几秒再 stop，让 c2me 把在途区块刷盘 */
    settleSeconds: number
  }
  analyze: {
    /** 统计范围：pregen = 用 pregen-last.json 记录的范围；all = 全量 */
    range: "pregen" | "all"
    /** 显式范围，覆盖 range */
    area: Area | null
    outDir: string
    dimensions: string[]
    /** 启用的分析器名，空数组 = 只跑生产分析器；all = 全部；examples = 示例 */
    analyzers: string[]
    /** 外部分析器目录（.js / .mjs，导出 create()） */
    pluginDir: string
    /** 传给分析器的自由参数，原样透传 */
    params: Record<string, unknown>
  }
}

// 默认值按「小内存、多核」的机器取：堆 2G、c2me 4 线程；按实际机器改 memoryMB / c2meThreads。
export const DEFAULT_CONFIG: Config = {
  minecraft: { version: "26.3", loader: null },
  server: {
    dir: ".server/{version}",
    memoryMB: 2048,
    javaPath: null,
    levelName: "world",
    seed: "",
    levelType: "minecraft:normal",
    viewDistance: 10,
    simulationDistance: 6,
    javaArgs: ["-XX:+UseG1GC", "-XX:MaxGCPauseMillis=200", "-Dfile.encoding=UTF-8"],
  },
  mods: { chunky: true, c2me: true, fabricApi: true, c2meThreads: 4, c2mePriority: null },
  pregen: { dimension: "overworld", shape: "circle", center: [0, 0], radius: 256, timeoutMinutes: 60, settleSeconds: 5 },
  analyze: {
    range: "pregen",
    area: null,
    outDir: "stats",
    dimensions: ["overworld"],
    analyzers: [],
    pluginDir: "analyzers",
    params: {},
  },
}

export const configPath = (root: string) => resolve(root, "worldgen.config.json")

/** 服务端目录：展开 {version} 占位符，默认按版本隔离 */
export function serverDir(root: string, cfg: Config): string {
  return resolve(root, cfg.server.dir.replace(/\{version\}/g, cfg.minecraft.version))
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch as T)
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge((base as Record<string, unknown>)[k], v) : v
  }
  return out as T
}

export async function loadConfig(root: string): Promise<Config> {
  const p = configPath(root)
  if (!(await exists(p))) {
    await writeFile(p, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8")
    log.info(`已生成默认配置 ${p}`)
    return structuredClone(DEFAULT_CONFIG)
  }
  const raw = JSON.parse(await readFile(p, "utf8"))
  return deepMerge(structuredClone(DEFAULT_CONFIG), raw)
}

export async function saveConfig(root: string, cfg: Config) {
  await writeFile(configPath(root), JSON.stringify(cfg, null, 2) + "\n", "utf8")
}
