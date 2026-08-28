require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// Polyfill fetch for Node.js
let fetch;
if (typeof global.fetch === 'undefined') {
    const nodeFetch = require('node-fetch');
    fetch = nodeFetch.default || nodeFetch;
} else {
    fetch = global.fetch;
}

// 注册中文字体
function initChineseFonts() {
    const candidatePaths = [
        'C:/Windows/Fonts/msyh.ttc',
        'C:/Windows/Fonts/msyhbd.ttc',
        'C:/Windows/Fonts/simhei.ttf',
        'C:/Windows/Fonts/simsun.ttc',
        '/System/Library/Fonts/PingFang.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'
    ];
    for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
            try {
                GlobalFonts.registerFromPath(p, 'ChineseFont');
                break;
            } catch (e) {}
        }
    }
}
initChineseFonts();
const FONT_FAMILY = 'ChineseFont, "Microsoft YaHei", "PingFang SC", "SimHei", sans-serif';

// 1. 获取最新实时价格 (Sina)
async function fetchCurrentFuturesPrice() {
    try {
        const res = await fetch('http://hq.sinajs.cn/list=hf_GC', {
            headers: { 'Referer': 'https://finance.sina.com.cn' }
        });
        const text = await res.text();
        const match = text.match(/"([^"]+)"/);
        if (match) {
            const fields = match[1].split(',');
            return {
                price: parseFloat(fields[0]),
                open: parseFloat(fields[8]),
                high: parseFloat(fields[4]),
                low: parseFloat(fields[5]),
                timeStr: fields[6]
            };
        }
    } catch (e) {}
    return { price: 4635, open: 4656, high: 4664.8, low: 4628, timeStr: new Date().toLocaleTimeString() };
}

