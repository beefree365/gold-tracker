require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const TICKER = 'GCM6';
const RESOLUTION = '1min';
const LIMIT = 50000;
const OUTPUT_PATH = path.join(__dirname, '..', 'gcm6-kline.png');
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

function formatTimestamp(ns) {
    const date = new Date(Number(ns) / 1e6);
    return date.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function toWindowStartValue(value) {
    const trimmed = String(value).trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return new Date(`${trimmed}T00:00:00Z`).toISOString();
    }

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
    }

    return trimmed;
}

function getDefaultRange() {
    const end = new Date();
    const start = new Date(end.getTime() - ONE_DAY_MS);
    return {
        start: start.toISOString(),
        end: end.toISOString(),
    };
}

async function fetchBars() {
    const token = requireEnv('MASSIVE_TOKEN');
    const defaultRange = getDefaultRange();
    const startDate = getEnvOrDefault('KLINE_START_DATE', defaultRange.start);
    const endDate = getEnvOrDefault('KLINE_END_DATE', defaultRange.end);

    const headers = {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0',
    };

    const firstUrl = new URL(`https://api.massive.com/futures/v1/aggs/${TICKER}`);
    firstUrl.searchParams.set('resolution', RESOLUTION);
    firstUrl.searchParams.set('limit', String(LIMIT));
    firstUrl.searchParams.set('sort', 'window_start.asc');
    firstUrl.searchParams.set('window_start.gte', toWindowStartValue(startDate));
    firstUrl.searchParams.set('window_start.lte', toWindowStartValue(endDate));

    let url = firstUrl;
    const results = [];

    while (url) {
        const response = await fetch(url.toString(), { headers });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Massive request failed (${response.status}): ${text}`);
        }

        const data = await response.json();

        if (!Array.isArray(data.results)) {
            throw new Error('Massive response did not include results');
        }

        results.push(...data.results);

        if (!data.next_url) {
            url = null;
            break;
        }

        url = new URL(data.next_url);
    }

    if (results.length === 0) {
        throw new Error(`Massive returned no bars for ${TICKER} in the requested range`);
    }

    return results.sort((a, b) => Number(a.window_start) - Number(b.window_start));
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
    ctx.fillText(`GCM6 1-Minute K-Line (${bars.length} bars)`, padLeft, 30);

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
            const label = formatTimestamp(bar.window_start).slice(5, 16);
            ctx.fillText(label, x, height - 40);
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

async function main() {
    const bars = await fetchBars();
    const canvas = drawChart(bars);
    fs.writeFileSync(OUTPUT_PATH, canvas.toBuffer('image/png'));

    console.log(`Saved ${OUTPUT_PATH}`);
    console.log(`Bars: ${bars.length}`);
    console.log(`Range: ${formatTimestamp(bars[0].window_start)} -> ${formatTimestamp(bars[bars.length - 1].window_start)}`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
