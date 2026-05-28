require('dotenv').config();

const { WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

// Polyfill fetch for Node.js < 18
let fetch;
if (typeof global.fetch === 'undefined') {
    const nodeFetch = require('node-fetch');
    fetch = nodeFetch.default || nodeFetch;
} else {
    fetch = global.fetch;
}

// Configuration from environment variables
const token = process.env.ITICK_TOKEN;
const symbol = process.env.ITICK_SYMBOL || 'XAUUSD';
const wsUrl = process.env.ITICK_WS_URL || `wss://api-free.itick.org/forex`;

if (!token) {
    console.error('请先设置 ITICK_TOKEN 环境变量');
    console.error('注册地址: https://itick.org');
    process.exit(1);
}

let ws;
let reconnectTimer = null;
let isConnecting = false;
let messageCount = 0;
let lastPrice = null;
let lastTriggeredLevel = null; // Track the last 2-multiple level that triggered
let reconnectAttempts = 0;
let lastReconnectTime = 0;
let heartbeatTimer = null;
let connectionStartTime = null;
let isAuthenticated = false;
let isSubscribed = false;

const MAX_RECONNECT_ATTEMPTS = 10;
const MIN_RECONNECT_INTERVAL = 30000;
const HEARTBEAT_INTERVAL = 30000;
const MAX_IDLE_TIME = 120000;

function log(message, extra) {
    const timestamp = new Date().toISOString();
    const payload = extra ? ` ${JSON.stringify(extra)}` : '';
    console.log(`[${timestamp}] ${message}${payload}`);
}

/**
 * Calculate exponential backoff delay with jitter
 */
function calculateBackoffDelay(attempt) {
    const baseDelay = Math.min(3000 * Math.pow(2, attempt - 1), 300000);
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    return Math.floor(baseDelay + jitter);
}

/**
 * Start heartbeat timer
 */
function startHeartbeat() {
    stopHeartbeat();
    
    heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                const pingMsg = {
                    ac: 'ping',
                    params: String(Date.now())
                };
                ws.send(JSON.stringify(pingMsg));
                log('💓 发送心跳包');
            } catch (error) {
                log('⚠️  心跳发送失败', { error: error.message });
            }
        }
    }, HEARTBEAT_INTERVAL);
}

/**
 * Stop heartbeat timer
 */
function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

let idleTimer = null;

/**
 * Reset idle timer
 */
function resetIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
    }
    
    idleTimer = setTimeout(() => {
        log(`⚠️  连接空闲超过 ${MAX_IDLE_TIME / 1000} 秒，主动断开并重连`);
        if (ws) {
            ws.close();
        }
    }, MAX_IDLE_TIME);
}

/**
 * Send authentication message
 */
function sendAuth() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    const authMsg = {
        action: 'auth',
        api_key: token
    };

    ws.send(JSON.stringify(authMsg));
    log('🔐 发送认证请求');
}

/**
 * Send subscription message
 */
function sendSubscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    const subscribeMsg = {
        action: 'subscribe',
        symbols: [symbol],
        types: 'quote,tick'
    };

    ws.send(JSON.stringify(subscribeMsg));
    log(`✓ 已订阅品种: ${symbol}`);
    isSubscribed = true;
}

