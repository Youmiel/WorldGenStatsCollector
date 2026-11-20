# 产物字段

每个分析器在 `stats/<时间戳>/` 下写一个 `<analyzer>.json`。本文件说明这些 JSON 的字段与口径，`config` 与 `worldgen.config.json` 一一对应。

## 文件布局

- `<analyzer>.json`：常规产物，`result` 按维度嵌套。
- `<analyzer>.<维度简写>.json`：`splitByDimension: true` 的分析器（`ore-stats`、`structure-interior`）按维度拆出的文件。
  - 主文件 `result` 为空对象，`resultFiles` 给「维度 → 文件名」映射。
  - 维度文件结构与常规产物一致，`result` 只有那一个维度。
  - 维度文件写紧凑 JSON，主文件保留缩进。
- `summary.json`：本次运行的元信息与分析器清单。
- `README.md`：本文件的副本，随产物一起交付；各分析器用 `fieldDoc` 指向它。
- `*.png`：可视化图，由对应分析器在 `result.<维度>.visual` 里登记。

## 通用外层字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `analyzer` | string | 分析器名，与文件名同名 |
| `description` | string | 分析器的一句话职责 |
| `schemaVersion` | number | 结果形状版本，当前为 `2`；不兼容变化时递增 |
| `generatedAt` | string | 生成时间，ISO 8601 |
| `target` | object | 这批数据来自哪个地形包与世界，见下 |
| `range` | object | 本次统计范围，各维度汇总 |
| `rangeByDimension` | object | 维度 → 范围明细，键为命名空间维度 ID |
| `appliesToDimensions` | string[] | 分析器实际执行的维度 |
| `units` | object | 字段名 → 单位，用于消除 `perChunk` 一类名字的分母歧义 |
| `config` | object | 本次生效的分析器参数 |
| `fieldDoc` | string | 同目录下的字段说明文件名；源文档缺失时字段整个缺席 |
| `ok` | boolean | 分析器是否正常跑完 |
| `errors` | string[] | 非致命错误；`ok: false` 时看这里 |
| `unsupported` | object[] | 被跳过的对象，`{ item, reason }`，不静默跳过 |
| `durationMs` | number | 该分析器自身耗时 |
| `result` | object | 维度 → 结果；`splitByDimension` 时主文件为空 |
| `resultFiles` | object | `splitByDimension` 时的维度 → 文件映射 |

### target

| 字段 | 含义 |
|---|---|
| `minecraftVersion` | 游戏版本 |
| `levelName` | 存档目录名 |
| `loader` | `fabric` 或 `null` |
| `seed` | 实际种子，字符串（超出 2^53 时不丢精度） |
| `seedMode` | `explicit`（配置给了）/ `random`（服务端随机，已写回 `server.properties`） |
| `dataPacks[]` | 地形包：`id`、`source`（`world` / `root`）、`enabled`、`sha256`（目录树逐文件哈希后汇总） |
| `serverJarSha256` | 服务端 jar 哈希；读不到为 `null` |

### range 与 rangeByDimension

| 字段 | 含义 |
|---|---|
| `shape` | `circle` / `square` / `all` |
| `center` | 中心区块坐标 `[x, z]`，全量时为 `null` |
| `radius` | 半径（方块），全量时为 `null` |
| `boundChunks` | 覆盖的区块边界 `{ x: [min, max], z: [min, max] }`，全量时为 `null` |
| `chunksScanned` | 范围内区块数（含空区块） |
| `chunksEmpty` | 范围内 `extent()` 为空、没有方块的区块数 |
| `chunksWithBlocks` | 实际参与统计的区块数，各项 `perChunk` 的分母 |
| `chunksSkipped` | world 内存在、但落在范围外的区块数 |
| `skippedReason` | `chunksSkipped` 的含义；为 0 或全量时为 `null` |

## summary.json

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 同上 |
| `generatedAt` | 运行结束时间 |
| `target` | 同通用外层 |
| `world` | 存档目录绝对路径 |
| `dimensions` | 本次运行的维度 ID 列表 |
| `range` / `rangeByDimension` | 同通用外层 |
| `fieldDoc` | 字段说明文件名，或 `null`（源文档缺失） |
| `analyzers[]` | `{ name, ok, durationMs }` |

