import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** 产物目录里字段说明的文件名 */
export const FIELD_DOC_FILE = "README.md"

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 字段说明的候选位置：
 * - `dist/OUTPUTS.md`：构建时从仓库根复制过去，让 dist 自包含
 * - 仓库根 `OUTPUTS.md`：直接从 `src/` 运行时（tsx/ts-node）的布局
 * - 当前工作目录：从别处调用时兜底
 */
const CANDIDATES = [
  join(HERE, "../OUTPUTS.md"),
  join(HERE, "../../OUTPUTS.md"),
  join(process.cwd(), "OUTPUTS.md"),
]

/** 读出字段说明全文；找不到返回 null，由调用方决定如何报出 */
export async function loadFieldDoc(): Promise<string | null> {
  for (const path of CANDIDATES) {
    if (!existsSync(path)) continue
    return readFile(path, "utf8")
  }
  return null
}

/** 把字段说明写到产物目录，随本次统计一起交付 */
export async function writeFieldDoc(outDir: string, text: string): Promise<void> {
  await writeFile(join(outDir, FIELD_DOC_FILE), text, "utf8")
}
