# 分析器清单

生产分析器（`production/`），`analyze` 默认只跑这些：

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

示例分析器（`examples/`）已载入但不默认跑，要在 `--analyzers` 里写出名字：

- `chunk-index` — 区块数、region 数、坐标范围
- `block-histogram` — 方块 id 直方图（`yMin/yMax/includeAir/top`）
- `surface-profile` — 最高非空气方块高度分布（`bucket`）
- `ore-scan` — 指定方块 id 的计数骨架

产物字段与口径见 [OUTPUTS.md](../../OUTPUTS.md)，编写接口见 [README](../../README.md#写自己的分析器)。
