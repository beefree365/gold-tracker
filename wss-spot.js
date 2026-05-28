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
const token = process.env.FINNHUB_TOKEN;
const symbol = process.env.SPOT_SYMBOL || 'OANDA:XAU_USD'; // Default to gold spot
const reconnectDelay = Number(process.env.FINNHUB_RECONNECT_DELAY_MS || 3000);
const wsUrl = process.env.FINNHUB_WS_URL || `wss://ws.finnhub.io?token=${token}`;
const displayWsUrl = wsUrl.replace(/token=[^&]+/i, 'token=***');

if (!token) {
    console.error('请先设置 FINNHUB_TOKEN 环境变量');
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
const MAX_RECONNECT_ATTEMPTS = 10; // Maximum reconnection attempts
const MIN_RECONNECT_INTERVAL = 30000; // Minimum 30 seconds between reconnects to avoid rate limiting
const HEARTBEAT_INTERVAL = 30000; // Send ping every 30 seconds to keep connection alive
const MAX_IDLE_TIME = 120000; // Consider connection dead if no messages for 2 minutes

function log(message, extra) {
    const timestamp = new Date().toISOString();
    const payload = extra ? ` ${JSON.stringify(extra)}` : '';
    console.log(`[${timestamp}] ${message}${payload}`);
}

/**
 * Calculate exponential backoff delay with jitter
 * @param {number} attempt - Current attempt number
 * @returns {number} Delay in milliseconds
 */
function calculateBackoffDelay(attempt) {
    // Base delay: 3s, 6s, 12s, 24s, 48s... (capped at 5 minutes)
    const baseDelay = Math.min(3000 * Math.pow(2, attempt - 1), 300000);
    
    // Add jitter (±25%) to prevent thundering herd
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    
    return Math.floor(baseDelay + jitter);
}

/**
 * Start heartbeat timer to keep connection alive
 * Note: Finnhub doesn't support standard ping/pong, so we use application-level heartbeat
 */
function startHeartbeat() {
    stopHeartbeat(); // Clear any existing timer
    
    heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            // Send a lightweight message to keep connection alive
            // Finnhub may not respond to this, but it keeps the TCP connection active
            try {
                // Option 1: Re-subscribe (safe, idempotent)
                ws.send(JSON.stringify({
                    type: 'subscribe',
                    symbol: symbol,
                }));
                log('💓 发送应用层心跳（重新订阅）');
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
 * Reset idle timer - called on each message received
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

function subscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    ws.send(JSON.stringify({
        type: 'subscribe',
        symbol: symbol,
    }));

    log(`✓ 已订阅现货品种: ${symbol}`);
}

function connect() {
    if (isConnecting) {
        return;
    }

    isConnecting = true;
    log(`正在连接现货 WebSocket: ${displayWsUrl}`);
    
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        isConnecting = false;
        reconnectAttempts = 0; // Reset counter on successful connection
        connectionStartTime = Date.now();
        log('✓ WebSocket 连接成功');
        
        // Subscribe immediately
        subscribe();
        
        // Start heartbeat (application-level)
        startHeartbeat();
        
        // Log connection details for debugging
        log('📋 连接详情', {
            url: displayWsUrl,
            symbol: symbol,
            readyState: ws.readyState
        });
    });

    ws.on('message', (raw) => {
        try {
            const message = JSON.parse(raw.toString());
            
            // Log pong responses (if server sends them)
            if (message.type === 'pong') {
                log('💚 收到服务器 pong 响应');
                return;
            }
            
            handleMessage(message);
            resetIdleTimer(); // Reset idle timer on each message
        } catch (error) {
            log('✗ 解析消息失败', { error: error.message, raw: raw.toString().substring(0, 200) });
        }
    });

    ws.on('error', (error) => {
        log('✗ WebSocket 错误', { error: error.message });
        
        // Check if it's a rate limit error (429)
        if (error.message && error.message.includes('429')) {
            log('⚠️  检测到速率限制 (429)，延长重连间隔至 60 秒');
        }
    });

    ws.on('close', (code, reason) => {
        isConnecting = false;
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
        
        // Exponential backoff with jitter
        let actualDelay = calculateBackoffDelay(reconnectAttempts);
        
        // Enforce minimum interval between reconnects to avoid rate limiting
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
    if (message.type === 'trade') {
        const trade = message.data?.[0];
        if (!trade) {
            return;
        }

        messageCount++;
        const currentPrice = Number(trade.p);
        const priceChange = lastPrice ? (currentPrice - lastPrice).toFixed(2) : 'N/A';
        const changeSymbol = lastPrice ? (currentPrice >= lastPrice ? '↑' : '↓') : '';
        
        log(`💹 实时交易数据 #${messageCount}`, {
            symbol: trade.s,
            price: currentPrice,
            change: priceChange !== 'N/A' ? `${changeSymbol} ${priceChange}` : 'N/A',
            volume: trade.v,
            timestamp: new Date(trade.t).toISOString(),
        });
        
        // Check if price hits a multiple of 2
        checkPriceLevel(currentPrice);
        
        lastPrice = currentPrice;
        return;
    }

    if (message.type === 'quote') {
        const quote = message.data?.[0];
        if (!quote) {
            return;
        }

        messageCount++;
        const currentPrice = Number(quote.p);
        const priceChange = lastPrice ? (currentPrice - lastPrice).toFixed(2) : 'N/A';
        const changeSymbol = lastPrice ? (currentPrice >= lastPrice ? '↑' : '↓') : '';
        
        log(`📊 实时报价数据 #${messageCount}`, {
            symbol: quote.s,
            price: currentPrice,
            change: priceChange !== 'N/A' ? `${changeSymbol} ${priceChange}` : 'N/A',
            bid: quote.b,
            ask: quote.a,
            high: quote.h,
            low: quote.l,
            timestamp: new Date(quote.t).toISOString(),
        });
        
        // Check if price hits a multiple of 2
        checkPriceLevel(currentPrice);
        
        lastPrice = currentPrice;
        return;
    }

    if (message.type === 'ping') {
        // Ignore ping messages
        return;
    }

    if (message.type === 'error') {
        log('✗ 服务端返回错误', message);
        return;
    }

    log('⚠️ 收到未知消息类型', { type: message.type });
}

/**
 * Check if price hits a multiple of 2 and trigger callback
 * @param {number} currentPrice - Current price value
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
 * Fetch last 5 hours of minute k-line data from TwelveData
 * @returns {Array} Array of k-line bars
 */
async function fetchLast5HoursKline() {
    const token = process.env.TWELVE_TOKEN;
    const symbol = process.env.TWELVE_SYMBOL || 'XAU/USD';
    
    if (!token) {
        log('✗ TWELVE_TOKEN not set, cannot fetch k-line data');
        return null;
    }
    
    try {
        log('Fetching last 5 hours of k-line data...');
        
        const url = new URL('https://api.twelvedata.com/time_series');
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('interval', '1min');
        url.searchParams.set('outputsize', '300'); // 5 hours * 60 minutes = 300 bars
        url.searchParams.set('apikey', token);
        
        const response = await fetch(url.toString(), {
            headers: {
                'User-Agent': 'gold-tracker-wss/1.0',
            },
        });
        
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`TwelveData request failed (${response.status}): ${text}`);
        }
        
        const payload = await response.json();
        
        if (!payload || payload.status !== 'ok') {
            throw new Error(`TwelveData request failed: ${JSON.stringify(payload)}`);
        }
        
        if (!Array.isArray(payload.values) || payload.values.length === 0) {
            throw new Error('No k-line data returned');
        }
        
        // Parse and normalize the data
        const bars = payload.values.map(raw => {
            const timestamp = new Date(`${raw.datetime.replace(' ', 'T')}Z`);
            return {
                timestamp: timestamp.toISOString(),
                open: Number(raw.open),
                high: Number(raw.high),
                low: Number(raw.low),
                close: Number(raw.close),
            };
        }).reverse(); // Reverse to get chronological order
        
        log(`✓ Fetched ${bars.length} k-line bars`);
        return bars;
        
    } catch (error) {
        log('✗ Failed to fetch k-line data', { error: error.message });
        return null;
    }
}

