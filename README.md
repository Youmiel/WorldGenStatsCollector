# WorldGenStatsCollector

Minecraft 世界生成统计工具：自动装配指定版本的 Fabric 服务端，用 Chunky + c2me 预生成区块，再用 minecraft-block-reader 解析存档并运行统计插件。

## 快速开始

```bash
npm install
npm run build

node dist/cli.js setup    # 安装服务端 + 模组 + 配置，并首启验证
node dist/cli.js pregen   # 预生成
node dist/cli.js analyze  # 统计生产分析器（默认用预生成记录的范围）
node dist/cli.js analyze --all       # 统计全量范围
node dist/cli.js analyze --area 0,0,512 --area-shape square
# 或者一步到位
node dist/cli.js run --radius 512
```

## 命令

| 命令 | 作用 |
|---|---|
| `setup` | 检查/下载 fabric-installer，安装指定 MC 版本的服务端与 fabric-api / chunky / c2me，写 `server.properties`、`eula.txt`，首启生成并调整 c2me、chunky 配置 |
| `pregen` | 启动服务端，用 Chunky 按配置的 center/shape/radius 预生成，解析进度，完成后 `stop` |
| `analyze` | 遍历存档 region 文件，运行启用的统计器，结果写 `stats/<时间戳>/` |
| `run` | 依次执行 setup、pregen、analyze |
| `info` | 查看当前配置与安装状态 |
| `clean` | 删除统计结果；`--all` 连服务端一起删 |

常用参数：`--version`、`--loader`、`--seed`、`--mem`、`--radius`、`--shape`、`--center`、`--dimension`、`--timeout`、`--analyzers`、`--all`、`--area`、`--area-shape`、`--no-boot`、`--update-installer`、`--force`、`--verbose`。

CLI 参数只对本次运行生效，不写回 `worldgen.config.json`；要长期改配置请直接改文件。`--all` 指统计全量范围，`--analyzers all` 指运行全部分析器，两者互不相关。

`server.dir` 支持 `{version}` 占位符，默认 `.server/{version}`，即每个 MC 版本一个独立服务端目录（world / mods / config 全隔离）；`--server-dir` 指定字面路径，同样支持占位符。

## 配置 `worldgen.config.json`

首次运行自动生成，之后手动编辑。**这个文件属于本机配置，不进版本库**（`.gitignore` 已包含）：`javaPath` 通常是本机 JDK 的绝对路径，对别人没意义，也不该出现在提交里。仓库里跟踪的是模板 `worldgen.config.example.json`，字段与默认值一致，需要查字段时看它。

`javaPath` 留 `null` 就走 PATH 里的 `java`；只有 PATH 上的 java 版本不对（比如系统装的是 JDK 11，跑不了 26.x）时才需要填绝对路径。

```jsonc
{
  "minecraft": { "version": "26.3", "loader": null },   // null = installer 的 latest
  "server": {
    "dir": ".server/{version}", "memoryMB": 2048,
    "javaPath": null,                                     // null = 用 PATH 里的 java
    "levelName": "world", "seed": ""
  },
  "mods": {
    "chunky": true, "c2me": true, "fabricApi": true,
    "c2meThreads": 4, "c2mePriority": null                 // null = 不干预 c2me 的 threadPoolPriorityPreset
  },
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

统计逻辑与主程序解耦。分为三类：

- 生产分析器 `src/analyze/production/` — 编译后从 `dist/analyze/production/` 自动发现，`analyze` 默认只跑这些
- 示例分析器 `src/analyze/examples/` — 已载入但不默认跑，要在 `--analyzers` 里写出名字，如 `--analyzers chunk-index,block-histogram`
- 外部分析器 `analyzers/*.js` — 同样已载入但不默认跑，需点名；不经编译，改完直接生效

三类分析器都按目录发现、共用同一个加载器（模块导出 `{ name, create }`），同名时外部插件覆盖内置，可临时替换某个统计的实现。指定 `--analyzers all` 可一次性运行全部三类，指定 `--analyzers examples` 只跑示例。

示例分析器（`src/analyze/examples/`）：

- `chunk-index` — 区块数、region 数、坐标范围
- `block-histogram` — 方块 id 直方图（`yMin/yMax/includeAir/top`）
- `surface-profile` — 最高非空气方块高度分布（`bucket`）
- `ore-scan` — 指定方块 id 的计数骨架

### 写自己的分析器

`src/analyze/examples/ore-scan.ts` 是最小骨架，接口与外部分析器完全一致：放（或新建）到 `src/analyze/production/` 并 `npm run build` 即是生产分析器，无需注册；抄成 `.js` 丢进 `analyzers/` 则作为外部分析器，用 `--analyzers` 点名。

外部分析器是一个 ESM 模块，默认导出一个对象：

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
        // chunk: { ref, x, z, nbt(), blocks(opts), grid(opts), extent(opts), entities() }
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

- `onChunk` 里可以随意组合 `blocks()`（方块 + 方块实体）、`grid()`（含生物群系）、`extent()`（地表高度）、`entities()`（实体），同一个 chunk 内结果有缓存。
- `chunk.entities()` 读的是 `<dim>/entities/r.x.z.mca`（1.17+ 实体不在区块里），读不到再退回区块 NBT 的 `entities` 根键。它不会调用 `blocks()`，所以只统计实体时开销很小（实体文件平均百 KB 级，按 region 懒读一次）。
- `chunk.rawNbt(["structures"])` 读完整区块 NBT：reader 的 `nbt()` 只保留 sections 等白名单根键，structures、Heightmaps 这类字段要用这条通道（`ctx.runtime.serverJar` 指向原版 jar，可读数据包 JSON）。
- `ctx.emit(key, value)` 累积字段，`ctx.log(...)` 输出到控制台，`params` 是配置透传。
- 一个分析器抛错不影响同批其它分析器；错误写进结果文件。

结果写在 `stats/<时间戳>/`：

```
<分析器名>.json
summary.json
```

## 多版本并存

- 服务端目录按版本隔离：`.server/26.3/`、`.server/26.2/`，各自带 world、mods、config、日志；切版本只需 `--version 26.2`，不会污染已有版本。
- 删掉整个 `.server/<version>/` 即可回收该版本的全部产物。

## 旧版本（1.16 / 1.17）：自定义世界生成数据包

1.16 / 1.17 的服务端在首次创建世界时就把世界生成设置固定进 `level.dat`，之后改数据包不会影响已生成的内容。用世界生成数据包时必须按下面的顺序手工操作：

1. 先把数据包放进服务端目录（服务端根目录的 `datapacks/`，或世界目录下的 `datapacks/`）。
2. 带数据包启动一次服务端，让它完成首次世界创建。`setup` 的首启正好是这一步；如果用了 `--no-boot`，需要自己起一次。
3. 停服，清掉世界里的区块数据：
   - `<levelName>/region`、`<levelName>/poi`、`<levelName>/entities`
   - 下界 / 末地的 `DIM-1`、`DIM1` 目录（1.16 / 1.17 是这种旧布局，目录里同样有 region / poi / entities）
   - `level.dat` 不在清理范围
4. 再启动服务端，区块按数据包重新生成，此时才能开始 `pregen`。

这段清理工具不会自动执行：1.16 / 1.17 已超出主线支持范围，为老版本加分支不划算，所以只作为使用说明记录在这里。`<levelName>` 即 `server.levelName`，默认 `world`。