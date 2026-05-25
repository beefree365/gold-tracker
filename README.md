# gold-tracker

## Node 实时行情示例

这个项目现在包含一个基于 Finnhub WebSocket 的 Node 示例，用于获取黄金实时数据。

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
FINNHUB_TOKEN=你的token
FINNHUB_SYMBOL=OANDA:XAU_USD
```

### 3. 启动实时监听

```bash
npm run start:wss
```

### 4. 说明

- 默认订阅 `OANDA:XAU_USD`
- 连接成功后会自动发送订阅消息
- 代码会输出实时 `trade` 或 `quote` 消息
- 断线后会自动重连

### 5. 可能需要调整的参数

- `FINNHUB_SYMBOL`：修改为你要监听的 symbol
- `FINNHUB_RECONNECT_DELAY_MS`：重连间隔，默认 `3000` 毫秒
