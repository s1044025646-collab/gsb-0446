# NMEA 定位语句校验与同秒观测配对后端

离线 NMEA 0183 文本观测检查服务。仅支持 **GGA** 与 **RMC** 两种语句，提供 HTTP API 与 CLI，数据保存于 SQLite。不连接串口、真实定位设备、地图或天气服务，不计算卫星轨道或融合滤波。

## 运行环境

- Windows 本地，Node.js >= 22（使用内置 `node:sqlite`，无需原生编译、Docker 或 WSL）
- 安装依赖：`npm install`

## 常用命令

```powershell
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部单元测试
npm start         # 启动 API 服务（默认自动选择空闲端口）
npm run demo      # 运行内置演示（同秒配对、多来源、无效状态、坐标冲突）
```

CLI 直接用法（数据库默认 `./data/nmea.db`，可用 `--db` 或环境变量 `NMEA_DB` 指定）：

```powershell
node dist/src/cli.js serve --port 8080        # 指定端口；省略则选空闲端口
node dist/src/cli.js new --name 我的日志集
node dist/src/cli.js import --dataset 1 --file samples/demo.log --request-id req-1 --source receiver-A --date 1994-03-23
node dist/src/cli.js lines --dataset 1        # 逐行诊断
node dist/src/cli.js pairs --dataset 1 --tolerance 0.0001
node dist/src/cli.js report --dataset 1 --tolerance 0.0001   # 冻结新报告
node dist/src/cli.js export --report 1 --out report.json     # JSON 导出
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与规则版本 |
| POST | `/api/datasets` | 新建日志集 `{name}` |
| GET | `/api/datasets` | 列出日志集 |
| POST | `/api/datasets/:id/imports` | 导入 `{requestId, source, utcDate?, text}` |
| GET | `/api/datasets/:id/lines` | 逐行诊断（含原行号与原文本） |
| GET | `/api/datasets/:id/pairs?toleranceDeg=&source=&date=&second=` | 按秒查看配对 |
| POST | `/api/datasets/:id/reports` | 以 `{toleranceDeg}` 生成并冻结新报告 |
| GET | `/api/reports/:id` | 读取冻结报告 |
| GET | `/api/reports/:id/export` | JSON 导出 |

错误统一返回 `{error: {code, message}}`，如 `BAD_DATE`、`DATASET_NOT_FOUND`、`BAD_TOLERANCE`、`TOO_MANY_LINES` 等。

## 核心约定

### 语句与校验

- 行格式 `$正文*HH`，行尾仅允许 CRLF 或 LF，不修复正文。
- 校验和：`$` 之后、`*` 之前所有 ASCII 字节（含逗号）逐字节异或；`HH` 为两个十六进制字符，大小写均可。
- 诊断码：`MISSING_STAR`、`BAD_CHECKSUM_CHAR`、`CHECKSUM_MISMATCH`、`NON_ASCII`、`INSUFFICIENT_FIELDS`、`UNKNOWN_TYPE`、`BAD_TIME`、`LEAP_SECOND`、`BAD_DATE`、`BAD_COORD`、`BAD_HEMISPHERE`、`BAD_QUALITY`、`BAD_STATUS`、`BAD_SPEED`、`INCONSISTENT`、`MISSING_DATE`、`LINE_TOO_LONG`。校验失败的行不参与配对，但保留原行号与原文本。

### 时间与日期

- 时间 `hhmmss[.fff]`；**配对秒键取整数秒**，小数仅用于展示，不进位。
- 拒绝闰秒 60 与不存在的日期。
- RMC 自带 `ddmmyy`：年份 00–79 → 2000–2079，80–99 → 1980–1999。
- **GGA 必须由导入参数显式提供 `utcDate`（YYYY-MM-DD）**，不从相邻行猜测；含 GGA 而未提供日期的批次整体拒绝。跨午夜日志请按日期分批导入。

### 坐标与速度

- 纬度 `ddmm.mmmm`、经度 `dddmm.mmmm`，分钟 < 60；纬度 90 / 经度 180 仅允许零分钟；结合 N/S/E/W 得带符号十进制度，存储精度 7 位小数。
- 例：`4807.038,N` → `48.1173`；`01131.000,E` → `11.5166667`。
- GGA 质量 0 与 RMC 状态 V 表示无效定位；无效时坐标可保留为空（不会变成 0），有效状态缺坐标报 `INCONSISTENT`。
- RMC 速度单位为节，换算米每秒常数 `KNOT_TO_MPS = 0.514444`（1 节 = 1852 m / 3600 s）。

### 配对规则

- 配对键：**来源 + UTC 日期 + 整数秒**。来源仅来自导入参数 `source`，绝不从 GP/GN 等 talker 标记推断；不同来源、不同日期绝不串用。
- 同键同类型多条：完全相同的原句去重并记录出现次数；不同原句标为 `CONFLICT`，不随意挑选。
- 仅当 GGA 与 RMC 两侧各有一个无冲突候选时才配对；单边缺失为 `UNPAIRED`。
- 配对结果保留两份坐标，按可配置角度容差（度）判断 `coordConsistent`，不平均、不掩盖冲突。
- 状态：`PAIRED_VALID`（双方定位有效且坐标一致）、`PAIRED_INVALID_FIX`、`PAIRED_COORD_MISMATCH`、`UNPAIRED`、`CONFLICT`。
- 日志顺序变化不影响分组结论。

### 存储与幂等

- SQLite 保存原文、来源、显式日期、规则版本（`RULES_VERSION`）与冻结报告。
- 导入请求携带 `requestId`，同一日志集内重复请求号直接返回首次结果，不重复计数。
- 批次结构非法（参数错误、孤立 CR、超上限、含 GGA 缺日期）整批拒绝且不写半份；结构合法时坏语句按逐行失败保留。
- 上限：行长 512、单批 100000 行、坐标 7 位小数（见 `src/nmea.ts` 常量）。

## 项目结构

- `src/nmea.ts` 严格解析与校验和
- `src/pairing.ts` 分组、去重、冲突与配对
- `src/store.ts` SQLite 持久化与导入事务
- `src/server.ts` HTTP API
- `src/cli.ts` 命令行与内置演示
- `test/` 单元测试（`api.smoke.js` 为 API 冒烟脚本）
- `samples/demo.log` 项目内样例

## 已知限制

- `node:sqlite` 在 Node 25 仍标记为实验特性，启动时有 ExperimentalWarning，不影响功能。
- 仅支持 GGA/RMC；RMC 导航状态（第 12 字段之后的 FAA 模式）只按字段位置解析，不做语义校验。
- 配对容差为角度（度）的简单阈值，非距离投影。