function connect() {
    if (isConnecting) {
        return;
    }

    isConnecting = true;
    isAuthenticated = false;
    isSubscribed = false;
    
    log(`正在连接 iTick WebSocket: ${wsUrl}`);
    
    ws = new WebSocket(wsUrl, {
        headers: {
            'token': token
        }
    });

    ws.on('open', () => {
        isConnecting = false;
        connectionStartTime = Date.now();
        log('✓ WebSocket 连接成功');
        
        // Step 1: Authenticate
        sendAuth();
    });

    ws.on('message', (raw) => {
        try {
            const message = JSON.parse(raw.toString());
            handleMessage(message);
            resetIdleTimer();
        } catch (error) {
            log('✗ 解析消息失败', { error: error.message, raw: raw.toString().substring(0, 200) });
        }
    });

    ws.on('error', (error) => {
        log('✗ WebSocket 错误', { error: error.message });
    });

    ws.on('close', (code, reason) => {
        isConnecting = false;
        isAuthenticated = false;
        isSubscribed = false;
        reconnectAttempts++;
        
        stopHeartbeat();
        
        const now = Date.now();
        const timeSinceLastReconnect = now - lastReconnectTime;
        const connectionDuration = connectionStartTime ? ((now - connectionStartTime) / 1000).toFixed(1) : 'N/A';
        
        log(`WebSocket 连接关闭 (code: ${code})`, {
            reason: reason ? reason.toString() : '',
            duration: `${connectionDuration}s`,
            totalMessages: messageCount
        });
        
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            log(`✗ 达到最大重连次数 (${MAX_RECONNECT_ATTEMPTS})，停止重连`);
            log(`会话统计: 共接收 ${messageCount} 条消息`);
            process.exit(1);
        }
        
        let actualDelay = calculateBackoffDelay(reconnectAttempts);
        
        if (timeSinceLastReconnect < MIN_RECONNECT_INTERVAL) {
            actualDelay = Math.max(actualDelay, MIN_RECONNECT_INTERVAL - timeSinceLastReconnect);
            log(`⏱️  为避免速率限制，延迟重连至 ${actualDelay}ms`);
        }
        
        lastReconnectTime = now;
        
        log(`准备在 ${actualDelay}ms 后重连... (尝试 ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
        }

        reconnectTimer = setTimeout(() => {
            log('尝试重新连接...');
            connect();
        }, actualDelay);
    });
}

function handleMessage(message) {
    // Handle system messages
    if (message.code === 1) {
        if (message.msg === 'Connected Successfully') {
            log('✓ 连接成功确认');
        } else if (message.resAc === 'auth' && message.msg === 'authenticated') {
            log('✓ 认证成功');
            isAuthenticated = true;
            
            // Step 2: Subscribe after authentication
            sendSubscribe();
            
            // Step 3: Start heartbeat
            startHeartbeat();
        }
        return;
    }

    // Handle market data
    if (message.data) {
        const data = message.data;
        const currentPrice = Number(data.last || data.p || data.close);
        
        if (!currentPrice || isNaN(currentPrice)) {
            return;
        }

        messageCount++;
        const priceChange = lastPrice ? (currentPrice - lastPrice).toFixed(2) : 'N/A';
        const changeSymbol = lastPrice ? (currentPrice >= lastPrice ? '↑' : '↓') : '';
        
        log(`💹 实时行情 #${messageCount}`, {
            symbol: data.s || symbol,
            type: data.type,
            price: currentPrice,
            change: priceChange !== 'N/A' ? `${changeSymbol} ${priceChange}` : 'N/A',
            bid: data.bid,
            ask: data.ask,
            timestamp: new Date(data.t || Date.now()).toISOString(),
        });
        
        // Check if price hits a multiple of 2
        checkPriceLevel(currentPrice);
        
        lastPrice = currentPrice;
    }
}

/**
 * Check if price hits a multiple of 2 and trigger callback
 */
function checkPriceLevel(currentPrice) {
    // Take integer part only
    const integerPrice = Math.floor(currentPrice);
    
    // Check if integer price is a multiple of 2
    const isMultipleOf2 = integerPrice % 2 === 0;
    
    if (!isMultipleOf2) {
        return;
    }
    
    // Calculate which multiple of 2 we're at
    const currentLevel = integerPrice;
    
    // Only trigger if this is a different level than the last one
    if (currentLevel !== lastTriggeredLevel) {
        lastTriggeredLevel = currentLevel;
        onPriceLevelHit(currentPrice, currentLevel);
    }
}

/**
 * Callback when price hits a multiple of 2
 */
async function onPriceLevelHit(currentPrice, level) {
    log(`🎯 价格触发！当前价格: $${currentPrice}, 整数部分: $${level} (2的倍数)`);
    
    try {
        // Fetch last 5 hours of k-line data and draw chart
        await fetchAndDrawKline(level);
    } catch (error) {
        log('✗ 绘制 K 线图失败', { error: error.message });
    }
}

/**
 * Fetch last 5 hours k-line data from TwelveData
 */
async function fetchLast5HoursKline() {
    const twelveToken = process.env.TWELVE_TOKEN;
    const twelveSymbol = process.env.TWELVE_SYMBOL || 'XAU/USD';
    
    if (!twelveToken) {
        throw new Error('未设置 TWELVE_TOKEN 环境变量');
    }
    
    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', twelveSymbol);
    url.searchParams.set('interval', '1min');
    url.searchParams.set('outputsize', '300'); // 5 hours * 60 minutes
    url.searchParams.set('apikey', twelveToken);
    
    const response = await fetch(url.toString(), {
        headers: {
            'User-Agent': 'gold-tracker-wss/1.0',
        },
    });
    
    if (!response.ok) {
        throw new Error(`TwelveData API 错误: ${response.status} ${response.statusText}`);
    }
    
    const payload = await response.json();
    
    if (!payload.values || !Array.isArray(payload.values)) {
        throw new Error('无效的 K 线数据响应');
    }
    
    // Parse and reverse to chronological order
    const bars = payload.values.map(bar => ({
        timestamp: bar.datetime,
        open: parseFloat(bar.open),
        high: parseFloat(bar.high),
        low: parseFloat(bar.low),
        close: parseFloat(bar.close),
        volume: parseFloat(bar.volume || 0),
    })).reverse();
    
    return bars;
}

/**
 * Draw k-line chart and save to file
 */
async function fetchAndDrawKline(triggerLevel) {
    log('📊 正在获取最近 5 小时 K 线数据...');
    
    const bars = await fetchLast5HoursKline();
    log(`✓ 获取到 ${bars.length} 条 K 线数据`);
    
    drawAndSaveKline(bars, triggerLevel);
}

