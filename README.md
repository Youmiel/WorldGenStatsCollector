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
| `analyze` | 遍历存档 region 文件，运行启用的统计器，结果写 `stats/<时间戳>/`。运行时在终端画单行进度（`overworld 128/324 region · 148,213 chunks · 56.3%`），非 TTY（重定向到文件）时不画 |
| `run` | 依次执行 setup、pregen、analyze |
| `info` | 查看当前配置与安装状态 |
| `clean` | 删除统计结果；`--all` 连服务端一起删 |

常用参数：`--version`、`--loader`、`--seed`、`--mem`、`--radius`、`--shape`、`--center`、`--dimension`、`--timeout`、`--analyzers`、`--parallel`、`--all`、`--area`、`--area-shape`、`--no-boot`、`--update-installer`、`--force`、`--verbose`。

`--radius` / `--shape` / `--center` 只改 `--dimension` 指定的那个维度；不写 `--dimension` 则改配置里的全部维度。只写 `--dimension` 而不带范围参数时，表示本次只预生成该维度。

CLI 参数只对本次运行生效，不写回 `worldgen.config.json`；唯一例外是 `--seed`：种子必须落盘才能复现，会写回配置。`--all` 指统计全量范围，`--analyzers all` 指运行全部分析器，两者互不相关。

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
    "levelName": "world", "seed": ""                 // 空 = setup 时生成随机种子并写回，保证可复现
  },
  "mods": {
    "chunky": true, "c2me": true, "fabricApi": true,
    "c2meThreads": 4, "c2mePriority": null                 // null = 不干预 c2me 的 threadPoolPriorityPreset
  },
  "pregen": {
    "dimensions": [                                       // 每个维度一个目标，依次预生成
      { "dimension": "overworld", "shape": "circle", "center": [0, 0], "radius": 256 },
      { "dimension": "the_nether", "shape": "square", "center": [0, 0], "radius": 32 },   // 下界坐标 1:8，取主世界 1/8
      { "dimension": "the_end", "shape": "square", "center": [0, 0], "radius": 256 }
    ]
  },
  "analyze": {
    "range": "pregen",          // pregen = 用预生成记录的范围；all = 全量
    "area": null,               // 显式范围 { shape, center, radius }，优先于 range 且应用于全部维度
    "outDir": "stats",
    "dimensions": ["overworld", "the_nether", "the_end"],   // 要统计的维度，命名空间形式也可（minecraft:overworld）
    "analyzers": [],            // 空 = 只跑生产分析器；all = 全部；也可写名字
    "pluginDir": "analyzers",
    "parallel": 4,              // worker 线程数；0/1 = 串行，默认 4
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

分析器并行（`analyze.parallel` / `--parallel`）：把分析器按代价提示装进 N 个 worker 线程，
默认 **4**。**产物与串行逐字节一致**（各分析器的 `result` 互不依赖），只是墙钟更短。
代价是每个 worker 都要自己解码一遍区块，所以并非越多越好——实测 4 个 worker 最划算：

| 范围 | 串行 | 4 worker | 加速 |
|---|---|---|---|
| r=1024（三维度） | 91.3s | 45.9s | 1.99x |
| r=4096（三维度，31.5 万区块） | 1260s | 597s | 2.11x |

5 个 worker 开始回落（重复解码的代价超过并行收益）。均衡按 `cave-exposure` 的实际耗时
设权重，没有提示的分析器按中位数计；每个 worker 另计一份固定解码开销。
`--parallel 1` 或 `--parallel 0` 退回串行（内存紧张、单核机器上更合适）。

生产分析器（`src/analyze/production/`）：

| 分析器 | 适用维度 | 内容 |
|---|---|---|
| `biome-histogram` | 全部 | 地表与地下两层群系占比（地下每列一票） |
| `biome-patch` | 全部 | 群系斑块规模：连通分量面积、变异系数、边界接触、邻接、地表开放性 |
| `cave-exposure` | 全部 | 指定方块的洞穴空气暴露率：6 面邻居区分洞穴空气、天空空气与水 |
| `entity-census` | 主世界 | 世界生成时放置的实体密度与分群（不含刷怪产物） |
| `lava-lakes` | 主世界 | 地表岩浆湖间距与地下岩浆面积 |
| `ore-stats` | 全部 | 矿石：群系密度 + 空气/水暴露 + 区段分布 |
| `section-block-histogram` | 全部 | 按 16 格区段的方块平均数量与占比 |
| `structure-interior` | 全部 | 结构片段展开：片段频率、真实占地、占地内方块/容器/战利品表/刷怪笼/生物；另含地牢与地形特征地标 |
| `structure-spacing` | 全部 | 结构起点间距（同时给结构集合与变体 id） |

`structure-interior` 从 `structures.starts[id].Children` 展开每个结构实例的全部片段（`BB` 是体素包围盒），
除起点区块外还靠 `structures.References` 反查「本区块参与了哪些实例」——**同一个 `References[id]` 是 ChunkPos 列表，
一个区块可同时被多个同类型实例覆盖**，所以必须遍历全部对；起点在别的 region 时直接读那个 region 文件。
刷怪笼按「方块|怪物」分开（`mob_spawner` 取 `SpawnData.entity.id`，`trial_spawner` 取 config 里的怪物段）。

`BB` 外的方块实体会按距离补归属（实测海洋废墟的可疑方块与箱子会因为贴海床下移而落到包围盒下方 1~7 格）：
距离最近结构 ≤12 格就归给它；刷怪笼的上限更紧（≤4 格，结构不会把刷怪笼放到十几格外），
超出这个范围的结构外刷怪笼就是**地牢（monster room）**的锚点——它 8 格内的容器归入同一间地牢，
结果写在 `dungeons`（间数、每间箱数、按怪物分类），与 `structures` 行同构、可并表。
连就近归属都失败的部分留在 `unassigned`。

容器密度给两个分母，回答两个不同问题：`containersPerStart`（分母 `starts`）是「专程去一处能开几个」，
`containersPerCoveredChunk`（分母 `coveredChunks`）是「游荡撞见时每覆盖一个区块能开几个」。
两者相差「每处平均覆盖区块数」倍：试炼密室 118.05/起 对 3.82/区块，相差 31 倍；
埋藏宝藏这种小结构 1.00/起 对 1.00/区块，两者相等。**不能混用**。
片段 BB 伸出扫描边界的实例，容器只能统计到一部分，它们仍计入 `starts`，
另用 `truncatedStarts` 报出，`containerSampleStarts = starts - truncatedStarts` 是统计完整的实例数。

每个结构行还按**模板路径**分组给出 `templates`（`template` / `count` / `perStart` / `share`），
用于「每实例产出 = Σ_模板 (该模板每实例次数 × 该模板单份内容)」。模板路径有两种存法，实测互不重叠：
拼图类结构（试炼密室、村庄、遗迹小径、堡垒遗迹）在 `pool_element.location`，
模板类结构（冰屋、沉船、海底废墟、废弃传送门）在 `Template`；没有单独的 `TPL` 字段。
矿井、要塞这类**硬编码部件**结构两者都没有，其片段计入 `piecesWithoutTemplate`，
`templates` 为空数组（不是全 0，避免把「口径不适用」误读成「模板真的没出现」）。

可疑方块实体与容器的归属优先看**战利品表**而不是距离：箱子挂哪张表由结构模板与 processor 决定，
是数据事实。海底神殿没有战利品箱，但海洋废墟的箱子可能落在神殿的包围盒内，按距离会算给神殿。
表能对上的，只在该结构的实例里找最近的（`minecraft:ocean_ruin_cold` 按前缀 `ocean_ruin` 命中）；
表被多种结构共用时（`chests/simple_dungeon` 同时是矿井与地牢的箱子）退回就近归属，地牢另由刷怪笼锚点先判。
表对不上任何结构、又是考古表时，就是**地形特征地标**（如沙漠水井），记进 `landmarks`：
`blocks` 是实测可疑方块数，`blocksPerInstance` 读自 jar 的 `worldgen/feature/<id>.json`（数含 `suspicious`
模板的子特征），`count = blocks / blocksPerInstance`。表说明属于某结构、但该结构本范围内没有实例的，
记进 `missingOwnerLoot`，不静默丢弃。

`ore-stats` 的群系归属口径由维度决定：主世界用「地表群系」（该列最高非空气方块处的群系，
与 `biome-histogram` 同口径），下界/末地用「原地群系单元」（矿石自身所在位置的群系，
因为下界群系按 4³ 单元三维分布）。因此下界的矿石密度与暴露率可以直接按群系比较。

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
  dimensions: ["overworld"],   // 可选：适用维度（不写 = 全部）；不适用时记入 unsupported 并写明原因
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
- `dimensions` 声明口径只对某些维度成立时用（例如 `lava-lakes` 的 `yThreshold` 是主世界高度）。不适用的维度不会建实例、`result` 里也不会有该键，只在 `unsupported` 留一条原因；下游看到「键缺失」就读作口径不适用，不会误当成 0。
- `splitByDimension: true` 让产物按维度拆文件（`ore-stats` 与 `structure-interior` 用，单维度内容量大）。开启后主文件只含元信息 + `resultFiles`（维度 → 文件名映射），每个维度另写一个 `<名字>.<维度>.json`，其结构与常规产物完全一致但 `result` 只含那一个维度。维度文件用无缩进的紧凑 JSON（体积翻倍不值得），主文件保留缩进便于人读。
- 一个分析器抛错不影响同批其它分析器：抛错后该维度后续区块不再调用它，其它分析器照常跑。错误写进 `errors`。

运行循环的顺序是「维度 → region → 区块 → 分析器」，不是「分析器 → 区块」。同一个区块只解码一次，
各分析器通过 `ChunkHandle` 的 memo 共用同一份 `grid` / `blocks` / `extent` 结果。
各分析器的累积状态互不影响：`onRegion` 仍在该 region 全部 `onChunk` 之前，`finalize` 仍在该维度
全部 region 跑完之后；产物里的 `durationMs` 只统计该分析器自己花的时间（不含共享的解码）。

结果写在 `stats/<时间戳>/`：

```
<分析器名>.json
summary.json
```

声明了 `splitByDimension` 的分析器额外产出 `<分析器名>.<维度>.json`（如 `ore-stats.overworld.json`），
主文件的 `result` 为空对象，靠 `resultFiles` 找到对应维度文件。

每个 `<分析器名>.json` 的顶层固定为：

- `schemaVersion`：当前为 `2`
- `target`：Minecraft 版本、`levelName`、种子与 `seedMode`、数据包及内容哈希、服务端 jar 哈希
- `range`：统计范围的结构化形式（shape / center / radius / boundChunks / 扫描与跳过区块数 / skippedReason）；多维度时为各维度之和
- `rangeByDimension`：按维度分列的上项，键为 `minecraft:overworld` 这类命名空间形式；被 `dimensions` 排除的维度不会出现在这里
- `appliesToDimensions`：本分析器声明的适用维度；`null` = 未声明，全部适用
- `units`：本分析器数值的单位
- `config`：该分析器的参数
- `ok` / `errors` / `unsupported`：失败的维度与跳过的条目
- `result`：按维度嵌套，键名同上；每个维度用独立的分析器实例

数值字段一律保留原始浮点，不四舍五入——下游可能需要反算或比较；取整只发生在控制台摘要里。

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