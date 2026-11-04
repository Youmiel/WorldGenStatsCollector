# WorldGenStatsCollector

Minecraft 世界生成统计工具：自动装配指定版本的 Fabric 服务端 → Chunky 预生成区块 → 解析存档 → 可插拔统计。

```
安装/装配  →  预生成（Chunky + c2me）  →  解析存档（minecraft-block-reader）  →  统计插件
```

## 快速开始

```bash
npm install
npm run build

node dist/cli.js setup    # 安装服务端 + 模组 + 配置，并首启验证
node dist/cli.js pregen   # 预生成
node dist/cli.js analyze  # 统计生产分析器（默认按预生成记录的范围）
node dist/cli.js analyze --all       # 全量统计
node dist/cli.js analyze --area 0,0,512 --area-shape square
# 或者一步到位
node dist/cli.js run --radius 512
```

## 命令

| 命令 | 作用 |
|---|---|
| `setup` | 检查/下载最新 fabric-installer，安装指定 MC 版本服务端、chunky、c2me、fabric-api，写 `server.properties`/`eula.txt`，首启生成 c2me/chunky 配置并调线程数与优先级 |
| `pregen` | 启动服务端，用 Chunky 按配置的 center/shape/radius 预生成，解析进度，完成后 `stop` |
| `analyze` | 遍历存档 region 文件，运行启用的统计器，结果写 `stats/<时间戳>/` |
| `run` | setup → pregen → analyze |
| `info` | 查看当前配置与安装状态 |
| `clean` | 删除统计结果；`--all` 连服务端一起删 |

常用参数：`--version`、`--loader`、`--seed`、`--mem`、`--radius`、`--shape`、`--center`、`--dimension`、`--timeout`、`--analyzers`、`--all`、`--area`、`--area-shape`、`--no-boot`、`--update-installer`、`--force`、`--verbose`。

CLI 参数只对本次运行生效，不写回 `worldgen.config.json`；要长期改配置请直接改文件。

`server.dir` 支持 `{version}` 占位符，默认 `.server/{version}`，即每个 MC 版本一个独立服务端目录（world / mods / config 全隔离）。`--server-dir` 指定的是字面路径，也支持占位符。

## 配置 `worldgen.config.json`

首次运行自动生成，CLI 参数会覆盖并回写。

```jsonc
{
  "minecraft": { "version": "26.3", "loader": null },   // null = installer 的 latest
  "server": { "dir": ".server/{version}", "memoryMB": 2048, "levelName": "world", "seed": "" },
  "mods": { "chunky": true, "c2me": true, "fabricApi": true, "c2meThreads": 4 },
  "pregen": { "dimension": "overworld", "shape": "circle", "center": [0, 0], "radius": 256 },
  "analyze": {
    "range": "pregen",          // pregen = 用预生成记录的范围；all = 全量
    "area": null,               // 显式范围 { shape, center, radius }，优先于 range
    "outDir": "stats",
    "dimensions": ["overworld"],
    "analyzers": [],            // 空 = 只跑生产分析器；all = 全部；也可写名字
    "pluginDir": "analyzers",
    "params": {}                // 原样透传给分析器
  }
}
```

## 统计层

统计逻辑与主程序解耦，分三类：

- 生产分析器 `src/analyze/production/` — `analyze` 默认只跑这些
- 示例分析器 `src/analyze/examples/` — 需要 `--analyzers` 点名，如 `--analyzers chunk-index,block-histogram`
- 外部分析器 `analyzers/*.js` — 同样需要点名，接口与示例分析器一致

`--analyzers all` 跑全部（生产 + 示例 + 插件），`--analyzers examples` 只跑示例。

示例分析器（`src/analyze/examples/`）：

- `chunk-index` — 区块数、region 数、坐标范围
- `block-histogram` — 方块 id 直方图（`yMin/yMax/includeAir/top`）
- `surface-profile` — 最高非空气方块高度分布（`bucket`）
- `ore-scan` — 指定方块 id 的计数骨架

### 写自己的分析器

`src/analyze/examples/ore-scan.ts` 是最小骨架：接口和插件完全一致，抄成 `.js` 丢进 `analyzers/` 就能用 `--analyzers` 点名运行。

在 `analyzers/` 放一个 `.js`（ESM）文件，默认导出一个对象：

```js
export default {
  name: "my-stat",
  description: "说明",
  create(params) {            // params.analyze.params
    let n = 0
    return {
      onRegion(session, ctx) {
        // session.world 是 minecraft-block-reader 的 World，可直接做任意范围查询：
        // await session.world.chunkBlocks(ref, { yMin, yMax })
      },
      async onChunk(chunk, ctx) {
        // chunk: { ref, x, z, nbt(), blocks(opts), grid(opts), extent(opts) }
        // 全部惰性：不调用就不解析 NBT
        n += chunk.blocks ? 1 : 0
      },
      finalize(ctx) {
        return { chunks: n }          // 返回值写入 stats/<ts>/my-stat.json
      },
    }
  },
  format(result) {                  // 可选：控制台摘要，返回若干行
    return [`区块 ${result.chunks}`]
  },
}
```

- `onChunk` 里可以随意组合 `blocks()`（方块 + 方块实体）、`grid()`（含生物群系）、`extent()`（地表高度），同一个 chunk 内结果有缓存。
- `chunk.rawNbt(["structures"])` 读完整区块 NBT：reader 的 `nbt()` 只保留 sections 等白名单根键，structures、Heightmaps 这类字段要用这条通道（`ctx.runtime.serverJar` 指向原版 jar，可读数据包 JSON）。
- `ctx.emit(key, value)` 累积字段，`ctx.log(...)` 输出到控制台，`params` 是配置透传。
- 一个分析器抛错不影响同批其它分析器；错误写进结果文件。

结果目录：

```
stats/2026-11-04T03-12-45-123Z/
  <分析器名>.json
  summary.json
```

## 多版本并存

- 服务端目录按版本隔离：`.server/26.3/`、`.server/26.2/`，各自带 world、mods、config、日志。
- 切版本只需 `--version 26.2`（或改配置），不会污染已有版本的世界与模组。
- 删掉整个 `.server/<version>/` 即可回收该版本的全部产物。
