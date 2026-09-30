# 洞穴测绘草图编目台（gbcavesurvey）

面向洞穴测绘小组测量记录员的本地化编目台：把「洞段 → 测点方位/倾角/距离读数 → 草图 → 图幅拼合」串成一条可回溯的链路，解决手写记录散落、闭合导线误差看不出来、多张草图拼接对不上桩号的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21814>

常用命令：

```bash
docker compose ps          # 查看容器状态
docker compose logs -f     # 查看日志
docker compose down        # 停止并移除容器（数据在浏览器本地，不受影响）
```

端口与项目名可在 `.env` 中调整：

```
COMPOSE_PROJECT_NAME=gbcavesurvey
FRONTEND_PORT=21814
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（Composition API） |
| 语言 | TypeScript（`vue-tsc` 类型检查零错误） |
| UI 组件库 | Element Plus |
| 状态管理 | Zustand（`zustand/vanilla` createStore + Vue 响应式桥接） |
| 路由 | Vue Router 4（History 模式，nginx `try_files` 回落） |
| 构建 | Vite 6 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21814
npm run build      # 类型检查 + 生产构建
```

> 本地开发无需任何后端服务或环境变量。

## 四、目录结构

```
sologsb-1114/
├── docker-compose.yml          # 顶层 name: gbcavesurvey，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # cave.ts / segment.ts / station.ts / sketch.ts / index.ts
│       ├── stores/             # caveStore / segmentStore / stationStore / sketchStore / notebookStore（Zustand）
│       ├── components/common/  # SegmentTag / BearingInput / ClosureBadge / GridCanvas
│       ├── hooks/              # usePersistentStore / useClosureCheck
│       ├── pages/              # CavesPage / SegmentsPage / StationsPage / SketchPage / MergePage / NotebooksPage
│       ├── router/index.ts
│       └── utils/              # survey.ts / export.ts / id.ts / notebookMerge.ts
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Cave 洞穴 | 归属根节点：洞名、行政区、经纬度、海拔、发育层位、已知总长、负责人等 | `caves` |
| Segment 洞段 | 起止桩号、类型（竖井/廊道/厅堂/裂隙/水道）、平均宽高、是否闭合 | `segments` |
| Station 测点 | 方位角、倾角、斜距 → 自动推算水平距/垂距，累计闭合差；合并时按累计水平距推算桩号 | `stations` |
| Sketch 草图 | 格数、比例、绘制人、拼合顺序号、桩号对齐锚点、拼合偏移 | `sketches` |
| Notebook 外业手记 | 外业离线记录的整批读数：手记编号、归属洞穴、外业测量人、读数行、合并状态（待合并/已合并/失败）、合并批次号 | `notebooks` |
| StationVersion 测点读数版本 | 同一测点的多版读数：来源（外业手记/内业复核）、合并批次、读数、复核人、是否正式成果 | `stationVersions` |

- 数据库名 `gbcavesurvey`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会把旧版测点记录由「斜距 + 倾角」补齐 `horizontalDistance` / `verticalDistance`；
- `version(3)` 新增外业手记与测点版本两张表，并为旧版草图记录补齐 `mergeOffset`；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷，清除浏览器数据即清空。

## 六、外业手记合并规则

外业分队在洞里离线记读数，回驻地后把**一整本**手记合并进编目台（`/notebooks`）：

- **事务化合并，失败回滚**：整本手记在一个 IndexedDB 事务内完成，任一行读数校验失败（方位角/倾角越界、斜距非正、手记内重复桩号、新点桩号超出所属洞段桩号区间）则整体回滚，手记标记为「合并失败」并记录原因，可退回修改后重试，绝不写入半截数据。
- **幂等不重复**：每本手记有唯一合并批次号（`mergeBatch`）。已合并的手记再次合并直接返回上次结果；重试时按「洞段 + 桩号」对齐既有测点，不会堆出重复测点。
- **两版读数都留下，按复核定版**：外业读数与内业已复核记录撞上同一测点时，外业版（`source='field'`）与内业复核版（`source='internal'`）同时留存；正式成果取**复核过的版本**（复核时间取最新），两版均未复核时取最新版本。测点页可打开「版本」对话框对照两版读数，并填写复核人改判正式成果。
- **桩号区间校验**：新落测点按洞段起始桩号 + 洞内累计水平距推算桩号，必须落在所属洞段 `startStake → endStake` 区间内，越界即整本回滚。
- **锚点与拼合偏移一起重算**：合并后重算受影响草图的桩号锚点（取洞段内首个测点桩号），并按锚点桩号差重算图幅拼合横向偏移；手动拖动的偏移也会持久化，重算后自动同步。

## 七、主要页面

| 路由 | 功能 |
| --- | --- |
| `/caves` | 洞穴清单：卡片展示实测/已知总长、洞段数、最近测量日期，支持新建、编辑、归档、删除（删除前校验下级洞段数） |
| `/segments` | 洞段编目表：按桩号区间/类型/洞穴筛选，批量调整洞段类型与闭合标记，自动累计总长 |
| `/stations` | 测点读数录入：方位角/倾角专用输入（度分秒 ⇄ 十进制度），自动推算水平距垂距，实时闭合差徽标，异常读数整行高亮，支持连续录入下一站；「版本」对话框对照同一测点的外业/内业两版读数并复核定版 |
| `/sketch` | 草图工作台：坐标纸网格上绘制测点折线、标注桩号与倾角箭头，支持草图基准方位旋转与草图记录管理 |
| `/merge` | 图幅拼合视图：拖动图幅按相邻边缘吸附、按桩号锚点一键对齐（偏移持久化），输出可调整的拼合顺序表并支持 CSV 导出 |
| `/notebooks` | 外业手记：离线整批录入读数、整本合并（事务回滚/重试/幂等）、合并汇报（双版本冲突留存、桩号校验、锚点与拼合偏移重算） |

## 七、计算约定

- 水平距 = 斜距 × cos(倾角)，垂距 = 斜距 × sin(倾角)；
- 闭合差 f = √(ΣΔE² + ΣΔN²)，默认阈值 0.25 m，超限时徽标变红并可展开计算过程；
- 方位角范围 0°–360°，倾角范围 -90°–90°，越界读数会被标记为异常。
