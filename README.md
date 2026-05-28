# 黄金追踪器 (Gold Tracker)

一个功能全面的 Node.js 应用程序，用于从多个数据源（包括期货合约、现货价格和实时 WebSocket 数据流）追踪、分析和可视化黄金市场数据。

## 功能特性

- **实时价格监控**：通过 Finnhub WebSocket 连接获取实时黄金价格更新
- **期货数据分析**：从 Massive.com API 获取并分析 GCM6 黄金期货合约数据
- **现货价格追踪**：从 TwelveData API 获取 XAU/USD 现货价格
- **对比分析**：对齐期货和现货数据进行相关性分析
- **可视化图表**：生成专业的 K 线图展示价格走势
- **CSV 导出**：以 CSV 格式保存历史数据供进一步分析
- **价差分析**：计算并可视化期货与现货之间的价差

## 项目结构

```
gold-tracker/
├── scripts/
│   ├── estimate-gold-futures.js     # 主分析脚本，包含期货/现货对比
│   ├── fetch-futures-only.js        # 仅获取期货数据
│   ├── fetch-latest-spot.js         # 获取最新现货数据
│   ├── fetch-spot-based-on-futures.js # 基于期货时间窗口获取对齐的现货数据
│   ├── fetch-futures-custom.js      # 自定义时间范围的期货数据（推荐）
│   ├── fetch-spot-custom.js         # 自定义时间范围的现货数据（推荐）
│   ├── gcm6-kline.js                # 绘制 GCM6 期货 K 线图
│   ├── finnhub-kline.js             # 绘制 Finnhub 数据 K 线图
│   ├── massive-spot-kline.js        # 绘制 Massive 现货 K 线图
│   └── twelve-kline.js              # 绘制 TwelveData K 线图
├── output/                          # 输出文件目录
│   ├── csv/                         # CSV 数据文件
│   │   ├── futures-data-*.csv       # 期货数据（自定义时间范围）
│   │   ├── spot-data-*.csv          # 现货数据（自定义时间范围）
│   │   ├── gold-futures-aligned-data.csv  # 对齐的期货现货数据
│   │   └── ...                      # 其他 CSV 文件
│   └── charts/                      # PNG 图表文件
│       ├── futures-kline-*.png      # 期货 K 线图
│       ├── spot-kline-*.png         # 现货 K 线图
│       └── gold-futures-aligned-kline.png # 对比图表
├── wss-gold.js                      # 实时 WebSocket 监听器
├── .env                             # 环境变量（未提交到版本控制）
├── .env.example                     # 环境变量配置示例
├── package.json                     # 依赖项和脚本
└── README.md                        # 本文件
```

## 安装

### 前置要求

- Node.js（推荐 14 或更高版本）
- npm（随 Node.js 一起提供）

### 设置步骤

1. 克隆仓库：
```bash
git clone <repository-url>
cd gold-tracker
```

2. 安装依赖：
```bash
npm install
```

3. 配置环境变量：
```bash
cp .env.example .env
```

4. 编辑 `.env` 文件，填入您的 API 密钥：
```env
FINNHUB_TOKEN=your_finnhub_api_token
FINNHUB_SYMBOL=OANDA:XAU_USD
FINNHUB_RECONNECT_DELAY_MS=3000
TWELVE_TOKEN=your_twelvedata_api_token
TWELVE_SYMBOL=XAU/USD
TWELVE_INTERVAL=1min
MASSIVE_TOKEN=your_massive_api_token
```

## API 密钥

您需要从以下服务获取 API 密钥：

