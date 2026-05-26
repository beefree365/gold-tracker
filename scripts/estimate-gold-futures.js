require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const { WebSocket } = require('ws');

const DEFAULT_SYMBOL = 'OANDA:XAU_USD';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_OUTPUT_PATH = path.join(__dirname, '..', 'gold-futures-aligned-kline.png');

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

function parseTimestamp(value) {
    if (typeof value === 'number') {
        if (value > 1e12) {
            return new Date(value / 1e6);
        }

        return new Date(value);
    }

    return new Date(String(value));
}

function isoMinute(value) {
    const date = parseTimestamp(value);
    return new Date(Math.floor(date.getTime() / 60000) * 60000).toISOString();
}

function toNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        throw new Error(`Invalid numeric value: ${value}`);
    }
    return n;
}

function normalizeMassiveBar(raw) {
    const timestamp = parseTimestamp(raw.window_start);
    return {
        timestamp: timestamp.toISOString(),
        minute: isoMinute(timestamp),
        open: toNumber(raw.open),
        high: toNumber(raw.high),
        low: toNumber(raw.low),
        close: toNumber(raw.close),
        volume: toNumber(raw.volume || 0),
    };
}

function normalizeTwelveBar(raw) {
    const timestamp = new Date(`${raw.datetime.replace(' ', 'T')}Z`);
    return {
        timestamp: timestamp.toISOString(),
        minute: isoMinute(timestamp),
        open: toNumber(raw.open),
        high: toNumber(raw.high),
        low: toNumber(raw.low),
        close: toNumber(raw.close),
        volume: 0,
    };
}

