# iTick WebSocket 现货价格监控使用指南

## 📋 概述

`wss-itick.js` 是基于 **iTick API** 的实时黄金现货价格监控脚本，支持：
- ✅ 实时接收 XAU/USD 黄金现货价格
- ✅ 检测价格整数部分是否为 2 的倍数
- ✅ 触发时自动绘制最近 5 小时 K 线图
- ✅ 智能重连机制（指数退避 + 心跳保活）

---

## 🚀 快速开始

### 1. 注册 iTick 账号

访问 [https://itick.org](https://itick.org) 注册并获取免费 API Token。

### 2. 配置环境变量

在 `.env` 文件中添加：

```env
# iTick WebSocket Configuration
ITICK_TOKEN=your_itick_token_here
ITICK_SYMBOL=XAUUSD
ITICK_WS_URL=wss://api-free.itick.org/forex

# TwelveData API (用于绘制 K 线图)
TWELVE_TOKEN=your_twelvedata_token_here
TWELVE_SYMBOL=XAU/USD
```

### 3. 运行脚本

```bash
npm run start:wss-itick
```

或直接运行：

```bash
node wss-itick.js
```

---

## 📊 工作流程

```
启动连接
  ↓
WebSocket 连接建立
  ↓
发送认证请求 (auth)
  ↓
认证成功 → 发送订阅请求 (subscribe XAUUSD)
  ↓
开始接收实时行情数据
  ↓
每收到一条消息：
  ├─ 检查价格整数部分是否为 2 的倍数
  ├─ 如果是新水平 → 触发回调
  └─ 获取最近 5 小时 K 线数据并绘图
  ↓
每 30 秒发送心跳包保持连接
  ↓
[异常断开] → 指数退避重连
```

---

## 🔧 核心功能

### 1. 价格触发逻辑

```javascript
// 取价格整数部分
const integerPrice = Math.floor(currentPrice);

// 判断是否为 2 的倍数
if (integerPrice % 2 === 0 && integerPrice !== lastTriggeredLevel) {
    // 触发！
    onPriceLevelHit(currentPrice, integerPrice);
}
```

**示例：**
- $4521.30 → 整数 4521 → 奇数 → 不触发
- $4522.00 → 整数 4522 → 偶数 → ✅ 触发
- $4522.50 → 整数 4522 → 同一水平 → 跳过
- $4524.00 → 整数 4524 → 偶数 → ✅ 触发

### 2. 长连接保护

| 机制 | 配置 | 说明 |
|------|------|------|
| 心跳保活 | 30 秒 | 每 30 秒发送 ping 包 |
| 空闲检测 | 120 秒 | 超过 2 分钟无数据主动重连 |
| 指数退避 | 3s → 6s → 12s... | 失败后逐步增加重连延迟 |
| 最小间隔 | 30 秒 | 避免频繁重连触发限流 |
| 最大重试 | 10 次 | 达到上限后停止并重报 |

### 3. K 线图生成

触发时自动：
1. 从 TwelveData API 获取最近 5 小时分钟 K 线（300 条）
2. 使用 Canvas 绘制专业 K 线图表
3. 标注触发价格水平线
4. 保存到 `output/charts/kline-trigger-{价格}-{时间戳}.png`

---

## 📝 日志示例

```
[2026-05-27T06:00:00.000Z] === iTick 现货价格监控启动 ===
[2026-05-27T06:00:00.000Z] 监控品种: XAUUSD
[2026-05-27T06:00:00.000Z] WebSocket: wss://api-free.itick.org/forex
[2026-05-27T06:00:00.000Z] 
[2026-05-27T06:00:01.000Z] 正在连接 iTick WebSocket: wss://api-free.itick.org/forex
[2026-05-27T06:00:02.000Z] ✓ WebSocket 连接成功
[2026-05-27T06:00:02.000Z] 🔐 发送认证请求
[2026-05-27T06:00:02.500Z] ✓ 连接成功确认
[2026-05-27T06:00:02.800Z] ✓ 认证成功
[2026-05-27T06:00:02.800Z] ✓ 已订阅品种: XAUUSD
[2026-05-27T06:00:03.000Z] 💹 实时行情 #1 {"symbol":"XAUUSD","type":"quote","price":4521.30,...}
[2026-05-27T06:00:03.500Z] 💹 实时行情 #2 {"symbol":"XAUUSD","type":"tick","price":4521.35,...}
[2026-05-27T06:00:32.000Z] 💓 发送心跳包
[2026-05-27T06:01:00.000Z] 💹 实时行情 #123 {"symbol":"XAUUSD","type":"quote","price":4522.00,...}
[2026-05-27T06:01:00.000Z] 🎯 价格触发！当前价格: $4522, 整数部分: $4522 (2的倍数)
[2026-05-27T06:01:00.000Z] 📊 正在获取最近 5 小时 K 线数据...
[2026-05-27T06:01:01.500Z] ✓ 获取到 300 条 K 线数据
[2026-05-27T06:01:02.000Z] ✓ K 线图已保存: output/charts/kline-trigger-4522-2026-05-27T06-01-02.png
```

---

## ⚙️ 配置选项

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ITICK_TOKEN` | 必填 | iTick API Token |
| `ITICK_SYMBOL` | `XAUUSD` | 监控品种 |
| `ITICK_WS_URL` | `wss://api-free.itick.org/forex` | WebSocket 地址 |
| `TWELVE_TOKEN` | 必填 | TwelveData API Token（绘图用） |
| `TWELVE_SYMBOL` | `XAU/USD` | K 线数据品种 |

### 内置常量（代码中修改）

```javascript
const MAX_RECONNECT_ATTEMPTS = 10;     // 最大重连次数
const MIN_RECONNECT_INTERVAL = 30000;  // 最小重连间隔 (ms)
const HEARTBEAT_INTERVAL = 30000;      // 心跳间隔 (ms)
const MAX_IDLE_TIME = 120000;          // 空闲超时 (ms)
```

---

## 🔍 故障排查

### 问题 1: 连接后立即断开

**可能原因：**
- API Token 无效或过期
- 网络连接问题

**解决方法：**
1. 检查 `.env` 中的 `ITICK_TOKEN` 是否正确
2. 访问 [iTick 官网](https://itick.org) 重新生成 Token
3. 检查防火墙/代理设置

### 问题 2: 收不到价格数据

**可能原因：**
- 认证失败
- 订阅失败
- 品种代码错误

**解决方法：**
1. 查看日志中是否有 "✓ 认证成功" 和 "✓ 已订阅品种"
2. 确认 `ITICK_SYMBOL` 设置为 `XAUUSD`（不是 `XAU/USD`）
3. 检查 iTick 账户是否有免费额度

### 问题 3: K 线图生成失败

**可能原因：**
- TwelveData Token 未配置
- TwelveData API 配额用完

**解决方法：**
1. 在 `.env` 中设置 `TWELVE_TOKEN`
2. 检查 TwelveData 账户配额（免费版 8 次/分钟）
3. 查看详细错误日志

### 问题 4: 频繁重连

**可能原因：**
- 网络不稳定
- 触发了速率限制

**解决方法：**
1. 检查网络连接
2. 脚本已内置指数退避，会自动调整重连频率
3. 如果持续失败，等待几分钟后重启

---

## 📈 性能指标

| 指标 | 数值 |
|------|------|
| 延迟 | < 50ms (WebSocket 推送) |
| 稳定性 | 内置重连 + 心跳保活 |
| 资源占用 | ~50MB 内存 |
| 触发精度 | 价格整数部分精确匹配 |
| K 线图生成 | ~1-2 秒 |

---

## 🆚 与 Finnhub 对比

| 特性 | iTick | Finnhub |
|------|-------|---------|
| **支持 XAU/USD** | ✅ 原生支持 | ❌ 免费不支持 WS |
| **WebSocket** | ✅ 稳定可用 | ❌ 免费不可用 |
| **免费版可用性** | ✅ 完全可用 | ❌ 连接几秒即断 |
| **延迟** | < 50ms | N/A |
| **SDK 支持** | ✅ 多语言 | ✅ Node.js |
| **内置重连** | ✅ 自动 | ⚠️ 需自实现 |

---

## 💡 最佳实践

1. **定期检查 Token 有效性** - 确保 API Token 未过期
2. **监控日志输出** - 关注重连频率和错误信息
3. **合理设置触发条件** - 根据市场波动调整倍数（2、5、10等）
4. **备份生成的图表** - 定期清理 `output/charts/` 目录
5. **使用 PM2 守护进程** - 生产环境建议使用 PM2 管理进程

```bash
# 安装 PM2
npm install -g pm2

# 启动脚本
pm2 start wss-itick.js --name "gold-monitor"

# 查看日志
pm2 logs gold-monitor

# 开机自启
pm2 startup
pm2 save
```

---

## 📞 技术支持

- **iTick 官方文档**: [https://itick.org/docs](https://itick.org/docs)
- **TwelveData 文档**: [https://twelvedata.com/docs](https://twelvedata.com/docs)
- **项目 Issues**: 提交问题到 GitHub

---

## 📄 许可证

本项目遵循 MIT 许可证。