- **Finnhub**：[https://finnhub.io/](https://finnhub.io/) - 用于实时 WebSocket 数据
- **TwelveData**：[https://twelvedata.com/](https://twelvedata.com/) - 用于现货价格数据
- **Massive.com**：[https://massive.com/](https://massive.com/) - 用于期货合约数据

## 使用方法

### 实时监控

#### 方法 1：通用实时监听（原有脚本）
```bash
npm run start:wss
```
连接到 Finnhub WebSocket API，显示实时交易和报价数据。

#### 方法 2：现货专用实时监听（推荐）
```bash
npm run start:wss-spot
```

**功能特性**：
- 专门针对现货市场优化
- 显示价格变化趋势（↑↓箭头）
- 统计接收消息数量
- 更详细的日志输出
- 自动重连机制
- 优雅退出处理
- **🎯 价格水平监控**：当价格达到 2 的倍数时自动触发回调

**价格监控功能**：
- 自动检测价格整数部分是否达到 2 的倍数（如 $4520, $4522, $4524 等）
- 每个价格水平只触发一次，避免重复通知
- 触发时显示醒目的日志信息
- **📊 自动绘制 K 线图**：触发时自动获取最近 5 小时的分钟 K 线数据并保存为 PNG 图片
- 可在 `onPriceLevelHit` 函数中自定义触发动作（发送通知、执行交易等）

**K 线图特性**：
- 时间范围：最近 5 小时（300 条分钟数据）
- 文件名格式：`kline-trigger-{价格水平}-{时间戳}.png`
- 保存位置：`output/charts/` 目录
- 图表包含：触发价格信息、时间范围、涨跌颜色标识

**配置**：
在 `.env` 文件中设置：
```env
SPOT_SYMBOL=OANDA:XAU_USD  # 可选，默认使用 FINNHUB_SYMBOL
```

### 仅期货数据

#### 方法 1：昨天的交易日数据（自动识别）
```bash
npm run fetch:futures-only
```

**交易日说明**：
- 黄金期货交易时间：美东时间每天凌晨 6:00 到次日凌晨 5:00（23小时）
- 脚本会自动识别"昨天"的完整交易时段
- 默认获取约 1380 条分钟数据（23小时 × 60分钟）

输出文件：
- `futures-only-data.csv` - 原始期货数据
- `futures-only-kline.png` - K 线图可视化

#### 方法 2：自定义时间范围的期货数据（推荐）
```bash
npm run fetch:futures-custom -- "<起始时间>" "<结束时间>"
```

**使用说明**：
- 支持多种日期格式，推荐使用 ISO 格式（带 Z 后缀表示 UTC 时间）
- 文件名会自动包含时间戳后缀，便于区分不同时间段的数据
- 同时生成 CSV 数据文件和 PNG 图表文件
- 自动计算所需的数据量并过滤到指定时间范围

**示例**：
```bash
# 获取特定时间段的期货数据（ISO 格式，UTC 时间）
npm run fetch:futures-custom -- "2026-05-25T11:00:00Z" "2026-05-25T22:00:00Z"

# 也可以使用其他日期格式
npm run fetch:futures-custom -- "2026-05-25 11:00:00" "2026-05-25 22:00:00"
npm run fetch:futures-custom -- "2026-05-25" "2026-05-26"
```

**输出文件**：
- `futures-data-YYYYMMDD_HHMM_to_YYYYMMDD_HHMM.csv` - 期货价格数据
- `futures-kline-YYYYMMDD_HHMM_to_YYYYMMDD_HHMM.png` - 期货价格 K 线图

**注意**：时间范围不能超过 API 的限制，建议每次获取不超过几天的数据。

### 仅现货数据

#### 方法 1：最新现货数据
```bash
npm run fetch:latest-spot
```
输出文件：
- `latest-spot-data.csv` - 最新现货价格数据
- `latest-spot-kline.png` - 现货价格 K 线图

#### 方法 2：与期货对齐的现货数据
```bash
npm run fetch:spot-based-on-futures
```
注意：需要先运行 `fetch:futures-only` 以建立时间窗口。
输出文件：
- `spot-only-data.csv` - 与期货时间窗口对齐的现货数据
- `spot-only-kline.png` - 对齐的现货价格图表

#### 方法 3：自定义时间范围的现货数据（推荐）
```bash
npm run fetch:spot-custom -- "<起始时间>" "<结束时间>"
```

**使用说明**：
- 支持多种日期格式，推荐使用 ISO 格式（带 Z 后缀表示 UTC 时间）
- 文件名会自动包含时间戳后缀，便于区分不同时间段的数据
- 同时生成 CSV 数据文件和 PNG 图表文件

**示例**：
```bash
# 获取特定时间段的现货数据（ISO 格式，UTC 时间）
npm run fetch:spot-custom -- "2026-05-25T14:00:00Z" "2026-05-25T22:00:00Z"

# 也可以使用其他日期格式
npm run fetch:spot-custom -- "2026-05-25 14:00:00" "2026-05-25 22:00:00"
npm run fetch:spot-custom -- "2026-05-25" "2026-05-26"
```

**输出文件**：
- `spot-data-YYYYMMDD_HHMM_to_YYYYMMDD_HHMM.csv` - 现货价格数据
- `spot-kline-YYYYMMDD_HHMM_to_YYYYMMDD_HHMM.png` - 现货价格 K 线图

**注意**：时间范围不能超过 TwelveData API 的限制，建议每次获取不超过几天的数据。

### 综合分析

运行结合期货和现货数据的主分析脚本：
```bash
npm run estimate:gold-futures
```

这个强大的脚本会：
1. 从 Massive.com 获取最新期货数据
2. 从 TwelveData 获取相同时间段的对应现货数据
3. 从 Finnhub 获取实时现货价格
4. 计算价差和相关性
5. 生成综合 CSV 文件和可视化图表

输出文件：
- `gold-futures-aligned-data.csv` - 包含价差的期货和现货组合数据
- `gold-futures-raw-data.csv` - 原始期货数据
- `gold-spot-raw-data.csv` - 原始现货数据
- `gold-futures-aligned-kline.png` - 显示期货和现货价格的对比图表

### 单独图表生成

生成特定的 K 线图：
```bash
npm run draw:gcm6-kline           # GCM6 期货图表
npm run draw:finnhub-kline        # Finnhub 数据图表
npm run draw:massive-spot-kline   # Massive 现货数据图表
npm run draw:twelve-kline         # TwelveData 图表
```

## 输出文件

应用程序生成以下几种类型的输出文件，并自动整理到 `output` 目录中：

### 文件夹结构

```
output/
├── csv/         # 所有 CSV 数据文件
└── charts/      # 所有 PNG 图表文件
```

### CSV 数据文件（output/csv/）
- 逗号分隔格式的历史价格数据
- 包含 OHLC（开盘价、最高价、最低价、收盘价）值
- ISO 格式的时间戳
- 可用的成交量数据
- 对比分析的价差计算

**文件名格式**：
- `futures-data-YYYYMMDD_HHMM_to_YYYYMMDD_HHMM.csv` - 自定义时间范围的期货数据
- `spot-data-YYYYMMDD_HHMM_to_YYYYMMDD_HHMM.csv` - 自定义时间范围的现货数据
- `gold-futures-aligned-data.csv` - 对齐的期货和现货数据
- `futures-only-data.csv` - 昨天的期货数据
- 其他特定用途的 CSV 文件

### PNG 图表（output/charts/）
- 专业的 K 线（蜡烛图）图表
- 深色主题，清晰标注
- 价格刻度和时间轴
- 指示数据来源的图例
- 支持多个时间周期

**文件名格式**：
- `futures-kline-YYYYMMDD_HHMM_to_YYYYMMDD_HHMM.png` - 期货 K 线图
- `spot-kline-YYYYMMDD_HHMM_to_YYYYMMDD_HHMM.png` - 现货 K 线图
- `gold-futures-aligned-kline.png` - 期货现货对比图
- `futures-only-kline.png` - 昨天的期货图表
- 其他特定用途的图表

## 数据源

| 数据源 | 类型 | 交易对 | 时间周期 | 用途 |
|--------|------|--------|----------|------|
| Massive.com | 期货 | GCM6 | 1分钟 | 黄金期货合约数据 |
| TwelveData | 现货 | XAU/USD | 1分钟 | 黄金现货价格数据 |
| Finnhub | 实时 | OANDA:XAU_USD | 实时 | 实时价格更新 |

## 技术细节

### 架构设计

应用程序采用模块化方法，不同功能使用独立的脚本：

1. **数据获取模块**：处理与各种提供商的 API 通信
2. **标准化层**：跨不同 API 统一数据格式
3. **分析引擎**：执行相关性和价差计算
4. **可视化组件**：使用 Canvas API 创建图表
5. **导出工具**：以 CSV 格式保存数据

### 核心技术

- **Node.js**：运行时环境
- **WebSocket**：实时数据流
- **Canvas API**：图表生成
- **dotenv**：环境变量管理
- **node-fetch**：API 调用的 HTTP 请求

### 数据处理流程

1. **身份验证**：从环境变量加载 API 密钥
2. **数据检索**：从多个来源并行或顺序获取
3. **时间对齐**：匹配不同数据源的时间戳
4. **标准化**：将不同的 API 响应转换为标准格式
5. **分析**：计算价差、相关性和趋势
6. **可视化**：渲染具有适当缩放和标签的图表
7. **导出**：以可访问的格式保存结果

## 重要说明

### API 限制

- **TwelveData**：免费套餐有速率限制（每分钟 8 次调用）
- **Massive.com**：期货数据可能有延迟（>30 分钟）
- **Finnhub**：WebSocket 连接可能存在稳定性问题

### 数据注意事项

- 期货和现货价格来自不同的交易所/平台
- 价格走势可能不完全同步
- 时区差异可能影响对齐
- 不同工具的交易时间各不相同

**黄金期货交易时间**：
- 交易时段：美东时间每天凌晨 6:00 到次日凌晨 5:00（23小时）
- 休市时间：每天凌晨 5:00 到 6:00（1小时）
- 周末休市：周五下午 5:00 到周日晚上 6:00
- 脚本会自动识别并获取完整交易日的数据

**时间窗口逻辑**：
- 自动计算"昨天"的完整交易时段（从美东时间凌晨 6:00 开始）
- 过滤掉非交易时间的数据
- 确保期货和现货数据在相同的时间窗口内对齐
- 默认获取约 1380 条分钟数据（23小时 × 60分钟），实际根据API返回过滤

### 性能优化建议

- 进行对比分析时先运行仅期货脚本
- 批量数据检索时注意 API 速率限制
- 考虑缓存重复分析的结果
- 监控实时数据流的 WebSocket 连接稳定性

## 故障排除

### 常见问题

1. **API 认证错误**
   - 验证 `.env` 中是否设置了所有必需的密钥
   - 检查密钥的有效性和权限
   - 确保密钥值中没有多余的空格

2. **速率限制**
   - 如需要，在 API 调用之间添加延迟
   - 升级 API 套餐以获得更高的限制
   - 为失败的请求实现重试逻辑

3. **图表生成问题**
   - 验证 canvas 库是否正确安装
   - 检查系统图形库
   - 确保大数据集有足够的内存

4. **WebSocket 连接问题**
   - 验证网络连接
   - 检查防火墙设置
   - 验证 Finnhub 密钥权限

## 贡献指南

1. Fork 本仓库
2. 创建功能分支
3. 进行更改
4. 充分测试
5. 提交 Pull Request

## 许可证

本项目采用 MIT 许可证 - 详情请参见 LICENSE 文件。

## 支持

如有问题、疑问或贡献，请在 GitHub 仓库上开启 Issue。