## biome-histogram

群系面积占比，按列统计。

| 字段 | 含义 |
|---|---|
| `chunks` | 扫描区块数 |
| `columns` | 参与统计的列数，即各 `share` 的分母 |
| `surface.uniqueBiomes` | 地表群系种类数 |
| `surface.biomes[]` | `{ id, cells, share }`；`share` 为百分比 |
| `underground.dimensions` | 参与地下口径的维度 |
| `underground.unit` | 地下统计单元，`column (4x4x4 cell scan)` |
| `underground.columns` | 参与地下统计的列数 |
| `underground.differing` | 地下群系与地表不同的列数 |
| `underground.sameAsSurface` | `{ columns, share }`，与地表一致的部分 |
| `underground.uniqueBiomes` / `.biomes[]` | 地下群系种类与分布，字段同 `surface` |

地表群系取该列最高非空气方块处的群系，与 `ore-stats`（主世界）、`biome-patch` 同口径。

## biome-patch

群系斑块规模与邻接，一维网格上的 4 连通分量。

| 字段 | 含义 |
|---|---|
| `columns` | 参与统计的总列数，一列 = 1 方块² |
| `boundaryColumns` | 相邻列群系不同的列数 |
| `top` | `biomes[]` 截取条数 |
| `biomes[].id` / `.columns` | 群系与列数 |
| `biomes[].areaFraction` | 占 `columns` 的比例 |
| `biomes[].patches.count` | 连通斑块数 |
| `biomes[].patches.meanAreaBlocks` / `.medianAreaBlocks` / `.maxAreaBlocks` | 斑块面积（方块²） |
| `biomes[].patches.areaVariance` | 变异系数平方 `var / mean²`，跨群系可比 |
| `biomes[].patches.edgeTouchCount` | 触及扫描边界的斑块数；这些斑块实际更大，会压低 `meanAreaBlocks` |
| `biomes[].openSurfaceShare` | 该群系列中地表上方为空气且非水的比例 |
| `biomes[].neighbors` | 边界列上相邻群系 → 占比 |

## cave-exposure

按方块类型统计暴露情况，6 面邻居判定，洞穴空气与天空空气分开。

| 字段 | 含义 |
|---|---|
| `chunks` / `minSamples` | 扫描区块数 / `reliable` 的样本阈值 |
| `blockPatterns` | 目标方块匹配模式 |
| `targetBlocks` | 命中的方块总数 |
| `heightmapChunks` | 用地形高度图判天空的区块数 |
| `scannedChunks` | 高度图缺失、退回全列扫描的区块数 |
| `blocks[].id` / `.count` / `.avgPerChunk` | 方块与数量，分母是 `chunks` |
| `blocks[].caveAirExposed` / `.caveAirPct` | 至少一面贴洞穴空气的方块数及占比 |
| `blocks[].skyAirExposed` / `.skyAirPct` | 至少一面贴天空空气 |
| `blocks[].bothAir` / `.bothAirPct` | 同时贴洞穴空气与天空空气 |
| `blocks[].airExposed` / `.airPct` | 至少一面贴空气（含两类重叠） |
| `blocks[].caveShareOfAirPct` | `caveAirExposed / airExposed`，分母是贴空气的方块数 |
| `blocks[].waterExposed` / `.waterPct` | 至少一面贴水 |
| `blocks[].buried` / `.buriedPct` | 完全被包住 |
| `blocks[].unknownEdge` / `.unknownPct` | 无空气无水、但有邻块读不到；不计入 `buried` |
| `blocks[].reliable` | `count >= minSamples` |

百分比的分母是 `count`。只列实际出现的方块，某模式在该维度没命中就不成行。

## entity-census

世界生成时放置的被动实体，不含刷怪产物。

