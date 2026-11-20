import { readFile } from "node:fs/promises"
import { inflateRawSync } from "node:zlib"

/** zip 中央目录里的一条记录 */
export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/**
 * 只读中央目录的极简 zip 解析，用来取 jar 里的数据包 JSON（结构集合等），
 * 不落盘、不依赖外部 unzip。
 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  const min = Math.max(0, bytes.length - 66_000)
  for (let i = bytes.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error("不是有效的 zip/jar（找不到中央目录）")

  const total = dv.getUint16(eocd + 10, true)
  let off = dv.getUint32(eocd + 16, true)
  const out: ZipEntry[] = []
  for (let n = 0; n < total; n++) {
    if (off + 46 > bytes.length || dv.getUint32(off, true) !== CENTRAL) break
    const method = dv.getUint16(off + 10, true)
    const compressedSize = dv.getUint32(off + 20, true)
    const size = dv.getUint32(off + 24, true)
    const nameLen = dv.getUint16(off + 28, true)
    const extraLen = dv.getUint16(off + 30, true)
    const commentLen = dv.getUint16(off + 32, true)
    const localOffset = dv.getUint32(off + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen))
    out.push({ name, method, compressedSize, size, localOffset })
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 读一条 zip 记录的内容（支持 store / deflate） */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const off = entry.localOffset
  if (dv.getUint32(off, true) !== LOCAL) throw new Error(`zip 本地头损坏：${entry.name}`)
  const nameLen = dv.getUint16(off + 26, true)
  const extraLen = dv.getUint16(off + 28, true)
  const start = off + 30 + nameLen + extraLen
  const raw = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) return new Uint8Array(inflateRawSync(raw))
  throw new Error(`不支持的 zip 压缩方式 ${entry.method}：${entry.name}`)
}

/** 按前缀挑出条目并逐个解析成 JSON */
export async function readJarJson(prefix: string, jarPath: string): Promise<{ path: string, json: unknown }[]> {
  const bytes = new Uint8Array(await readFile(jarPath))
  const entries = listZipEntries(bytes).filter(e => e.name.startsWith(prefix) && e.name.endsWith(".json"))
  const dec = new TextDecoder()
  const out: { path: string, json: unknown }[] = []
  for (const e of entries) {
    out.push({ path: e.name, json: JSON.parse(dec.decode(readZipEntry(bytes, e))) })
  }
  return out
}

/**
 * 读 jar 里某一个具体路径的 JSON（按 zip 中央目录定位，不解压其它条目）。
 * 不存在、不是有效 JSON、或 jar 本身打不开时返回 null——调用方按「读不到」处理，不抛错。
 */
export async function readJarJsonEntry(path: string, jarPath: string): Promise<unknown | null> {
  try {
    const bytes = new Uint8Array(await readFile(jarPath))
    const entry = listZipEntries(bytes).find(e => e.name === path)
    if (!entry) return null
    return JSON.parse(new TextDecoder().decode(readZipEntry(bytes, entry))) as unknown
  } catch {
    return null
  }
}
