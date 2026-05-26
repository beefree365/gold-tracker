require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const DEFAULT_SYMBOL = 'XAU/USD';
const DEFAULT_INTERVAL = '1min';
const DEFAULT_OUTPUTSIZE = 500;
const DEFAULT_OUTPUT_PATH = path.join(__dirname, '..', 'twelve-kline.png');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

function priceToY(price, minPrice, maxPrice, top, height) {
    const span = maxPrice - minPrice;
    if (span === 0) {
        return top + height / 2;
    }
    return top + height - ((price - minPrice) / span) * height;
}

function drawChart(bars, symbol) {
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
    ctx.fillText(`Twelve Data 1-Minute K-Line (${bars.length} bars)`, padLeft, 30);

    const firstTs = bars[0].window_start;
    const lastTs = bars[bars.length - 1].window_start;
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`Symbol: ${symbol} | From ${formatTimestamp(firstTs)} to ${formatTimestamp(lastTs)}`, padLeft, 62);

    const lows = bars.map((bar) => Number(bar.low));
    const highs = bars.map((bar) => Number(bar.high));
    const minPrice = Math.min(...lows);
    const maxPrice = Math.max(...highs);
    const priceSpan = maxPrice - minPrice || 1;
    const pricePadding = priceSpan * 0.04;
    const plotMin = minPrice - pricePadding;
    const plotMax = maxPrice + pricePadding;

    const volumes = bars.map((bar) => Number(bar.volume));
    const maxVolume = Math.max(...volumes, 1);

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

function normalizeBar(rawValue) {
    const open = Number(rawValue.open);
    const high = Number(rawValue.high);
    const low = Number(rawValue.low);
    const close = Number(rawValue.close);
    const timestamp = rawValue.datetime;

    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
        throw new Error(`Invalid Twelve Data bar payload: ${JSON.stringify(rawValue)}`);
    }

    return {
        window_start: new Date(timestamp).toISOString(),
        open,
        high,
        low,
        close,
        volume: 0,
    };
}

async function fetchBars() {
    const token = requireEnv('TWELVE_TOKEN');
    const symbol = getEnvOrDefault('TWELVE_SYMBOL', DEFAULT_SYMBOL);
    const interval = getEnvOrDefault('TWELVE_INTERVAL', DEFAULT_INTERVAL);
    const outputSize = Number(getEnvOrDefault('TWELVE_OUTPUTSIZE', DEFAULT_OUTPUTSIZE));
    const startDate = getEnvOrDefault('TWELVE_START_DATE', '');
    const endDate = getEnvOrDefault('TWELVE_END_DATE', '');

    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('outputsize', String(outputSize));
    url.searchParams.set('apikey', token);

    if (startDate) {
        url.searchParams.set('start_date', startDate.slice(0, 19).replace('T', ' '));
    }

    if (endDate) {
        url.searchParams.set('end_date', endDate.slice(0, 19).replace('T', ' '));
    }

    const response = await fetch(url.toString(), {
        headers: {
            'User-Agent': 'gold-tracker-twelve-kline/1.0',
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Twelve Data request failed (${response.status}): ${text}`);
    }

    const payload = await response.json();

    if (!payload || payload.status !== 'ok') {
        throw new Error(`Twelve Data request failed: ${JSON.stringify(payload)}`);
    }

    if (!Array.isArray(payload.values) || payload.values.length === 0) {
        throw new Error(`Twelve Data returned no values for ${symbol}`);
    }

    const bars = payload.values.map(normalizeBar).sort((a, b) => new Date(a.window_start) - new Date(b.window_start));

    if (bars.length === 0) {
        throw new Error(`Twelve Data returned no bars for ${symbol}`);
    }

    return { symbol, bars };
}

async function main() {
    const outputPath = getEnvOrDefault('TWELVE_OUTPUT_PATH', DEFAULT_OUTPUT_PATH);
    const { symbol, bars } = await fetchBars();
    const canvas = drawChart(bars, symbol);
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));

    console.log(`Saved ${outputPath}`);
    console.log(`Bars: ${bars.length}`);
    console.log(`Range: ${formatTimestamp(bars[0].window_start)} -> ${formatTimestamp(bars[bars.length - 1].window_start)}`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