| 字段 | 含义 |
|---|---|
| `chunks` / `entities` / `chunksWithEntities` | 扫描区块数 / 实体数 / 有实体的区块数 |
| `perChunk` / `chunksPer` | 每区块平均与倒数 |
| `perLoadedChunk` | 每有实体区块的平均 |
| `skippedNonLiving` | 排除的非生物实体数 |
| `clustering` | `{ radius, height, unit }`：同种实体水平距离 ≤ `radius` 且垂直 ≤ `height` 连成一群 |
| `animals` | 被动生物汇总：`count`、`perChunk`、`chunksPer`、`uniqueTypes`、`groups`、`groupsPerChunk`、`chunksPerGroup`、`avgGroupSize`，按 `land` / `water` 再分一层 |
| `byCategory` | `land` / `water` → `count`、`perChunk`、`chunksPer`、`types`、`group{ groups, perChunk, chunksPer, avgSize }` |
| `byType` | 实体 ID → `category`、`count`、`perChunk`、`chunksPer`、`avgY`、`group{ groups, perChunk, chunksPer, avgSize, singletons, maxSize }` |
| `totalGroups` | 全部群数 |

## lava-lakes

岩浆湖连通分量与分布。

| 字段 | 含义 |
|---|---|
| `chunks` / `lavaBlocks` | 扫描区块数 / 岩浆方块总数 |
| `yThreshold` / `minY` | 地表/地下的分界高度与扫描下界 |
| `minLakeSize` / `mergeGap` | 最小湖面积 / 合并间距 |
| `surface` | `yRange`、`clusters`（连通分量数）、`lakes`（达标湖数）、`discarded`（不够大）、`lakeBlocks`、`avgLakeSize` |
| `underground` | `yRange`、`lavaBlocks`、`chunksWithLava`、`avgBlocksPerChunk`、`avgAreaPerChunk`、`areaSharePct` |
| `surface.spacingTerrainFilter` | 地形连通过滤的诊断：`enabled`、`rejectedPairs`（被水域/陡坡挡掉的候选对数）、`isolatedGroups`、`maxBlockedRun`、`pathStep`（连线采样步长）、`slopeCacheFlushes`（坡度缓存被清空次数，非 0 表示采样量已撞到容量保护） |
| `visual` | `file`、`scale`、`width`、`height` |

## ore-stats

群系级资源方块密度与暴露。主世界按下表地表群系归属，下界按方块所在位置的群系单元归属。

| 字段 | 含义 |
|---|---|
| `biomeBasis` | `surface`（按地表群系）/ `in-situ`（按方块所在群系单元） |
| `chunks` / `minChunks` / `minOreSamples` | 扫描区块数 / 密度采信阈值 / 暴露率采信阈值 |
| `top` | 每类保留条数 |
| `exposureBlockList` / `bulkBlockList` | 两类方块的统计名单 |
| `exposureBlocks` / `bulkBlocks` | 两类命中方块数 |
| `scannedSolid` | `in-situ` 口径的非空气方块总数（`volumeFraction` 的分母） |
| `totalColumns` | `surface` 口径的总列数（`areaFraction` 的分母） |
| `blocksWithoutBiome` | `in-situ` 口径下取不到群系的方块数 |
| `reliableBiomes` | `reliable` 为真的群系数 |
| `biomes[].id` / `.chunks` / `.reliable` | 群系及其区块数，`reliable = chunks >= minChunks` |
| `biomes[].chunkEquivalent` | 等效区块数，`avgPerChunk` 的分母。`surface` 为 `列数 / 256`，`in-situ` 为 `非空气方块数 / 每区块平均非空气方块数` |
| `biomes[].columns` / `.areaFraction` | `surface` 口径的列数与占比 |
| `biomes[].solidBlocks` / `.volumeFraction` | `in-situ` 口径的方块数与占比 |
| `biomes[].exposure[id]` | 暴露类：`count`、`avgPerChunk`、`airExposed`、`avgAirExposed`、`waterExposed`、`avgWaterExposed`、`both`、`buried`、`avgBuried`、`unknownEdge`、`airPct`、`waterPct`、`reliableExposure` |
| `biomes[].bulk[id]` | 数量类：`count`、`avgPerChunk` |
| `biomes[].families` | 暴露类按家族合并 `deepslate_` 前缀，字段同 `exposure` |
| `biomes[].sections[]` | `yRange`、`blocks`、`exposure[id]{ count, avgPerChunk, share, airPct }`、`bulk[id]{ count, avgPerChunk, share }`；同群系各区段 `count` 相加等于顶层同种数量 |
| `sectionProfiles[id]` | 全维度纵深分布：`kind`（`exposure` / `bulk`）、`count`、`sections[]{ yRange, count, share, airExposed, buried, unknownEdge, airPct }` |

