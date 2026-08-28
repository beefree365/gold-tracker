require('dotenv').config();

const { WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// Polyfill fetch for Node.js
let fetch;
if (typeof global.fetch === 'undefined') {
    const nodeFetch = require('node-fetch');
    fetch = nodeFetch.default || nodeFetch;
} else {
    fetch = global.fetch;
}

// ---------------- 注册中文字体 (彻底解决 Canvas 中文乱码) ----------------
function initChineseFonts() {
    const candidatePaths = [
        'C:/Windows/Fonts/msyh.ttc',    // Windows 微软雅黑
        'C:/Windows/Fonts/msyhbd.ttc',  // Windows 微软雅黑粗体
        'C:/Windows/Fonts/simhei.ttf',  // Windows 黑体
        'C:/Windows/Fonts/simsun.ttc',  // Windows 宋体
        '/System/Library/Fonts/PingFang.ttc', // macOS 苹方
        '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc' // Linux 文泉驿
    ];

    let registered = false;
    for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
            try {
                GlobalFonts.registerFromPath(p, 'ChineseFont');
                registered = true;
                break;
            } catch (e) {
                // 尝试下一个
            }
        }
    }
    return registered;
}

initChineseFonts();
const FONT_FAMILY = 'ChineseFont, "Microsoft YaHei", "PingFang SC", "SimHei", sans-serif';

// ---------------- 配置参数 ----------------
const WS_URL = 'wss://hq.sinajs.cn/wskt?list=hf_GC';
const DEFAULT_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=219fe697-90f0-4d8b-a14d-412a43447d5e';
const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 30000;

let ws = null;
let reconnectTimer = null;
let pingTimer = null;
let isAlive = false;
let lastPrice = null;
let lastTriggeredLevel = null; // 记录最后触发的 2 的倍数价格水平
let isProcessingTrigger = false; // 防并发保护

function log(msg, data) {
    const time = new Date().toLocaleTimeString();
    if (data) {
        console.log(`[${time}] ${msg}`, JSON.stringify(data));
    } else {
        console.log(`[${time}] ${msg}`);
    }
}

// ---------------- 方案 1: 双锚点时间线性插值对齐算法 ----------------
function alignBarsWithDualAnchor(rawBars, currentFuturesPrice, futuresOpen) {
    if (!rawBars || rawBars.length === 0 || !currentFuturesPrice) return rawBars;

    const count = rawBars.length;
    const latestBar = rawBars[count - 1];
    const latestTs = new Date(latestBar.timestamp).getTime();

    // 1. 终点锚点: 最新实时平滑基差 (平滑最近 3 根蜡烛过滤微观买卖一档跳价毛刺)
    const recentBars = rawBars.slice(-3);
    const smoothedLatestSpot = recentBars.reduce((acc, b) => acc + b.close, 0) / recentBars.length;
    const latestOffset = currentFuturesPrice - smoothedLatestSpot;

    // 2. 起点锚点: 今日开盘基准基差
    const nowUtcDate = new Date().getUTCDate();
    const todayOpenBar = rawBars.find(b => new Date(b.timestamp).getUTCDate() === nowUtcDate) || rawBars[Math.floor(count / 2)];
    const openTs = new Date(todayOpenBar.timestamp).getTime();
    const spotOpen = todayOpenBar.open;

    const openOffset = (futuresOpen && futuresOpen > 0 && spotOpen > 0)
        ? (futuresOpen - spotOpen)
        : latestOffset;

    // 3. 沿 24 小时时间轴执行双锚点动态线性插值平滑
    return rawBars.map(b => {
        const ts = new Date(b.timestamp).getTime();
        let offset;
        if (ts <= openTs) {
            offset = openOffset;
        } else {
            const ratio = (ts - openTs) / Math.max(1, latestTs - openTs);
            offset = openOffset + (latestOffset - openOffset) * ratio;
        }

        return {
            ...b,
            open: b.open + offset,
            high: b.high + offset,
            low: b.low + offset,
            close: b.close + offset
        };
    });
}

