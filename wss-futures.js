const { WebSocket } = require('ws');

// 新浪 COMEX 纽约黄金期货 WebSocket 行情流 (实时、免 Token)
const WS_URL = 'wss://hq.sinajs.cn/wskt?list=hf_GC';
const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 30000;

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

function connect() {
    log(`正在连接 COMEX 黄金期货实时 WebSocket: ${WS_URL}`);

    ws = new WebSocket(WS_URL, {
        headers: {
            'Origin': 'https://finance.sina.com.cn',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
    });

    ws.on('open', () => {
        isAlive = true;
        log('✅ 成功连接到 COMEX 纽约黄金期货实时行情流！\n');
        console.log('---------------------------------------------------------------------------------------------------------------');
        console.log('   时间        最新价格 ($)   买一 / 卖一 ($)       今日开盘       今日最高       今日最低      当日涨跌幅');
        console.log('---------------------------------------------------------------------------------------------------------------');

        // 定时 Ping 保活
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
            if (!isAlive) {
                log('⚠️ 检测到连接假死，主动断开重连...');
                return ws.terminate();
            }
            isAlive = false;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, PING_INTERVAL_MS);
    });

    ws.on('pong', () => {
        isAlive = true;
    });

    ws.on('message', (raw) => {
        isAlive = true;
        try {
            const text = raw.toString().trim();
            const lines = text.split('\n');

            for (const line of lines) {
                if (!line.startsWith('hf_GC=')) continue;

                const payload = line.replace('hf_GC=', '');
                const fields = payload.split(',');

                // 字段说明:
                // fields[0]: 最新成交价
                // fields[2]: 买一价
                // fields[3]: 卖一价
                // fields[4]: 今日最高价
                // fields[5]: 今日最低价
                // fields[6]: 撮合时间 (HH:mm:ss)
                // fields[7]: 昨结算/昨收
                // fields[8]: 今日开盘价
                // fields[12]: 日期 (YYYY-MM-DD)
                const price = parseFloat(fields[0]);
                const bid = parseFloat(fields[2]);
                const ask = parseFloat(fields[3]);
                const high = parseFloat(fields[4]);
                const low = parseFloat(fields[5]);
                const timeStr = fields[6] || new Date().toLocaleTimeString();
                const open = parseFloat(fields[8]);

                if (isNaN(price)) continue;

                // 涨跌趋势箭头
                let trend = ' ';
                if (lastPrice !== null) {
                    if (price > lastPrice) trend = '🔺';
                    else if (price < lastPrice) trend = '🔻';
                }
                lastPrice = price;

                // 计算相对于今日开盘的涨跌幅
                const changeAmount = open > 0 ? price - open : 0;
                const changePercent = open > 0 ? (changeAmount / open) * 100 : 0;
                const changeStr = (changePercent >= 0 ? '+' : '') + changePercent.toFixed(2) + '%';
                const bidAskStr = `$${bid.toFixed(2)} / $${ask.toFixed(2)}`;

                console.log(
                    ` ${timeStr}   ${trend} $${price.toFixed(2).padEnd(10)}  ` +
                    `${bidAskStr.padEnd(18)}  ` +
                    `$${open.toFixed(2).padEnd(10)}  ` +
                    `$${high.toFixed(2).padEnd(10)}  ` +
                    `$${low.toFixed(2).padEnd(10)}  ` +
                    `${changeStr}`
                );
            }
        } catch (err) {
            log('❌ 数据解析异常:', err.message);
        }
    });

    ws.on('error', (err) => {
        log('❌ WebSocket 异常:', err.message);
    });

    ws.on('close', (code) => {
        clearInterval(pingTimer);
        log(`⚠️ 连接已断开 (Code: ${code})，${RECONNECT_DELAY_MS / 1000} 秒后尝试重连...`);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
}

// 优雅退出
process.on('SIGINT', () => {
    clearInterval(pingTimer);
    log('\n正在断开连接并退出...');
    if (ws) ws.close();
    process.exit(0);
});

// 启动
connect();