async function fetchMassiveBars() {
    const token = requireEnv('MASSIVE_TOKEN');

    const url = new URL('https://api.massive.com/futures/v1/aggs/GCM6');
    url.searchParams.set('resolution', '1min');
    url.searchParams.set('limit', '100');
    url.searchParams.set('sort', 'window_start.desc');

    const response = await fetch(url.toString(), {
        headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'gold-tracker-estimator/1.0',
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Massive request failed (${response.status}): ${text}`);
    }

    const payload = await response.json();

    if (!Array.isArray(payload.results) || payload.results.length === 0) {
        throw new Error('Massive returned no futures bars');
    }

    return payload.results.map(normalizeMassiveBar).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function formatTwelveMinute(minuteIso) {
    return new Date(minuteIso).toISOString().replace('T', ' ').slice(0, 19);
}

async function fetchTwelveBarAtMinute(minuteIso) {
    const token = requireEnv('TWELVE_TOKEN');
    const symbol = getEnvOrDefault('TWELVE_SYMBOL', 'XAU/USD');
    const interval = getEnvOrDefault('TWELVE_INTERVAL', '1min');

    const startDate = formatTwelveMinute(minuteIso);
    const endDate = formatTwelveMinute(minuteIso);

    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('outputsize', '1');
    url.searchParams.set('apikey', token);
    url.searchParams.set('start_date', startDate);
    url.searchParams.set('end_date', endDate);

    const response = await fetch(url.toString(), {
        headers: {
            'User-Agent': 'gold-tracker-estimator/1.0',
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
        throw new Error(`No exact spot data found for minute ${minuteIso}`);
    }

    const bar = normalizeTwelveBar(payload.values[0]);
    if (bar.minute !== minuteIso) {
        throw new Error(`Twelve Data returned non-exact spot minute ${bar.minute} for requested ${minuteIso}`);
    }

    return bar;
}

function waitForMessage(ws, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('Timed out waiting for Finnhub realtime data'));
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timer);
            ws.removeAllListeners('message');
            ws.removeAllListeners('open');
            ws.removeAllListeners('error');
            ws.removeAllListeners('close');
        };

        ws.on('message', (raw) => {
            try {
                const message = JSON.parse(raw.toString());
                const trade = message.data?.[0];
                const quote = message.type === 'quote' ? message.data?.[0] : null;
                const candidate = trade || quote;

                if (!candidate) {
                    return;
                }

                const price = Number(candidate.p);
                if (!Number.isFinite(price)) {
                    return;
                }

                cleanup();
                resolve(price);
            } catch (error) {
                cleanup();
                reject(error);
            }
        });

        ws.on('error', (error) => {
            cleanup();
            reject(error);
        });

        ws.on('close', () => {
            cleanup();
            reject(new Error('Finnhub websocket closed before data arrived'));
        });
    });
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

function drawCombinedChart(spotBars, futureBars) {
    const width = 1400;
    const height = 920;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const padLeft = 96;
    const padRight = 24;
    const padTop = 46;
    const padBottom = 250;
    const topChartHeight = 520;
    const bottomChartHeight = 140;
    const chartWidth = width - padLeft - padRight;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('Aligned Spot vs Futures 1-Minute K-Line', padLeft, 30);

    const firstTs = spotBars[0].timestamp;
    const lastTs = futureBars[futureBars.length - 1].timestamp;
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`Spot: ${spotBars.length} bars | Futures: ${futureBars.length} bars | ${formatTimestamp(firstTs)} -> ${formatTimestamp(lastTs)}`, padLeft, 62);

    const topBottom = padTop + topChartHeight;
    const bottomTop = topBottom + 28;
    const bottomBottom = height - padBottom;

    const allPrices = [...futureBars, ...spotBars].flatMap((bar) => [bar.open, bar.high, bar.low, bar.close]);
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const span = Math.max(1, maxPrice - minPrice);
    const padding = span * 0.04;
    const plotMin = minPrice - padding;
    const plotMax = maxPrice + padding;

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i += 1) {
        const y = padTop + (topChartHeight / 5) * i;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '13px sans-serif';
        ctx.fillText((plotMax - ((plotMax - plotMin) / 5) * i).toFixed(2), 12, y + 4);
    }

    const candleWidth = Math.max(2, Math.floor(chartWidth / Math.max(spotBars.length, futureBars.length, 1) * 0.55));

    const spreadSeries = futureBars.map((future, index) => {
        const spot = spotBars[index];
        return {
            minute: future.minute,
            value: future.close - spot.close,
        };
    });

    const spreadMin = Math.min(...spreadSeries.map((item) => item.value));
    const spreadMax = Math.max(...spreadSeries.map((item) => item.value));
    const spreadSpan = Math.max(1, spreadMax - spreadMin);
    const spreadPadding = spreadSpan * 0.1;
    const spreadPlotMin = spreadMin - spreadPadding;
    const spreadPlotMax = spreadMax + spreadPadding;

    ctx.strokeStyle = '#334155';
    ctx.strokeRect(padLeft, bottomTop, chartWidth, bottomChartHeight);

    for (let i = 0; i <= 4; i += 1) {
        const y = bottomTop + (bottomChartHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '13px sans-serif';
        ctx.fillText((spreadPlotMax - ((spreadPlotMax - spreadPlotMin) / 4) * i).toFixed(2), 12, y + 4);
    }

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13px sans-serif';
    ctx.fillText('Spread (Futures - Spot)', padLeft, bottomTop - 8);

    for (let i = 0; i < spreadSeries.length; i += 1) {
        const x = padLeft + i * (chartWidth / Math.max(spreadSeries.length - 1, 1));
        const value = spreadSeries[i].value;
        const y = priceToY(value, spreadPlotMin, spreadPlotMax, bottomTop, bottomChartHeight);
        const color = value >= 0 ? '#22c55e' : '#f43f5e';
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y);
        ctx.stroke();

        if (i % Math.max(1, Math.floor(spreadSeries.length / 10)) === 0) {
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(formatTimestamp(spreadSeries[i].minute).slice(5, 16), x, height - 40);
        }
    }

    for (let i = 0; i < spotBars.length; i += 1) {
        const bar = spotBars[i];
        const x = padLeft + i * (chartWidth / Math.max(spotBars.length - 1, 1));
        const openY = priceToY(bar.open, plotMin, plotMax, padTop, topChartHeight);
        const closeY = priceToY(bar.close, plotMin, plotMax, padTop, topChartHeight);
        const highY = priceToY(bar.high, plotMin, plotMax, padTop, topChartHeight);
        const lowY = priceToY(bar.low, plotMin, plotMax, padTop, topChartHeight);

        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(x - candleWidth / 2, Math.min(openY, closeY), candleWidth, Math.max(2, Math.abs(closeY - openY)));

        if (i % Math.max(1, Math.floor(spotBars.length / 10)) === 0) {
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(formatTimestamp(bar.timestamp).slice(5, 16), x, height - 40);
        }
    }

    for (let i = 0; i < futureBars.length; i += 1) {
        const bar = futureBars[i];
        const x = padLeft + i * (chartWidth / Math.max(futureBars.length - 1, 1));
        const openY = priceToY(bar.open, plotMin, plotMax, padTop, topChartHeight);
        const closeY = priceToY(bar.close, plotMin, plotMax, padTop, topChartHeight);
        const highY = priceToY(bar.high, plotMin, plotMax, padTop, topChartHeight);
        const lowY = priceToY(bar.low, plotMin, plotMax, padTop, topChartHeight);

        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(x - candleWidth / 2, Math.min(openY, closeY), candleWidth, Math.max(2, Math.abs(closeY - openY)));
    }

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13px sans-serif';
    ctx.fillText('Spot', padLeft + 120, 100);
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(padLeft + 70, 88, 12, 12);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13px sans-serif';
    ctx.fillText('Futures', padLeft + 220, 100);
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(padLeft + 170, 88, 12, 12);

    return canvas;
}

async function fetchRealtimeSpot() {
    const token = requireEnv('FINNHUB_TOKEN');
    const symbol = getEnvOrDefault('FINNHUB_SYMBOL', DEFAULT_SYMBOL);
    const timeoutMs = Number(getEnvOrDefault('FINNHUB_KLINE_MAX_WAIT_MS', DEFAULT_TIMEOUT_MS));
    const wsUrl = getEnvOrDefault('FINNHUB_WS_URL', `wss://ws.finnhub.io?token=${token}`);

    const ws = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.removeAllListeners('open');
            reject(new Error('Timed out connecting to Finnhub websocket'));
        }, timeoutMs);

        ws.once('open', () => {
            clearTimeout(timer);
            ws.send(JSON.stringify({ type: 'subscribe', symbol }));
            resolve();
        });

        ws.once('error', reject);
    });

    try {
        const price = await waitForMessage(ws, timeoutMs);
        ws.close();
        return price;
    } catch (error) {
        ws.close();
        throw error;
    }
}