// ---------------- 1. 获取 24 小时 5 分钟 K 线数据 (288 根) ----------------
async function fetchLast24Hours5MinKline(currentFuturesPrice, futuresOpen) {
    const MAX_STALE_MS = 15 * 60 * 1000;
    const now = Date.now();
    const statusList = [];

    // 方案 A: 优先级 1 - Massive.com 主力期货合约
    const massiveToken = process.env.MASSIVE_TOKEN;
    const activeFuturesContracts = ['GCZ6', 'GCV6', 'GCQ6'];

    if (massiveToken) {
        let massiveFailureReason = '';
        for (const contract of activeFuturesContracts) {
            try {
                const url = new URL(`https://api.massive.com/futures/v1/aggs/${contract}`);
                url.searchParams.set('resolution', '5min');
                url.searchParams.set('limit', '300');
                url.searchParams.set('sort', 'window_start.desc');

                const res = await fetch(url.toString(), {
                    headers: { Authorization: `Bearer ${massiveToken}` }
                });
                if (res.ok) {
                    const payload = await res.json();
                    if (Array.isArray(payload.results) && payload.results.length > 0) {
                        const latestTs = payload.results[0].window_start > 1e12 
                            ? payload.results[0].window_start / 1e6 
                            : payload.results[0].window_start;
                        
                        if (now - latestTs < MAX_STALE_MS) {
                            const bars = payload.results.map(r => {
                                const ts = typeof r.window_start === 'number'
                                    ? (r.window_start > 1e12 ? r.window_start / 1e6 : r.window_start)
                                    : new Date(r.window_start).getTime();
                                return {
                                    timestamp: new Date(ts).toISOString(),
                                    open: Number(r.open),
                                    high: Number(r.high),
                                    low: Number(r.low),
                                    close: Number(r.close),
                                    volume: Number(r.volume || 0)
                                };
                            }).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

                            statusList.push({ name: `Massive 期货 (${contract})`, status: '✅ 已生效', reason: `获取 ${bars.length} 根原生期货实时 K 线` });
                            statusList.push({ name: 'TwelveData 现货 (XAU/USD)', status: '⏸️ 就绪未用', reason: '前序优先级已命中' });
                            statusList.push({ name: 'Binance PAXG 备用源', status: '⏸️ 就绪未用', reason: '前序优先级已命中' });

                            return { bars, sourceName: `Massive 期货 (${contract})`, statusList };
                        } else {
                            massiveFailureReason = `数据停留在 ${new Date(latestTs).toLocaleTimeString()} (滞后超过15分钟，未实时刷新)`;
                        }
                    }
                } else {
                    massiveFailureReason = `HTTP ${res.status} 响应异常 / 限流`;
                }
            } catch (e) {
                massiveFailureReason = e.message;
            }
        }
        statusList.push({ name: 'Massive 期货 (GCZ6/GCV6)', status: '❌ 未生效', reason: massiveFailureReason || '无实时数据' });
    } else {
        statusList.push({ name: 'Massive 期货', status: '❌ 未生效', reason: '未配置 MASSIVE_TOKEN' });
    }

    // 方案 B: 优先级 2 - TwelveData 现货 5分钟 K 线
    const twelveToken = process.env.TWELVE_TOKEN;
    if (twelveToken) {
        try {
            const url = new URL('https://api.twelvedata.com/time_series');
            url.searchParams.set('symbol', 'XAU/USD');
            url.searchParams.set('interval', '5min');
            url.searchParams.set('outputsize', '288');
            url.searchParams.set('apikey', twelveToken);

            const res = await fetch(url.toString());
            if (res.ok) {
                const payload = await res.json();
                if (Array.isArray(payload.values) && payload.values.length > 0) {
                    const rawBars = payload.values.map(r => ({
                        timestamp: new Date(`${r.datetime.replace(' ', 'T')}Z`).toISOString(),
                        open: Number(r.open),
                        high: Number(r.high),
                        low: Number(r.low),
                        close: Number(r.close),
                        volume: 0
                    })).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

                    // 双锚点平滑线性插值对齐
                    const bars = alignBarsWithDualAnchor(rawBars, currentFuturesPrice, futuresOpen);

                    statusList.push({ name: 'TwelveData 现货 (XAU/USD)', status: '✅ 已生效', reason: `获取 ${bars.length} 根连续K线 (双锚点时间线性插值对齐)` });
                    statusList.push({ name: 'Binance PAXG 备用源', status: '⏸️ 就绪未用', reason: '前序源正常，无需启用' });

                    return { bars, sourceName: 'TwelveData 现货 (双锚点线性插值对齐)', statusList };
                }
            }
            statusList.push({ name: 'TwelveData 现货 (XAU/USD)', status: '❌ 未生效', reason: '接口返回数据为空或报错' });
        } catch (e) {
            statusList.push({ name: 'TwelveData 现货 (XAU/USD)', status: '❌ 未生效', reason: e.message });
        }
    } else {
        statusList.push({ name: 'TwelveData 现货', status: '❌ 未生效', reason: '未配置 TWELVE_TOKEN' });
    }

    // 方案 C: 优先级 3 - 币安 PAXG/USDT 5分钟 K 线 (24/7 全天候保底)
    try {
        const res = await fetch('https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=5m&limit=288');
        if (res.ok) {
            const list = await res.json();
            const rawBars = list.map(item => ({
                timestamp: new Date(item[0]).toISOString(),
                open: Number(item[1]),
                high: Number(item[2]),
                low: Number(item[3]),
                close: Number(item[4]),
                volume: Number(item[5])
            }));

            // 双锚点平滑线性插值对齐
            const bars = alignBarsWithDualAnchor(rawBars, currentFuturesPrice, futuresOpen);

            statusList.push({ name: 'Binance PAXG 备用源', status: '✅ 已生效', reason: `获取 ${bars.length} 根 24/7 连续K线 (双锚点时间线性插值对齐)` });
            return { bars, sourceName: '币安 PAXG (双锚点线性插值对齐)', statusList };
        }
        statusList.push({ name: 'Binance PAXG 备用源', status: '❌ 未生效', reason: '币安接口请求失败' });
    } catch (e) {
        statusList.push({ name: 'Binance PAXG 备用源', status: '❌ 未生效', reason: e.message });
    }

    return { bars: null, sourceName: '无可用数据源', statusList };
}

