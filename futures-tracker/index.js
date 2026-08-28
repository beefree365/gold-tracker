const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const {
    WS_URL,
    RECONNECT_DELAY_MS,
    PING_INTERVAL_MS,
    OUTPUT_DIR,
    LATEST_IMAGE_PATH,
    WECOM_WEBHOOK_URL
} = require('./config');
const { fetch24Hours5MinKline } = require('./fetcher');
const { drawKlineChart } = require('./chart');
const { sendToWeCom } = require('./wecom');

let ws = null;
let reconnectTimer = null;
let pingTimer = null;
let isAlive = false;
let lastPrice = null;
let lastTriggeredLevel = null;
let isProcessingTrigger = false;

function log(msg, data) {
    const time = new Date().toLocaleTimeString();
    if (data) {
        console.log(`[${time}] ${msg}`, JSON.stringify(data));
    } else {
        console.log(`[${time}] ${msg}`);
    }
}

// 确保输出目录存在
function ensureOutputDir() {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
}

// ---------------- 核心价格触发逻辑 (2 的倍数) ----------------
async function handlePriceTrigger(currentPrice, open, high, low, timeStr) {
    const integerPrice = Math.floor(currentPrice);

    // 判断整数部分是否为 2 的倍数
    if (integerPrice % 2 !== 0) {
        return;
    }

    const currentLevel = integerPrice;

    // 同一整数水平不重复触发
    if (currentLevel === lastTriggeredLevel) {
        return;
    }

    if (isProcessingTrigger) {
        return;
    }

    lastTriggeredLevel = currentLevel;
    isProcessingTrigger = true;

    try {
        console.log('\n================================================================================');
        log(`🎯 【价格触发 2 的倍数】当前价格: $${currentPrice.toFixed(2)} | 触发水平: $${currentLevel}`);
        console.log('================================================================================');

        // 1. 获取 24 小时 5 分钟 K 线 (双锚点时间线性插值)
        const { bars, sourceName, statusList } = await fetch24Hours5MinKline(currentPrice, open);
        let imageBuffer = null;

        // 打印 3 级数据源状态诊断
        console.log('\n┌────────────────────────────── 3 级数据源状态排查 ──────────────────────────────┐');
        for (const item of (statusList || [])) {
            console.log(`│ [${item.status}] ${item.name.padEnd(28)} : ${item.reason}`);
        }
        console.log('└────────────────────────────────────────────────────────────────────────────────┘\n');

        if (bars && bars.length > 0) {
            // 2. 绘制高质量 5 分钟 K 线图
            imageBuffer = drawKlineChart(bars, currentPrice, currentLevel, sourceName);

            // 3. 本地多路径自动保存
            ensureOutputDir();
            const timeTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const historyPath = path.join(OUTPUT_DIR, `futures-trigger-5m-${currentLevel}-${timeTag}.png`);
            const latestModulePath = LATEST_IMAGE_PATH;
            const rootLatestPath = path.join(__dirname, '..', 'futures-5m-kline-latest.png');

            fs.writeFileSync(historyPath, imageBuffer);
            fs.writeFileSync(latestModulePath, imageBuffer);
            try { fs.writeFileSync(rootLatestPath, imageBuffer); } catch (e) {}

            log(`💾 5分钟 K 线图已保存至本地:`);
            log(`   ├─ 历史归档: ${historyPath}`);
            log(`   ├─ 模块最新: ${latestModulePath}`);
            log(`   └─ 根目录:   ${rootLatestPath}`);
        } else {
            log('⚠️ 未获取到 K 线数据，将仅推送文字消息');
        }

        // 4. 发送企业微信提醒
        await sendToWeCom({
            price: currentPrice,
            level: currentLevel,
            open,
            high,
            low,
            timeStr,
            imageBuffer,
            sourceName,
            statusList
        });

    } catch (err) {
        log('❌ 触发处理流程异常:', err.message);
    } finally {
        isProcessingTrigger = false;
    }
}

// ---------------- WebSocket 连接管理 ----------------
function connect() {
    log(`正在连接 COMEX 黄金期货实时 WebSocket: ${WS_URL}`);

    ws = new WebSocket(WS_URL, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://finance.sina.com.cn'
        },
        handshakeTimeout: 10000
    });

    ws.on('open', () => {
        isAlive = true;
        log('✅ 成功连接到 COMEX 纽约黄金期货实时行情流！');
        if (WECOM_WEBHOOK_URL) {
            log(`📢 企业微信推送 Webhook 已配置: ${WECOM_WEBHOOK_URL.slice(0, 50)}...`);
        }

        console.log('\n' + '-'.repeat(111));
        console.log('   时间        最新价格 ($)   买一 / 卖一 ($)       今日开盘       今日最高       今日最低      当日涨跌幅');
        console.log('-'.repeat(111));

        startPing();
    });

    ws.on('message', async (data) => {
        try {
            const rawStr = data.toString('utf-8');
            const match = rawStr.match(/="([^"]+)"/);
            if (!match) return;

            const fields = match[1].split(',');
            if (fields.length < 13) return;

            const price = parseFloat(fields[0]);
            const open = parseFloat(fields[8]);
            const high = parseFloat(fields[4]);
            const low = parseFloat(fields[5]);
            const bid = parseFloat(fields[2]);
            const ask = parseFloat(fields[3]);
            const timeStr = fields[6];

            if (!price || isNaN(price)) return;

            const change = open > 0 ? (((price - open) / open) * 100).toFixed(2) : '0.00';
            const changeSign = change >= 0 ? '+' : '';

            let priceArrow = '  ';
            if (lastPrice !== null) {
                if (price > lastPrice) priceArrow = '🔺';
                else if (price < lastPrice) priceArrow = '🔻';
            }
            lastPrice = price;

            const formattedTime = timeStr || new Date().toLocaleTimeString();
            const logLine = ` ${formattedTime}   ${priceArrow} $${price.toFixed(2).padEnd(10)} $${bid.toFixed(2)} / $${ask.toFixed(2)}  $${open.toFixed(2).padEnd(11)} $${high.toFixed(2).padEnd(11)} $${low.toFixed(2).padEnd(11)} ${changeSign}${change}%`;
            console.log(logLine);

            // 检查 2 的倍数触发条件
            await handlePriceTrigger(price, open, high, low, formattedTime);

        } catch (e) {
            log('⚠️ 解析行情数据异常:', e.message);
        }
    });

    ws.on('ping', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.pong();
        }
    });

    ws.on('pong', () => {
        isAlive = true;
    });

    ws.on('error', (err) => {
        log('❌ WebSocket 异常:', err.message);
    });

    ws.on('close', (code, reason) => {
        log(`🔌 WebSocket 连接关闭 [代码: ${code}] ${reason ? reason.toString() : ''}`);
        cleanup();
        scheduleReconnect();
    });
}

function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!isAlive) {
            log('⚠️ 心跳检测超时无响应，正在重新连接...');
            ws.terminate();
            return;
        }
        isAlive = false;
        try {
            ws.ping();
        } catch (e) {}
    }, PING_INTERVAL_MS);
}

function stopPing() {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    log(`⏳ ${RECONNECT_DELAY_MS / 1000} 秒后尝试重新连接...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, RECONNECT_DELAY_MS);
}

function cleanup() {
    stopPing();
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

process.on('SIGINT', () => {
    console.log('\n正在断开连接并退出...');
    cleanup();
    if (ws) ws.close();
    process.exit(0);
});

// 启动
connect();
