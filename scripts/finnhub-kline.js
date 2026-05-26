require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');
const { createCanvas } = require('@napi-rs/canvas');

const OUTPUT_PATH = path.join(__dirname, '..', 'finnhub-minute-kline.png');
const DEFAULT_SYMBOL = 'OANDA:XAU_USD';
const DEFAULT_MAX_WAIT_MS = 15000;
const DEFAULT_MIN_BARS = 1;
const DEFAULT_RECONNECT_DELAY_MS = 3000;

function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing environment variable: ${name}`);
    }
    return value;
}

function getEnvOrDefault(name, fallback) {
    return process.env[name] || fallback;
}

function formatTimestamp(value) {
    const date = new Date(value);
    return date.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function minuteBucket(timestamp) {
    const utcMillis = new Date(Number(timestamp)).getTime();
    return new Date(Math.floor(utcMillis / 60000) * 60000).toISOString();
}

function priceToY(price, minPrice, maxPrice, top, height) {
    const span = maxPrice - minPrice;
    if (span === 0) {
        return top + height / 2;
    }
    return top + height - ((price - minPrice) / span) * height;
}

function drawChart(bars) {
    const width = 1400;
    const height = 860;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const padLeft = 96;
    const padRight = 24;
    const padTop = 46;
    const padBottom = 180;
    const chartHeight = height - padTop - padBottom;
    const volumeHeight = 120;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(`Finnhub 1-Minute K-Line (${bars.length} bars)`, padLeft, 30);

    const firstTs = bars[0].window_start;
    const lastTs = bars[bars.length - 1].window_start;
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`From ${formatTimestamp(firstTs)} to ${formatTimestamp(lastTs)}`, padLeft, 62);

    const lows = bars.map((bar) => Number(bar.low));
    const highs = bars.map((bar) => Number(bar.high));
    const minPrice = Math.min(...lows);
    const maxPrice = Math.max(...highs);
    const priceSpan = maxPrice - minPrice || 1;
    const pricePadding = priceSpan * 0.04;
    const plotMin = minPrice - pricePadding;
    const plotMax = maxPrice + pricePadding;

    const volumes = bars.map((bar) => Number(bar.volume));
    const maxVolume = Math.max(...volumes);

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;

    for (let i = 0; i <= 5; i += 1) {
        const y = padTop + (chartHeight / 5) * i;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();

        const value = plotMax - ((plotMax - plotMin) / 5) * i;
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '13px sans-serif';
        ctx.fillText(value.toFixed(2), 12, y + 4);
    }

    const chartWidth = width - padLeft - padRight;
    const candleWidth = Math.max(2, Math.floor(chartWidth / Math.max(bars.length, 1) * 0.7));

    const volumeAreaTop = height - volumeHeight - 22;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(padLeft, volumeAreaTop, chartWidth, volumeHeight);
    ctx.strokeStyle = '#334155';
    ctx.strokeRect(padLeft, volumeAreaTop, chartWidth, volumeHeight);

    const labelEvery = Math.max(1, Math.floor(bars.length / 10));

    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i];
        const x = padLeft + i * (chartWidth / Math.max(bars.length - 1, 1));
        const open = Number(bar.open);
        const high = Number(bar.high);
        const low = Number(bar.low);
        const close = Number(bar.close);

        const openY = priceToY(open, plotMin, plotMax, padTop, chartHeight);
        const closeY = priceToY(close, plotMin, plotMax, padTop, chartHeight);
        const highY = priceToY(high, plotMin, plotMax, padTop, chartHeight);
        const lowY = priceToY(low, plotMin, plotMax, padTop, chartHeight);

        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        const color = close >= open ? '#22c55e' : '#f43f5e';
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;

        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(2, Math.abs(closeY - openY));
        ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);

        if (bodyHeight <= 2) {
            ctx.strokeRect(x - candleWidth / 2, bodyTop, candleWidth, 2);
        }

        if (i % labelEvery === 0) {
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(formatTimestamp(bar.window_start).slice(5, 16), x, height - 40);
        }

        const volume = Number(bar.volume);
        const volumeY = volumeAreaTop + volumeHeight - (volume / maxVolume) * volumeHeight;
        ctx.fillStyle = close >= open ? 'rgba(34,197,94,0.55)' : 'rgba(244,63,94,0.55)';
        ctx.fillRect(x - candleWidth / 2, volumeY, candleWidth, height - 22 - volumeY);
    }

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13px sans-serif';
    ctx.fillText('Volume', padLeft, volumeAreaTop - 8);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '14px sans-serif';
    ctx.fillText(`Latest close: ${bars[bars.length - 1].close}`, padLeft, height - 88);
    ctx.fillText(`Latest timestamp: ${formatTimestamp(bars[bars.length - 1].window_start)}`, padLeft + 260, height - 88);

    return canvas;
}

function createBarsAccumulator() {
    const bars = new Map();

    return {
        update(trade) {
            const timestamp = Number(trade.t);
            const minuteStart = minuteBucket(timestamp);
            const price = Number(trade.p);
            const volume = Number(trade.v || 0);

            if (!bars.has(minuteStart)) {
                bars.set(minuteStart, {
                    window_start: minuteStart,
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    volume,
                });
                return;
            }

            const bar = bars.get(minuteStart);
            bar.high = Math.max(bar.high, price);
            bar.low = Math.min(bar.low, price);
            bar.close = price;
            bar.volume += volume;
        },
        getBars() {
            return Array.from(bars.values()).sort((a, b) => new Date(a.window_start) - new Date(b.window_start));
        },
    };
}

async function main() {
    const token = requireEnv('FINNHUB_TOKEN');
    const symbol = getEnvOrDefault('FINNHUB_SYMBOL', DEFAULT_SYMBOL);
    const maxWaitMs = Number(getEnvOrDefault('FINNHUB_KLINE_MAX_WAIT_MS', DEFAULT_MAX_WAIT_MS));
    const minBars = Number(getEnvOrDefault('FINNHUB_KLINE_MIN_BARS', DEFAULT_MIN_BARS));
    const reconnectDelay = Number(getEnvOrDefault('FINNHUB_RECONNECT_DELAY_MS', DEFAULT_RECONNECT_DELAY_MS));
    const wsUrl = getEnvOrDefault('FINNHUB_WS_URL', `wss://ws.finnhub.io?token=${token}`);

    console.log('正在连接 Finnhub 实时数据流...');
    const barsAccumulator = createBarsAccumulator();

    const ws = new WebSocket(wsUrl);
    let finished = false;

    const finish = () => {
        if (finished) {
            return;
        }
        finished = true;

        const bars = barsAccumulator.getBars();
        if (bars.length < minBars) {
            ws.close();
            throw new Error(`No enough Finnhub bars collected. received=${bars.length}, required=${minBars}`);
        }

        const canvas = drawChart(bars);
        fs.writeFileSync(OUTPUT_PATH, canvas.toBuffer('image/png'));

        console.log(`Saved ${OUTPUT_PATH}`);
        console.log(`Bars: ${bars.length}`);
        console.log(`Range: ${formatTimestamp(bars[0].window_start)} -> ${formatTimestamp(bars[bars.length - 1].window_start)}`);
        ws.close();
    };

    ws.on('open', () => {
        ws.send(JSON.stringify({
            type: 'subscribe',
            symbol,
        }));
        console.log(`已订阅 ${symbol}`);
    });

    ws.on('message', (raw) => {
        try {
            const message = JSON.parse(raw.toString());
            if (message.type === 'trade') {
                const trade = message.data?.[0];
                if (!trade) {
                    return;
                }

                barsAccumulator.update(trade);
                return;
            }

            if (message.type === 'quote') {
                const quote = message.data?.[0];
                if (!quote) {
                    return;
                }

                barsAccumulator.update({
                    p: quote.p,
                    t: quote.t,
                    v: 0,
                });
                return;
            }

            if (message.type === 'ping') {
                return;
            }
        } catch (error) {
            console.error('解析消息失败', error.message);
        }
    });

    ws.on('error', (error) => {
        console.error('Finnhub WebSocket 错误', error.message);
    });

    ws.on('close', () => {
        if (!finished) {
            finish();
        }
    });

    const waitTimer = setTimeout(() => {
        finish();
    }, maxWaitMs);

    const pollingTimer = setInterval(() => {
        if (finished) {
            clearInterval(pollingTimer);
            clearTimeout(waitTimer);
            return;
        }

        if (barsAccumulator.getBars().length >= minBars) {
            clearInterval(pollingTimer);
            clearTimeout(waitTimer);
            finish();
        }
    }, 1000);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
