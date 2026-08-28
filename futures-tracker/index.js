const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const {
    WS_URL,
    RECONNECT_DELAY_MS,
    PING_INTERVAL_MS,
    PRICE_STEP,
    SAVE_LOCAL_IMAGE,
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
let lastPushedPrice = null; // 记录上次成功推送时的价格
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

// ---------------- 核心价格变动触发逻辑 (|当前价格 - 上次推送价格| >= PRICE_STEP) ----------------
async function handlePriceTrigger(currentPrice, open, high, low, timeStr) {
    // 1. 首次收到价格：建立初始基准价格并发送首发基准推送
    if (lastPushedPrice === null) {
        lastPushedPrice = currentPrice;
        log(`🎯 【服务初始化基准】当前基准价格: $${currentPrice.toFixed(2)}，后续每当波动达到 $${PRICE_STEP} 时自动推送`);
        await executePush(currentPrice, null, 0, open, high, low, timeStr);
        return;
    }

    const priceDiff = currentPrice - lastPushedPrice;
    const absDiff = Math.abs(priceDiff);

    // 2. 检查波动幅度是否达到步长阈值
    if (absDiff < PRICE_STEP) {
        return;
    }

    if (isProcessingTrigger) {
        return;
    }

    const prevPrice = lastPushedPrice;
    lastPushedPrice = currentPrice; // 立即更新基准价，防止并发
    isProcessingTrigger = true;

    const diffSign = priceDiff >= 0 ? '+' : '';
    console.log('\n================================================================================');
    log(`🎯 【价格波动触发】当前价格: $${currentPrice.toFixed(2)} | 上次价格: $${prevPrice.toFixed(2)} | 波动: ${diffSign}$${priceDiff.toFixed(2)} (>= 步长 $${PRICE_STEP})`);
    console.log('================================================================================');

    await executePush(currentPrice, prevPrice, priceDiff, open, high, low, timeStr);
}

async function executePush(currentPrice, prevPrice, priceDiff, open, high, low, timeStr) {
    try {
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
            // 2. 绘制高质量 5 分钟 K 线图 (纯内存 Buffer，不写入本地磁盘)
            imageBuffer = drawKlineChart(bars, currentPrice, priceDiff, PRICE_STEP, sourceName);

            // 3. 本地保存 (按需)
            if (SAVE_LOCAL_IMAGE) {
                ensureOutputDir();
                const timeTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const historyPath = path.join(OUTPUT_DIR, `futures-trigger-5m-${currentPrice.toFixed(2)}-${timeTag}.png`);
                fs.writeFileSync(historyPath, imageBuffer);
                fs.writeFileSync(LATEST_IMAGE_PATH, imageBuffer);
                log(`💾 5分钟 K 线图已保存至本地: ${historyPath}`);
            }
        } else {
            log('⚠️ 未获取到 K 线数据，将仅推送文字消息');
        }

        // 4. 发送企业微信提醒
        await sendToWeCom({
            price: currentPrice,
            prevPrice,
            priceDiff,
            priceStep: PRICE_STEP,
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
