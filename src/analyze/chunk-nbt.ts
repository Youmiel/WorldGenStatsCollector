import { gunzipSync, inflateSync } from "node:zlib"
import { readNBT } from "minecraft-block-reader"
import type { ChunkRef } from "minecraft-block-reader"

/**
 * 直接解析 region 文件里的区块 NBT。
 *
 * minecraft-block-reader 的 world.chunk() 只保留白名单根键
 * （sections / block_entities / xPos / zPos / Entities / Level / DataVersion），
 * structures、Heightmaps、PostProcessing 这些会被丢掉，需要这些字段时走这里。
 *
 * only 会交给 readNBT 做键过滤：只解析用到的根键，比整块解析便宜得多。
 */
export async function readRegionChunkNbt(
  bytes: Uint8Array,
  ref: ChunkRef,
  only?: readonly string[],
): Promise<Record<string, unknown> | null> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const index = (ref.cz & 31) * 32 + (ref.cx & 31)
  if (index * 4 + 4 > bytes.length) return null
  const loc = dv.getUint32(index * 4)
  if (!loc) return null
  const off = (loc >>> 8) * 4096
  if (off + 5 > bytes.length) return null
  const len = dv.getUint32(off)
  const method = bytes[off + 4]
  const payload = bytes.subarray(off + 5, off + 4 + len)

  let data: Uint8Array
  if (method === 1) data = new Uint8Array(gunzipSync(payload))
  else if (method === 2) data = new Uint8Array(inflateSync(payload))
  else if (method === 3) data = payload
  else throw new Error(`不支持的区块压缩方式 ${method}`)

  return readNBT(data, only ? { only: new Set(only) } : undefined) as Promise<Record<string, unknown>>
}