/**
 * Draw k-line chart and save to file
 * @param {Array} bars - Array of k-line bars
 * @param {number} triggerPrice - Price that triggered
 * @param {number} triggerLevel - The 5-multiple level
 */
function drawAndSaveKline(bars, triggerPrice, triggerLevel) {
    if (!bars || bars.length === 0) {
        log('✗ No bars to draw');
        return;
    }
    
    const width = 1400;
    const height = 700;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    const padLeft = 96;
    const padRight = 24;
    const padTop = 60;
    const padBottom = 80;
    const chartHeight = height - padTop - padBottom;
    const chartWidth = width - padLeft - padRight;
    
    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);
    
    // Title with trigger info
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(`XAU/USD K-Line (Last 5 Hours)`, padLeft, 30);
    
    ctx.font = '16px sans-serif';
    ctx.fillStyle = '#fbbf24';
    ctx.fillText(`🎯 Triggered at: $${triggerLevel} (Price: $${triggerPrice})`, padLeft, 55);
    
    // Subtitle with time range
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#cbd5e1';
    const startTime = bars[0].timestamp.split('T')[1].slice(0, 5);
    const endTime = bars[bars.length - 1].timestamp.split('T')[1].slice(0, 5);
    ctx.fillText(`${bars.length} bars | ${startTime} - ${endTime} UTC`, padLeft, 78);
    
    // Calculate price range
    const allPrices = bars.flatMap(bar => [bar.open, bar.high, bar.low, bar.close]);
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const span = Math.max(1, maxPrice - minPrice);
    const padding = span * 0.05;
    const plotMin = minPrice - padding;
    const plotMax = maxPrice + padding;
    
    // Draw grid lines
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i += 1) {
        const y = padTop + (chartHeight / 5) * i;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();
        
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '13px sans-serif';
        ctx.fillText((plotMax - ((plotMax - plotMin) / 5) * i).toFixed(2), 12, y + 4);
    }
    
    const candleWidth = Math.max(2, Math.floor(chartWidth / Math.max(bars.length, 1) * 0.55));
    
    // Draw candlesticks
    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i];
        const x = padLeft + i * (chartWidth / Math.max(bars.length - 1, 1));
        const openY = padTop + chartHeight - ((bar.open - plotMin) / (plotMax - plotMin)) * chartHeight;
        const closeY = padTop + chartHeight - ((bar.close - plotMin) / (plotMax - plotMin)) * chartHeight;
        const highY = padTop + chartHeight - ((bar.high - plotMin) / (plotMax - plotMin)) * chartHeight;
        const lowY = padTop + chartHeight - ((bar.low - plotMin) / (plotMax - plotMin)) * chartHeight;
        
        // Determine color based on price movement
        const isUp = bar.close >= bar.open;
        const color = isUp ? '#22c55e' : '#ef4444';
        
        // Wick
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();
        
        // Body
        ctx.fillStyle = color;
        ctx.fillRect(x - candleWidth / 2, Math.min(openY, closeY), candleWidth, Math.max(2, Math.abs(closeY - openY)));
        
        // Time labels (every 60 minutes)
        if (i % 60 === 0) {
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(bar.timestamp.split('T')[1].slice(0, 5), x, height - 20);
        }
    }
    
    // Legend
    ctx.textAlign = 'left';
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(padLeft + 70, 95, 12, 12);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13px sans-serif';
    ctx.fillText('Up', padLeft + 90, 105);
    
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(padLeft + 130, 95, 12, 12);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText('Down', padLeft + 150, 105);
    
    // Save to file
    const chartsDir = path.join(__dirname, 'output', 'charts');
    if (!fs.existsSync(chartsDir)) {
        fs.mkdirSync(chartsDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `kline-trigger-${triggerLevel}-${timestamp}.png`;
    const filepath = path.join(chartsDir, filename);
    
    fs.writeFileSync(filepath, canvas.toBuffer('image/png'));
    log(`💾 K-line chart saved: ${filepath}`);
}

/**
 * Callback function when price hits a multiple of 2
 * @param {number} price - The actual price that triggered
 * @param {number} level - The multiple of 2 level
 */
async function onPriceLevelHit(price, level) {
    log(`🎯 *** 价格触发 2 的倍数: $${level} (实际价格: $${price}) ***`, {
        triggeredAt: new Date().toISOString(),
        priceLevel: level,
        actualPrice: price
    });
    
    // Fetch and draw k-line chart
    const bars = await fetchLast5HoursKline();
    if (bars) {
        drawAndSaveKline(bars, price, level);
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    log('\n收到退出信号，正在关闭连接...');
    
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    if (ws) {
        ws.close();
    }

    log(`会话统计: 共接收 ${messageCount} 条消息`);
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('\n收到终止信号，正在关闭连接...');
    
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    if (ws) {
        ws.close();
    }

    log(`会话统计: 共接收 ${messageCount} 条消息`);
    process.exit(0);
});

// Start the connection
log('=== 黄金现货实时行情监听器 ===');
log(`配置信息:`);
log(`  品种: ${symbol}`);
log(`  重连延迟: ${reconnectDelay}ms`);
log('');

connect();
