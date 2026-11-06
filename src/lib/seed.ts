import { randomBytes } from "node:crypto"
import { saveConfig, type Config } from "./config.js"
import { log } from "./util.js"

/** 与世界种子同域的有符号 64 位十进制值 */
export function randomSeed(): string {
  const buf = randomBytes(8)
  return BigInt.asIntN(64, buf.readBigUInt64BE(0)).toString()
}

/**
 * setup 前确定种子并写回配置文件。
 *
 * 种子必须落盘：pregen 每次 setup 都重新生成世界，稀有结构（府邸、神庙）只测到一两个起点，
 * 没有固定种子就无法重跑验证。
 *
 * `disk` 是未经 CLI 覆盖的磁盘配置 —— 只把 seed 两字段写回，其它命令行覆盖不落盘。
 */
export async function ensureSeed(cfg: Config, disk: Config, root: string): Promise<Config> {
  if (!cfg.server.seed) {
    cfg.server.seed = randomSeed()
    cfg.server.seedSource = "random"
    log.info(`生成世界种子 ${cfg.server.seed}（已写回配置）`)
  } else if (cfg.server.seedSource === null) {
    cfg.server.seedSource = "explicit"
  }

  if (disk.server.seed !== cfg.server.seed || disk.server.seedSource !== cfg.server.seedSource) {
    disk.server.seed = cfg.server.seed
    disk.server.seedSource = cfg.server.seedSource
    await saveConfig(root, disk)
  }
  return cfg
}