不可靠群系只列非零条目，可靠群系列出全部；同一方块不会同时进两类，重复时以 `exposure` 为准。

## section-block-histogram

按 16 格区段统计方块构成。

| 字段 | 含义 |
|---|---|
| `chunks` / `avgBlocksPerChunk` | 扫描区块数 / 每区块平均非空气方块数 |
| `includeAir` | 是否把空气计入 |
| `top` | 每区段保留的方块条数 |
| `sections[].y` / `.yRange` | 区段起始高度与闭区间 `[y, y+15]` |
| `sections[].chunks` | 该区段的区块数 |
| `sections[].avgTotal` | 每区块该区段平均方块数，除以 4096 即实心占比 |
| `sections[].blocks[]` | `{ id, avg, share }`；`avg` 的分母是该区段的 `chunks` |

## structure-interior

按结构起点展开片段，统计占地内的方块、容器、战利品表、刷怪笼与生物。

| 字段 | 含义 |
|---|---|
| `chunks` | 涉及结构的区块数 |
| `scannedChunks` | 有地形的区块数（`extent` 非空）；piece 级密度与地标密度的分母，与 `structure-spacing.chunks` 同口径 |
| `structures[].structure` / `.set` | 结构变体 ID 与所属结构集合 |
| `structures[].starts` / `.pieces` / `.piecesPerStart` | 实例数 / 片段数 / 每实例片段数 |
| `structures[].pieceKinds[]` | `{ piece, count, instances, perStart, share, perCoveredChunk, densityPer1000Chunks }`；`instances` 是含该 piece 的实例数，`densityPer1000Chunks` 的分母是 `scannedChunks` |
| `structures[].templates[]` | `{ template, count, instances, perStart, share, perCoveredChunk, densityPer1000Chunks }`；硬编码部件结构为空数组 |
| `structures[].piecesWithoutTemplate` | 没有模板路径的片段数（矿井、要塞这类硬编码部件） |
| `structures[].coveredChunks` | 被该结构覆盖的区块数，`containersPerCoveredChunk` 的分母 |
| `structures[].volume` / `.volumePerStart` | BB 并集内的方体数（重叠片段只计一次） |
| `structures[].blockTotal` / `.blockKinds` / `.blocks` | 方块总数 / 种类数 / 截断到 `topBlocks` 的明细 |
| `structures[].blocksTruncated` | 被截掉的方块种类数 |
| `structures[].containers` / `.containerTotal` | 容器按类型计数 / 总数 |
| `structures[].containersPerStart` | 专程口径：每处该结构平均容器数，分母 `starts`。`starts = 0` 时为 `null` |
| `structures[].containersPerCoveredChunk` | 游荡口径：每覆盖区块平均容器数，分母 `coveredChunks` |
| `structures[].truncatedStarts` | 片段 BB 伸出扫描边界的实例数；这些实例的容器只统计到一部分 |
| `structures[].containerSampleStarts` | `starts - truncatedStarts`，容器统计完整的实例数 |
| `structures[].lootTables` / `.spawners` / `.entities` | 战利品表、刷怪笼（`方块|怪物` 为键）、生物计数 |
| `structures[].spawnerCaps` | 刷怪笼的「上限」参数：`方块|怪物 → { samples, maxNearbyEntities, spawnCount, spawnRange }`，每项是实测 `{min,max}` 区间；`trial_spawner` 没有这些数字，不出现在这里 |
| `structures[].entitiesPerStart` | 每处该结构里已生成好的实体数（分母 `starts`），与 `spawners` 的 `..._per_start` 同口径 |
| `structures[].spawnedPerStart` | **结构生成时由代码放出来、扫不到的实体**：`实体 → 每处只数`。只有定义里存在这类实体的结构才有这个键（当前只有海底神殿的远古守卫者 = 3 只/处，出自 `OceanMonumentPieces` 的 3 处 `spawnElder`）。与 `entities` 分开：那是实测扫描值，这是结构定义里的固定数量。**准入条件：数量必须是结构级常量**——海洋废墟的溺尸同属「代码生成、扫不到」，但数量由模板里的 `drowned` marker 个数决定（每模板 1~5 个，且与 `chest` marker 混在一起，`template_blocks.jsonl` 不带 marker id），无法写死，故不收录 |
| `structures[].spawnedTotal` | 上式 × `starts`，即本范围内这类实体的总数 |
| `structures[].entitiesPerStartCombined` | 实测 `entitiesPerStart` 与 `spawnedPerStart` 取**较大值**合并（同一 id 不重复相加，避免把同一批生物数两遍） |
| `structures[].source` | `structure`（默认）或 `feature`；`feature` 行是没有 `structures.starts` 的地形特征（沙漠水井） |
| `dungeons` | 地牢（非 jigsaw 结构）：`count`、`containers`、`containersPerDungeon`、`byKind`、`containerTypes`、`lootTables`、`avgVolume` |
| `dungeons.byDepth` | 按锚点高度拆分：`shallow`（y ≥ 0，`monster_room`）与 `deep`（y < 0，`monster_room_deep`），各自结构同 `dungeons`；两组 `count` 相加等于顶层 `count` |
| `dungeons.avgVolume` | 每间地牢的占地体积。地牢没有片段 BB，扫不到房间边界，恒为 `null`（口径适用但未测） |
| `unassigned` | 就近归属也失败的容器/战利品表/刷怪笼 |
| `missingOwnerLoot` | 战利品表说明属于某结构、但该结构在本范围内没有实例的方块数（通常意味着范围没覆盖到那座结构） |
| `landmarks[]` | 地形特征类地标（无 start、无 BB），见下 |
| `totals` | 各结构汇总：`structures`、`starts`、`pieces`、`volume` |

