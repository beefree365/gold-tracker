const { WebSocket } = require('ws');

// Binance WebSocket 行情流地址 (免 Token，直接连接)
const WS_URL = 'wss://stream.binance.com:9443/ws/paxgusdt@ticker';
const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 30000; // 每 30 秒发送一次协议层 Ping

let ws = null;
let reconnectTimer = null;
let pingTimer = null;
let isAlive = false;
let lastPrice = null;

function log(msg, data) {
    const time = new Date().toLocaleTimeString();
    if (data) {
        console.log(`[${time}] ${msg}`, data);
    } else {
        console.log(`[${time}] ${msg}`);
    }
}

function heartbeat() {
    isAlive = true;
}

function connect() {
    log(`正在连接币安 WebSocket: ${WS_URL}`);

    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        isAlive = true;
        log('✅ 成功连接到加密黄金 PAXG/USDT 实时数据流！\n');
        console.log('--------------------------------------------------------------------------------');
        console.log('   时间        最新价格 ($)   价格变动      24h最高       24h最低      24h涨跌幅');
        console.log('--------------------------------------------------------------------------------');

        // 启动定时 Ping 保活与假死检测
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
            if (!isAlive) {
                log('⚠️ 检测到网络假死（未收到数据/Pong），主动断开重连...');
                return ws.terminate();
            }
            isAlive = false;
            ws.ping();
        }, PING_INTERVAL_MS);
    });

    // 收到服务端 Pong 响应，确认网络畅通
    ws.on('pong', heartbeat);

    ws.on('message', (raw) => {
        isAlive = true; // 收到行情数据证明连接正常
        try {
            const data = JSON.parse(raw.toString());

            // 字段含义说明:
            // c: 最新成交价 (Close / Current price)
            // p: 24h价格变化 (Price change)
            // P: 24h价格变化百分比 (Price change percent)
            // h: 24h最高价 (High)
            // l: 24h最低价 (Low)
            // v: 24h成交量 (Volume)
            // b: 买一价 (Best Bid)
            // a: 卖一价 (Best Ask)
            const price = parseFloat(data.c);
            const priceChange = parseFloat(data.p);
            const changePercent = parseFloat(data.P);
            const high = parseFloat(data.h);
            const low = parseFloat(data.l);

            // 趋势箭头判断
            let trend = ' ';
            if (lastPrice !== null) {
                if (price > lastPrice) trend = '🔺';
                else if (price < lastPrice) trend = '🔻';
            }
            lastPrice = price;

            const timeStr = new Date(data.E).toLocaleTimeString();
            const changeStr = (changePercent >= 0 ? '+' : '') + changePercent.toFixed(2) + '%';
            const priceChangeStr = (priceChange >= 0 ? '+' : '') + priceChange.toFixed(2);

            console.log(
                ` ${timeStr}   ${trend} $${price.toFixed(2).padEnd(10)}  ` +
                `${priceChangeStr.padEnd(10)}  ` +
                `$${high.toFixed(2).padEnd(10)}  ` +
                `$${low.toFixed(2).padEnd(10)}  ` +
                `${changeStr}`
            );
        } catch (err) {
            log('❌ 数据解析错误:', err.message);
        }
    });

    ws.on('error', (err) => {
        log('❌ WebSocket 异常:', err.message);
    });

    ws.on('close', (code, reason) => {
        clearInterval(pingTimer);
        log(`⚠️ 连接已断开 (Code: ${code})，${RECONNECT_DELAY_MS / 1000} 秒后尝试重连...`);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
}

// 捕获退出信号优雅关闭
process.on('SIGINT', () => {
    clearInterval(pingTimer);
    log('\n正在断开连接并退出...');
    if (ws) ws.close();
    process.exit(0);
});

// 启动连接
connect();