async function main() {
    const [futuresBars, realtimeSpot] = await Promise.all([
        fetchMassiveBars(),
        fetchRealtimeSpot(),
    ]);

    const alignedSpotBars = [];
    for (const future of futuresBars) {
        const spotBar = await fetchTwelveBarAtMinute(future.minute);
        alignedSpotBars.push(spotBar);
    }

    const spread = futuresBars[futuresBars.length - 1].close - alignedSpotBars[alignedSpotBars.length - 1].close;
    const estimatedFutures = realtimeSpot + spread;
    const now = Date.now();
    const futuresAgeMs = Math.max(0, now - new Date(futuresBars[futuresBars.length - 1].timestamp).getTime());
    const spotAgeMs = Math.max(0, now - new Date(alignedSpotBars[alignedSpotBars.length - 1].timestamp).getTime());

    const canvas = drawCombinedChart(alignedSpotBars, futuresBars);
    const outputPath = getEnvOrDefault('GOLD_FUTURES_PLOT_PATH', DEFAULT_OUTPUT_PATH);
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));

    const result = {
        realtimeSpot,
        spread,
        estimatedFutures,
        futuresBar: {
            timestamp: futuresBars[futuresBars.length - 1].timestamp,
            close: futuresBars[futuresBars.length - 1].close,
        },
        spotBar: {
            timestamp: alignedSpotBars[alignedSpotBars.length - 1].timestamp,
            close: alignedSpotBars[alignedSpotBars.length - 1].close,
        },
        spreadSource: 'exact-minute',
        spreadDiffMs: 0,
        futuresAgeMs,
        spotAgeMs,
        outputPath,
        warnings: [],
    };

    if (futuresAgeMs > 30 * 60 * 1000) {
        result.warnings.push('Massive futures data is older than 30 minutes; estimate is approximate.');
    }

    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