`landmarks[]` 的字段：

| 字段 | 含义 |
|---|---|
| `id` | 地标 ID，如 `minecraft:desert_well` |
| `set` | 结构集合 ID，如 `minecraft:desert_wells`（与下游 `template_prefixes` 对齐） |
| `blocks` | 实测到的可疑方块数 |
| `blocksPerInstance` | 每个实例含几个可疑方块，读自 jar 的 `worldgen/feature/<id>.json`；读不到用 `blocks / count` |
| `count` | 实例数：可疑方块按 `LANDMARK_CLUSTER_RADIUS`（当前 8 格）聚类后的组数（实测） |
| `blocksPerStart` / `containersPerStart` | 每处平均可疑方块数 / 容器数（分母 `count`）；沙漠水井容器为 0 |
| `containers` | 该地标的容器计数（沙漠水井为空对象） |
| `densityPer1000Chunks` | 每 1000 个有地形区块的实例数，与结构集合级同口径 |
| `nearest` | 实例中心之间的最近邻分布：`meanNNBlocks` / `medianNNBlocks` / `quantiles` / `varianceNN` / `minNNBlocks` / `maxNNBlocks` / `reliable` / `densityPer1000Chunks` |
| `blocksPerChunk` | 每区块平均可疑方块数，分母为有地形区块数 |
| `blockTypes` / `lootTables` | 方块类型与战利品表计数 |

地标不写 `structures.starts`、没有片段 BB，只能靠可疑方块实体上的 `archaeology/*` 战利品表识别。
**同一批数据也会以一条 `structures[]` 行写出**（`source = "feature"`），字段与普通结构一致：
`starts` 是聚类实例数、`blocks` 是可疑方块数、`containers` 是容器数、`nearest` 是实例中心的最近邻分布。
这样下游的 `structure_content` 不用为地标单开一条读取路径。