// ---------------- 2. 绘制高质量 24 小时 5分钟 K 线图 ----------------
function drawKlineChart(bars, triggerPrice, triggerLevel, sourceName) {
    const width = 1800;
    const height = 850;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const padLeft = 100;
    const padRight = 80;
    const padTop = 80;
    const padBottom = 80;
    const chartHeight = height - padTop - padBottom;
    const chartWidth = width - padLeft - padRight;

    // 1. 亮色背景 (白色主画布 + 极简浅灰绘图区)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(padLeft, padTop, chartWidth, chartHeight);

    // 2. 顶部标题与触发信息 (加载注册的中文字体)
    ctx.fillStyle = '#0f172a';
    ctx.font = `bold 26px ${FONT_FAMILY}`;
    ctx.fillText('COMEX 黄金期货 24小时 5分钟 K线图', padLeft, 38);

    ctx.font = `14px ${FONT_FAMILY}`;
    ctx.fillStyle = '#64748b';
    ctx.fillText(`📊 走势数据源: ${sourceName || '多源智能对齐'}`, padLeft + 480, 38);

    ctx.font = `16px ${FONT_FAMILY}`;
    ctx.fillStyle = '#d97706'; // 高对比度琥珀金
    ctx.fillText(`🎯 触发价格: $${triggerPrice.toFixed(2)} | 触发水平: $${triggerLevel} (2的倍数)`, padLeft, 68);

    const firstBar = bars[0];
    const lastBar = bars[bars.length - 1];
    const formatTime = (ts) => new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    ctx.font = `14px ${FONT_FAMILY}`;
    ctx.fillStyle = '#64748b';
    ctx.fillText(`时间跨度: ${formatTime(firstBar.timestamp)}  ➜  ${formatTime(lastBar.timestamp)}  (共 ${bars.length} 根K线)`, padLeft + 620, 68);

    // 3. 计算价格极值范围
    const allPrices = bars.flatMap(b => [b.open, b.high, b.low, b.close, triggerPrice]);
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const span = Math.max(1, maxPrice - minPrice);
    const padding = span * 0.06;
    const plotMin = minPrice - padding;
    const plotMax = maxPrice + padding;

    const priceToY = (p) => padTop + chartHeight - ((p - plotMin) / (plotMax - plotMin)) * chartHeight;

    // 4. 绘制水平网格与 Y 轴刻度
    const gridCount = 6;
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= gridCount; i++) {
        const y = padTop + (chartHeight / gridCount) * i;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();

        const priceLabel = (plotMax - ((plotMax - plotMin) / gridCount) * i).toFixed(2);
        ctx.fillStyle = '#475569';
        ctx.font = `12px ${FONT_FAMILY}`;
        ctx.textAlign = 'right';
        ctx.fillText(`$${priceLabel}`, padLeft - 12, y + 4);
    }

    // 绘制图表外边框
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, padTop, chartWidth, chartHeight);

    // 5. 绘制触发价格水平线（金色虚线）
    const triggerY = priceToY(triggerPrice);
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(padLeft, triggerY);
    ctx.lineTo(width - padRight, triggerY);
    ctx.stroke();
    ctx.setLineDash([]); // 恢复实线

    // 触发线右侧价格标签
    ctx.fillStyle = '#d97706';
    ctx.fillRect(width - padRight + 6, triggerY - 11, 70, 22);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 12px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(`$${triggerPrice.toFixed(2)}`, width - padRight + 12, triggerY + 4);

    // 6. 绘制 K 线蜡烛图 (5分钟K线约 288 根，每根更清晰)
    const count = bars.length;
    const candleWidth = Math.max(2, (chartWidth / count) * 0.72);
    const labelStep = Math.max(1, Math.floor(count / 12)); // 时间标签间隔 (约每 2 小时一标)

    for (let i = 0; i < count; i++) {
        const bar = bars[i];
        const x = padLeft + (i + 0.5) * (chartWidth / count);
        const openY = priceToY(bar.open);
        const closeY = priceToY(bar.close);
        const highY = priceToY(bar.high);
        const lowY = priceToY(bar.low);

        const isUp = bar.close >= bar.open;
        const color = isUp ? '#16a34a' : '#dc2626';

        // 影线
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        // 实体
        ctx.fillStyle = color;
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
        ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);

        // 时间轴刻度线与标签
        if (i % labelStep === 0 || i === count - 1) {
            ctx.strokeStyle = '#94a3b8';
            ctx.beginPath();
            ctx.moveTo(x, padTop + chartHeight);
            ctx.lineTo(x, padTop + chartHeight + 6);
            ctx.stroke();

            const timeStr = new Date(bar.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
            ctx.fillStyle = '#475569';
            ctx.font = `11px ${FONT_FAMILY}`;
            ctx.textAlign = 'center';
            ctx.fillText(timeStr, x, height - 55);
        }
    }

    // 7. 底部图例
    ctx.textAlign = 'left';
    ctx.fillStyle = '#16a34a';
    ctx.fillRect(padLeft, height - 30, 12, 12);
    ctx.fillStyle = '#334155';
    ctx.font = `13px ${FONT_FAMILY}`;
    ctx.fillText('上涨 (Up)', padLeft + 18, height - 20);

    ctx.fillStyle = '#dc2626';
    ctx.fillRect(padLeft + 120, height - 30, 12, 12);
    ctx.fillStyle = '#334155';
    ctx.fillText('下跌 (Down)', padLeft + 138, height - 20);

    ctx.fillStyle = '#d97706';
    ctx.fillRect(padLeft + 240, height - 30, 20, 3);
    ctx.fillStyle = '#334155';
    ctx.fillText(`触发水平线 ($${triggerLevel})`, padLeft + 268, height - 20);

    return canvas.toBuffer('image/png');
}