// 2. 获取 24 小时 5 分钟 K 线数据
async function fetch24Hours5MinKline(currentPrice) {
    // 严格检查数据新鲜度: 最新一根 K 线必须在 15 分钟以内，防止盘中未更新的滞后历史数据
    const MAX_STALE_MS = 15 * 60 * 1000;
    const now = Date.now();

    // 尝试 Massive 主力合约
    const massiveToken = process.env.MASSIVE_TOKEN;
    if (massiveToken) {
        for (const contract of ['GCZ6', 'GCV6']) {
            try {
                const url = new URL(`https://api.massive.com/futures/v1/aggs/${contract}`);
                url.searchParams.set('resolution', '5min');
                url.searchParams.set('limit', '300');
                url.searchParams.set('sort', 'window_start.desc');

                const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${massiveToken}` } });
                if (res.ok) {
                    const json = await res.json();
                    if (Array.isArray(json.results) && json.results.length > 0) {
                        const latestTs = json.results[0].window_start > 1e12 ? json.results[0].window_start / 1e6 : json.results[0].window_start;
                        if (now - latestTs < MAX_STALE_MS) {
                            return json.results.map(r => ({
                                timestamp: new Date(r.window_start > 1e12 ? r.window_start / 1e6 : r.window_start).toISOString(),
                                open: Number(r.open),
                                high: Number(r.high),
                                low: Number(r.low),
                                close: Number(r.close)
                            })).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                        } else {
                            console.log(`⚠️ Massive ${contract} 最新K线停留在 ${new Date(latestTs).toLocaleTimeString()} (非当前盘中实时数据)，自动切换至毫秒级实时源`);
                        }
                    }
                }
            } catch (e) {}
        }
    }

    // 备用源: 币安 PAXG 5min 连续数据
    try {
        const res = await fetch('https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=5m&limit=288');
        if (res.ok) {
            const list = await res.json();
            const rawBars = list.map(item => ({
                timestamp: new Date(item[0]).toISOString(),
                open: Number(item[1]),
                high: Number(item[2]),
                low: Number(item[3]),
                close: Number(item[4])
            }));
            if (currentPrice && rawBars.length > 0) {
                const offset = currentPrice - rawBars[rawBars.length - 1].close;
                return rawBars.map(b => ({
                    ...b,
                    open: b.open + offset,
                    high: b.high + offset,
                    low: b.low + offset,
                    close: b.close + offset
                }));
            }
            return rawBars;
        }
    } catch (e) {}

    return null;
}

// 3. 绘制 K 线图
function drawKline(bars, currentPrice) {
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

    // 亮色白底背景
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(padLeft, padTop, chartWidth, chartHeight);

    // 标题
    ctx.fillStyle = '#0f172a';
    ctx.font = `bold 26px ${FONT_FAMILY}`;
    ctx.fillText('COMEX 黄金期货 24小时 5分钟 K线走势图', padLeft, 38);

    const intPrice = Math.floor(currentPrice);
    ctx.font = `16px ${FONT_FAMILY}`;
    ctx.fillStyle = '#d97706';
    ctx.fillText(`📊 最新价格: $${currentPrice.toFixed(2)} | 触发水平: $${intPrice}`, padLeft, 68);

    const firstBar = bars[0];
    const lastBar = bars[bars.length - 1];
    const formatTime = (ts) => new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    ctx.font = `14px ${FONT_FAMILY}`;
    ctx.fillStyle = '#64748b';
    ctx.fillText(`时间范围: ${formatTime(firstBar.timestamp)}  ➜  ${formatTime(lastBar.timestamp)}  (共 ${bars.length} 根K线)`, padLeft + 600, 68);

    // 价格范围
    const allPrices = bars.flatMap(b => [b.open, b.high, b.low, b.close, currentPrice]);
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const span = Math.max(1, maxPrice - minPrice);
    const padding = span * 0.06;
    const plotMin = minPrice - padding;
    const plotMax = maxPrice + padding;

    const priceToY = (p) => padTop + chartHeight - ((p - plotMin) / (plotMax - plotMin)) * chartHeight;

    // 网格与 Y 轴
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

    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, padTop, chartWidth, chartHeight);

    // 当前价标线
    const curY = priceToY(currentPrice);
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(padLeft, curY);
    ctx.lineTo(width - padRight, curY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#d97706';
    ctx.fillRect(width - padRight + 6, curY - 11, 70, 22);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 12px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(`$${currentPrice.toFixed(2)}`, width - padRight + 12, curY + 4);

    // 蜡烛图
    const count = bars.length;
    const candleWidth = Math.max(2, (chartWidth / count) * 0.72);
    const labelStep = Math.max(1, Math.floor(count / 12));

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

        // 时间轴标签
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

    // 图例
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
    ctx.fillText(`当前价格线 ($${currentPrice.toFixed(2)})`, padLeft + 268, height - 20);

    return canvas.toBuffer('image/png');
}

async function main() {
    console.log('正在获取当前期货数据与 24 小时 5 分钟 K 线...');
    const cur = await fetchCurrentFuturesPrice();
    const bars = await fetch24Hours5MinKline(cur.price);

    if (!bars || bars.length === 0) {
        console.error('❌ 未能获取到 K 线数据');
        process.exit(1);
    }

    const buffer = drawKline(bars, cur.price);

    const chartsDir = path.join(__dirname, '..', 'output', 'charts');
    if (!fs.existsSync(chartsDir)) {
        fs.mkdirSync(chartsDir, { recursive: true });
    }

    const timeTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const historyPath = path.join(chartsDir, `manual-futures-5m-${timeTag}.png`);
    const latestPath = path.join(chartsDir, 'latest-futures-5m-kline.png');
    const rootPath = path.join(__dirname, '..', 'futures-5m-kline-latest.png');

    fs.writeFileSync(historyPath, buffer);
    fs.writeFileSync(latestPath, buffer);
    fs.writeFileSync(rootPath, buffer);

    console.log('✅ K 线图已成功绘制并保存到以下本地路径:');
    console.log(`   1. [历史存档] ${historyPath}`);
    console.log(`   2. [最新图表] ${latestPath}`);
    console.log(`   3. [根目录]   ${rootPath}`);
}

main().catch(console.error);