容器与战利品表的归属顺序：

1. 地牢锚点 8 格内 → 归地牢（`chests/simple_dungeon` 与矿井共用，必须先判地牢）
2. 战利品表能对应到某种结构 → 在该结构的实例里取最近的，不因别的结构更近而算错
3. 表未收录或被多种结构共用 → 退回 12 格内最近结构
4. 仍无归属 → `unassigned`；若表指向的结构本范围内没有实例 → `missingOwnerLoot`

关键是第 2 步：表由结构模板与 processor 决定，是数据事实。海底神殿没有战利品箱，
而海洋废墟的箱子可能落在神殿的包围盒内，按距离会把这些箱子算给神殿。

容器两种分母回答不同问题：`containersPerStart` 是「专程去一处能开几个」，`containersPerCoveredChunk` 是「游荡撞见时每区块能开几个」。两者相差每处平均覆盖区块数倍，大结构可达 30 倍，不可混用。

## structure-spacing

结构集合内最近邻间距。

| 字段 | 含义 |
|---|---|
| `chunks` / `structureStarts` | 扫描区块数 / 结构起点总数 |
| `groups[].set` / `.dimension` / `.count` / `.setKnown` | 结构集合、维度、起点数、能否在服务端 jar 里找到该集合 |
| `groups[].structureIds[]` | 集合内的变体 |
| `groups[].meanNNBlocks` / `.meanNNChunks` | 每个起点到最近同集合起点的距离均值 |
| `groups[].medianNNBlocks` / `.medianNNChunks` | 中位数 |
| `groups[].quantiles` | `{ p25, p50, p75, p90 }`，同一批最近邻距离的分位数（方块，线性插值）。`p50` 恒等于 `medianNNBlocks`；有序样本下必然 `p25 ≤ p50 ≤ p75 ≤ p90` |
| `groups[].varianceNN` | 最近邻距离的样本方差（方块²，除以 `n-1`） |
| `groups[].minNNBlocks` / `.maxNNBlocks` | 极值；`maxNNBlocks` 是实测最大值，恒 `≥ p90` |
| `groups[].reliable` | 分位数/方差是否可采信：最近邻样本数 `≥ minQuantileSamples`（当前 10）。为 `false` 时 `quantiles.*` 与 `varianceNN` 都是 `null`，不写 0 |
| `groups[].trimmed` | `{ count, meanNNBlocks, meanNNChunks }`，去掉边界附近起点后的均值；范围受限时更接近真实间距 |
| `groups[].configured` | `{ spacingChunks, separationChunks }`，来自结构集合定义 |
| `groups[].densityPer1000Chunks` | 每 1000 个有地形区块的实例数；游荡撞见口径 |
| `groups[].source` | `structure`（默认）或 `feature`；`feature` 行是没有 `structures.starts` 的地形特征（沙漠水井），由可疑方块的考古战利品表聚类成实例 |
| `groups[].sampleBlocks` | 仅 `source = "feature"`：聚类用的可疑方块数 |
| `landmarkInstances` | 地形特征实例总数（不在 `structureStarts` 里） |
| `minQuantileSamples` | 分位数/方差所需的最小最近邻样本数，与 `reliable` 的判据一致 |

均值、中位数、极值在样本极少时（`count ≥ 2`）仍给出实测值，供兜底参考；分位数与方差样本不足时整批置 `null`。

## 通用口径

- 缺失值写 `null`，字段缺失表示该口径不适用；两者都不等于 `0`。只有真测到 0 才写 `0`。
- 样本不足时给 `reliable: false`，同时保留实测数值，不替换成 0。
- 每个比率的分母写在 `note` 或 `units` 里；跨字段混用同一名字时（如两种容器分母）以 `note` 为准。
- 维度 ID、群系 ID、方块 ID、结构 ID 均为命名空间形式。
- 浮点保留原值，采集侧不做四舍五入。
- 同参数重跑，产物逐字节一致（`generatedAt` 除外）。