// ---------------- 3. 推送企业微信 Webhook ----------------
async function sendToWeCom({ price, level, open, high, low, timeStr, imageBuffer, sourceName, statusList }) {
    if (!WECOM_WEBHOOK_URL) {
        log('⚠️ 未配置 WECOM_WEBHOOK_URL，跳过企业微信推送');
        return;
    }

    try {
        log('📤 正在向企业微信机器人推送消息...');

        const change = open > 0 ? (((price - open) / open) * 100).toFixed(2) : '0.00';
        const changeSign = change >= 0 ? '+' : '';
        const trendEmoji = price >= open ? '📈' : '📉';

        // 状态摘要行
        const sourceLines = (statusList || []).map(s => `> - ${s.status} **${s.name}**: ${s.reason}`).join('\n');

        // 1. 发送 Markdown 卡片消息
        const markdownContent = [
            `### 🔔 COMEX 黄金期货价格触发提醒 ${trendEmoji}`,
            `> **触发价格**：<font color="warning">**$${price.toFixed(2)}**</font>`,
            `> **触发水平**：**$${level}** (2的倍数)`,
            `> **行情时间**：${timeStr}`,
            `> **今日开盘**：$${open.toFixed(2)} (涨跌: ${changeSign}${change}%)`,
            `> **今日区间**：$${low.toFixed(2)} ~ $${high.toFixed(2)}`,
            `> **走势数据源**：<font color="info">${sourceName || '多源智能对齐'}</font>`,
            `> **数据源状态**：\n${sourceLines}`,
            `> **K线图表**：已生成最近 24 小时 5 分钟走势图 (如下)`
        ].join('\n');

        const textRes = await fetch(WECOM_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                msgtype: 'markdown',
                markdown: { content: markdownContent }
            })
        });
        const textJson = await textRes.json();
        log('✓ 企微文字消息已发送:', textJson);

        // 2. 发送图片消息 (base64 + md5)
        if (imageBuffer) {
            const md5 = crypto.createHash('md5').update(imageBuffer).digest('hex');
            const base64 = imageBuffer.toString('base64');

            const imgRes = await fetch(WECOM_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    msgtype: 'image',
                    image: { base64, md5 }
                })
            });
            const imgJson = await imgRes.json();
            log('✓ 企微 K 线图片已发送:', imgJson);
        }
    } catch (err) {
        log('❌ 企业微信推送失败:', err.message);
    }
}

