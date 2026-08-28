# COMEX 黄金期货实时监控与智能 5 分钟 K 线系统 (Futures Tracker)

本模块是独立封装的 **COMEX 黄金期货（GC）** 实时行情监听、触发报警、多源容灾智能 K 线生成与企业微信推送服务。

---

## 🌟 核心特性

1. **毫秒级 0 延迟行情监听**：
   * 基于新浪 WebSocket 行情流 (`wss://hq.sinajs.cn/wskt?list=hf_GC`)，直接跟踪 COMEX 纽约黄金主力合约 `GCZ6`。
2. **2 的倍数整数位触发**：
   * 盘口最新价整数位满足 `integerPrice % 2 === 0` 时触发（如 $4634, $4636, $4638, $4640...）。
   * 内置防并发锁定与同价位防重复触发机制。
3. **3 级数据源智能容灾机制**：
   * **优先级 1**：Massive 期货主力合约 (`GCZ6` / `GCV6`，新鲜度 < 15 分钟)。
   * **优先级 2**：TwelveData 现货金 (`XAU/USD` 5分钟 K 线，288 根连续数据)。
   * **优先级 3**：币安加密黄金 (`PAXG/USDT` 5分钟 K 线，24/7 全天候保底)。
4. **双锚点时间线性插值对齐算法（Dual-Anchor Interpolation）**：
   * 起点锚定今日开盘价差，终点锚定最新平滑价差，消除日内基差漂移与盘口买卖跳价毛刺。
5. **企业微信与本地多路径保存**：
   * 自动推送 Markdown 详细分析卡片 + 高清 1800x850 亮色白底 K 线走势图。
   * 本地自动保存历史归档与最新快捷预览图。

---

## 📁 目录结构

```text
futures-tracker/
├── index.js          # 主入口：WebSocket 实时监听与 2 倍数自动触发流水线
├── draw.js           # 手动即时导出：随时生成一份当前最新的 24h 5m K 线图
├── align.js          # 双锚点时间加权线性插值对齐算法
├── fetcher.js        # 3 级多源 K 线获取器与健康状态诊断
├── chart.js          # 1800x850 亮色白底 Canvas 绘图引擎 (集成系统中文字体)
├── wecom.js          # 企业微信 Webhook 机器人推送 (Markdown + Base64图片)
├── config.js         # 统一配置中心 (Token、合约、Webhook、路径)
├── README.md         # 模块使用文档
└── output/           # 生成的图表保存目录
```

---

## 🚀 运行指令

### 1. 启动常驻监控服务（自动监听 + 触发推送）
```bash
node futures-tracker/index.js
```
或在项目根目录运行：
```bash
npm run start:futures
```

### 2. 手动即时导出 K 线图（单次执行查看）
```bash
node futures-tracker/draw.js
```
或在项目根目录运行：
```bash
npm run draw:futures
```