/**
 * Draw k-line chart using Canvas
 */
function drawAndSaveKline(bars, triggerLevel) {
    const width = 1200;
    const height = 600;
    const padding = { top: 60, right: 80, bottom: 80, left: 80 };
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // Background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    
    // Title
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`黄金现货 K 线图 (触发价格: $${triggerLevel})`, width / 2, 35);
    
    // Time range info
    ctx.font = '14px Arial';
    ctx.fillStyle = '#666666';
    const startTime = new Date(bars[0].timestamp).toLocaleString('zh-CN');
    const endTime = new Date(bars[bars.length - 1].timestamp).toLocaleString('zh-CN');
    ctx.fillText(`${startTime} 至 ${endTime}`, width / 2, 55);
    
    // Calculate price range
    const prices = bars.flatMap(bar => [bar.high, bar.low]);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice;
    
    // Chart area
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    
    // Draw grid
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    
    // Horizontal grid lines (price)
    const priceSteps = 5;
    for (let i = 0; i <= priceSteps; i++) {
        const price = minPrice + (priceRange * i / priceSteps);
        const y = padding.top + chartHeight - (chartHeight * i / priceSteps);
        
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
        
        // Price labels
        ctx.fillStyle = '#666666';
        ctx.font = '12px Arial';
        ctx.textAlign = 'right';
        ctx.fillText(price.toFixed(2), padding.left - 10, y + 4);
    }
    
    // Vertical grid lines (time)
    const timeSteps = 5;
    for (let i = 0; i <= timeSteps; i++) {
        const x = padding.left + (chartWidth * i / timeSteps);
        
        ctx.beginPath();
        ctx.moveTo(x, padding.top);
        ctx.lineTo(x, height - padding.bottom);
        ctx.stroke();
        
        // Time labels
        const barIndex = Math.floor((bars.length - 1) * i / timeSteps);
        const time = new Date(bars[barIndex].timestamp);
        const timeLabel = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
        
        ctx.fillStyle = '#666666';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(timeLabel, x, height - padding.bottom + 20);
    }
    
    // Draw candlesticks
    const barWidth = chartWidth / bars.length;
    const candleWidth = Math.max(2, barWidth * 0.6);
    
    bars.forEach((bar, index) => {
        const x = padding.left + (index * barWidth) + (barWidth / 2);
        
        // Calculate Y positions
        const openY = padding.top + chartHeight - ((bar.open - minPrice) / priceRange * chartHeight);
        const closeY = padding.top + chartHeight - ((bar.close - minPrice) / priceRange * chartHeight);
        const highY = padding.top + chartHeight - ((bar.high - minPrice) / priceRange * chartHeight);
        const lowY = padding.top + chartHeight - ((bar.low - minPrice) / priceRange * chartHeight);
        
        // Determine color
        const isUp = bar.close >= bar.open;
        ctx.fillStyle = isUp ? '#26a69a' : '#ef5350';
        ctx.strokeStyle = isUp ? '#26a69a' : '#ef5350';
        
        // Draw wick (high-low line)
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();
        
        // Draw body (open-close rectangle)
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.abs(closeY - openY) || 1;
        ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    });
    
    // Draw trigger level line
    if (triggerLevel >= minPrice && triggerLevel <= maxPrice) {
        const triggerY = padding.top + chartHeight - ((triggerLevel - minPrice) / priceRange * chartHeight);
        
        ctx.strokeStyle = '#ff6b00';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 5]);
        ctx.beginPath();
        ctx.moveTo(padding.left, triggerY);
        ctx.lineTo(width - padding.right, triggerY);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Label
        ctx.fillStyle = '#ff6b00';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'left';
        ctx.fillText(`触发价: $${triggerLevel}`, width - padding.right + 5, triggerY + 5);
    }
    
    // Save to file
    const timestampSuffix = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const pngFilename = `kline-trigger-${triggerLevel}-${timestampSuffix}.png`;
    const chartsDir = path.join(__dirname, 'output', 'charts');
    
    if (!fs.existsSync(chartsDir)) {
        fs.mkdirSync(chartsDir, { recursive: true });
    }
    
    const outputPath = path.join(chartsDir, pngFilename);
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
    
    log(`✓ K 线图已保存: ${outputPath}`);
}

// Graceful shutdown
process.on('SIGINT', () => {
    log('\n收到退出信号，正在关闭连接...');
    if (ws) {
        ws.close();
    }
    stopHeartbeat();
    if (idleTimer) {
        clearTimeout(idleTimer);
    }
    log(`会话统计: 共接收 ${messageCount} 条消息`);
    process.exit(0);
});

// Start connection
log('=== iTick 现货价格监控启动 ===');
log(`监控品种: ${symbol}`);
log(`WebSocket: ${wsUrl}`);
log('');
connect();