// ---------------- 4. 价格 2 的倍数触发处理逻辑 ----------------
async function checkPriceLevel(currentPrice, open, high, low, timeStr) {
    const integerPrice = Math.floor(currentPrice);

    // 判断整数部分是否为 2 的倍数
    if (integerPrice % 2 !== 0) {
        return;
    }

    const currentLevel = integerPrice;

    // 同一水平不重复触发
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

        // 1. 获取 24 小时 5分钟 K 线 (双锚点时间线性插值)
        const { bars, sourceName, statusList } = await fetchLast24Hours5MinKline(currentPrice, open);
        let imageBuffer = null;

        // 打印 3 个数据源的生效/未生效健康检查清单
        console.log('\n┌────────────────────────────── 数据源状态排查 ──────────────────────────────┐');
        for (const item of (statusList || [])) {
            console.log(`│ [${item.status}] ${item.name.padEnd(28)} : ${item.reason}`);
        }
        console.log('└────────────────────────────────────────────────────────────────────────────┘\n');

        if (bars && bars.length > 0) {
            // 2. 绘制 5分钟 K 线图 (纯内存 Buffer，不写入本地磁盘)
            imageBuffer = drawKlineChart(bars, currentPrice, currentLevel, sourceName);
        } else {
            log('⚠️ 未获取到 K 线数据，将仅推送文字消息');
        }

        // 3. 推送企业微信
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

// ---------------- 5. WebSocket 连接与行情监听 ----------------
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
        log('✅ 成功连接到 COMEX 纽约黄金期货实时行情流！');
        log(`📢 企业微信推送 Webhook 已配置: ${WECOM_WEBHOOK_URL.slice(0, 50)}...`);
        console.log('\n---------------------------------------------------------------------------------------------------------------');
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

    ws.on('message', async (data) => {
        try {
                if (lastPrice !== null) {
                    if (price > lastPrice) trend = '🔺';
                    else if (price < lastPrice) trend = '🔻';
                }
                lastPrice = price;

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

                // 触发 2 的倍数检测与自动绘图推送
                checkPriceLevel(price, open, high, low, timeStr);
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
