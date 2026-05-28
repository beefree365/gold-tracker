require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const { WebSocket } = require('ws');

// Polyfill fetch for Node.js < 18
let fetch;
if (typeof global.fetch === 'undefined') {
    const nodeFetch = require('node-fetch');
    fetch = nodeFetch.default || nodeFetch;
} else {
    fetch = global.fetch;
}

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

    // Gold futures trading hours: 6:00 AM ET to 5:00 AM ET next day (23 hours)
    // Calculate the start of "yesterday's" trading session
    const now = new Date();
    const currentHour = now.getUTCHours();
    
    // Convert to ET (UTC-5 for EST, UTC-4 for EDT)
    // For simplicity, we'll use UTC-5 as base and adjust if needed
    const etOffset = -5; // Eastern Time offset from UTC
    const etHour = (currentHour + etOffset + 24) % 24;
    
    let startDate;
    if (etHour >= 6 && etHour < 29) { // Currently in trading session (6 AM to 5 AM next day)
        // Yesterday's session started at 6 AM ET yesterday
        startDate = new Date(now);
        startDate.setUTCDate(startDate.getUTCDate() - 1);
        startDate.setUTCHours(11, 0, 0, 0); // 6 AM ET = 11 AM UTC
    } else {
        // Before 6 AM ET, yesterday's session is the previous day's 6 AM to 5 AM
        startDate = new Date(now);
        startDate.setUTCDate(startDate.getUTCDate() - 1);
        startDate.setUTCHours(11, 0, 0, 0); // 6 AM ET = 11 AM UTC
    }
    
    // Get data from yesterday's trading session (6 AM ET to 5 AM ET next day = 23 hours = 1380 minutes)
    const url = new URL('https://api.massive.com/futures/v1/aggs/GCM6');
    url.searchParams.set('resolution', '1min');
    url.searchParams.set('limit', '1400'); // Get full day's data (23 hours * 60 minutes)
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

    const bars = payload.results.map(normalizeMassiveBar).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    // Filter to only include bars from yesterday's trading session
    const filteredBars = bars.filter(bar => {
        const barTime = new Date(bar.timestamp);
        return barTime >= startDate;
    });
    
    console.log(`  Trading session start (6 AM ET): ${startDate.toISOString()}`);
    console.log(`  Total bars retrieved: ${bars.length}, Filtered to session: ${filteredBars.length}`);
    
    return filteredBars;
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

async function fetchTwelveBarsBatch(minuteIsos) {
    const token = requireEnv('TWELVE_TOKEN');
    const symbol = getEnvOrDefault('TWELVE_SYMBOL', 'XAU/USD');
    const interval = getEnvOrDefault('TWELVE_INTERVAL', '1min');

    // Get the time range
    const sortedMinutes = [...minuteIsos].sort();
    const startDate = formatTwelveMinute(sortedMinutes[0]);
    const endDate = formatTwelveMinute(sortedMinutes[sortedMinutes.length - 1]);

    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('outputsize', String(minuteIsos.length + 5)); // Add buffer
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
        throw new Error(`Twelve Data batch request failed (${response.status}): ${text}`);
    }

    const payload = await response.json();

    if (!payload || payload.status !== 'ok') {
        throw new Error(`Twelve Data batch request failed: ${JSON.stringify(payload)}`);
    }

    if (!Array.isArray(payload.values) || payload.values.length === 0) {
        throw new Error(`No spot data found for range ${startDate} to ${endDate}`);
    }

    // Create a map of minute -> bar
    const minuteMap = new Map();
    for (const raw of payload.values) {
        const bar = normalizeTwelveBar(raw);
        minuteMap.set(bar.minute, bar);
    }

    // Build result array in the same order as input
    const result = [];
    for (const minuteIso of minuteIsos) {
        const bar = minuteMap.get(minuteIso);
        if (!bar) {
            throw new Error(`Missing spot data for minute ${minuteIso}`);
        }
        result.push(bar);
    }

    return result;
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

    // Create a unified time-based x-position mapping
    // Use futures timestamps as the reference (since they drive the alignment)
    const timeToX = new Map();
    for (let i = 0; i < futureBars.length; i++) {
        const x = padLeft + i * (chartWidth / Math.max(futureBars.length - 1, 1));
        timeToX.set(futureBars[i].minute, x);
    }

    const spreadSeries = futureBars.map((future, index) => {
        const spot = spotBars[index];
        return {
            minute: future.minute,
            value: future.close - spot.close,
            x: timeToX.get(future.minute),
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
        const item = spreadSeries[i];
        const value = item.value;
        const y = priceToY(value, spreadPlotMin, spreadPlotMax, bottomTop, bottomChartHeight);
        const color = value >= 0 ? '#22c55e' : '#f43f5e';
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(item.x, y);
        ctx.lineTo(item.x, y);
        ctx.stroke();

        if (i % Math.max(1, Math.floor(spreadSeries.length / 10)) === 0) {
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(formatTimestamp(item.minute).slice(5, 16), item.x, height - 40);
        }
    }

    for (let i = 0; i < spotBars.length; i += 1) {
        const bar = spotBars[i];
        const x = timeToX.get(bar.minute);
        if (x === undefined) continue; // Skip if no matching futures time
        
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
        const x = timeToX.get(bar.minute);
        if (x === undefined) continue;
        
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
    console.log('Step 1: Fetching latest futures data from Massive.com...');
    const futuresBars = await fetchMassiveBars();
    console.log(`  Retrieved ${futuresBars.length} futures bars`);
    console.log(`  Time range: ${futuresBars[0].timestamp} to ${futuresBars[futuresBars.length - 1].timestamp}`);

    // Extract all minutes from futures bars (this is our time window)
    const minuteIsos = futuresBars.map(f => f.minute);
    console.log(`\nStep 2: Fetching spot data for ${minuteIsos.length} time points from TwelveData...`);
    
    // Fetch all spot bars in one batch request based on futures time window
    let alignedSpotBars;
    try {
        alignedSpotBars = await fetchTwelveBarsBatch(minuteIsos);
        console.log(`  Retrieved ${alignedSpotBars.length} spot bars`);
    } catch (error) {
        console.log(`  Warning: ${error.message}`);
        console.log('  Attempting to fetch available spot data only...');
        
        // Try to get whatever spot data is available
        const token = requireEnv('TWELVE_TOKEN');
        const symbol = getEnvOrDefault('TWELVE_SYMBOL', 'XAU/USD');
        const interval = getEnvOrDefault('TWELVE_INTERVAL', '1min');
        
        const sortedMinutes = [...minuteIsos].sort();
        const startDate = formatTwelveMinute(sortedMinutes[0]);
        const endDate = formatTwelveMinute(sortedMinutes[sortedMinutes.length - 1]);
        
        const url = new URL('https://api.twelvedata.com/time_series');
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('interval', interval);
        url.searchParams.set('outputsize', String(minuteIsos.length + 5));
        url.searchParams.set('apikey', token);
        url.searchParams.set('start_date', startDate);
        url.searchParams.set('end_date', endDate);
        
        const response = await fetch(url.toString(), {
            headers: {
                'User-Agent': 'gold-tracker-estimator/1.0',
            },
        });
        
        const payload = await response.json();
        
        if (!payload || payload.status !== 'ok' || !Array.isArray(payload.values)) {
            throw new Error('Failed to fetch any spot data');
        }
        
        // Create a map of minute -> bar
        const minuteMap = new Map();
        for (const raw of payload.values) {
            const bar = normalizeTwelveBar(raw);
            minuteMap.set(bar.minute, bar);
        }
        
        // Find the overlapping time range where both futures and spot have data
        const overlappingFutures = [];
        const overlappingSpots = [];
        
        for (const future of futuresBars) {
            const spot = minuteMap.get(future.minute);
            if (spot) {
                overlappingFutures.push(future);
                overlappingSpots.push(spot);
            }
        }
        
        if (overlappingFutures.length === 0) {
            throw new Error('No overlapping data found between futures and spot');
        }
        
        console.log(`  Found ${overlappingFutures.length} overlapping time points`);
        console.log(`  Overlapping range: ${overlappingFutures[0].minute} to ${overlappingFutures[overlappingFutures.length - 1].minute}`);
        
        // Use only the overlapping data
        futuresBars.length = 0;
        futuresBars.push(...overlappingFutures);
        alignedSpotBars = overlappingSpots;
    }
    
    // Verify alignment
    let mismatchCount = 0;
    for (let i = 0; i < futuresBars.length; i++) {
        if (futuresBars[i].minute !== alignedSpotBars[i].minute) {
            mismatchCount++;
            if (mismatchCount <= 3) {
                console.log(`  WARNING: Mismatch at index ${i}: Futures=${futuresBars[i].minute}, Spot=${alignedSpotBars[i].minute}`);
            }
        }
    }
    if (mismatchCount === 0) {
        console.log('  ✓ All time points perfectly aligned!');
    } else {
        console.log(`  ✗ Found ${mismatchCount} mismatches!`);
    }

    console.log('\nStep 3: Fetching real-time spot price from Finnhub...');
    const realtimeSpot = await fetchRealtimeSpot();
    console.log(`  Real-time spot price: $${realtimeSpot.toFixed(2)}`);

    console.log('\nStep 4: Generating CSV files...');
    
    // Analyze price correlation
    let sameDirection = 0;
    let oppositeDirection = 0;
    for (let i = 1; i < futuresBars.length; i++) {
        const fChange = futuresBars[i].close - futuresBars[i-1].close;
        const sChange = alignedSpotBars[i].close - alignedSpotBars[i-1].close;
        if ((fChange > 0 && sChange > 0) || (fChange < 0 && sChange < 0)) {
            sameDirection++;
        } else if ((fChange > 0 && sChange < 0) || (fChange < 0 && sChange > 0)) {
            oppositeDirection++;
        }
    }
    const correlationPct = ((sameDirection / (futuresBars.length - 1)) * 100).toFixed(1);
    console.log(`  Price movement correlation: ${correlationPct}% same direction`);
    
    // Calculate statistics
    const spreads = futuresBars.map((f, i) => f.close - alignedSpotBars[i].close);
    const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    const minSpread = Math.min(...spreads);
    const maxSpread = Math.max(...spreads);
    console.log(`  Spread range: $${minSpread.toFixed(2)} - $${maxSpread.toFixed(2)} (avg: $${avgSpread.toFixed(2)})`);
    
    console.log('\nStep 5: Drawing chart...');

    // Ensure output directories exist
    const outputDir = path.join(__dirname, '..', 'output', 'csv');
    const chartsDir = path.join(__dirname, '..', 'output', 'charts');
    
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    if (!fs.existsSync(chartsDir)) {
        fs.mkdirSync(chartsDir, { recursive: true });
    }

    // Generate CSV data - aligned data
    const csvRows = ['timestamp,minute,futures_open,futures_high,futures_low,futures_close,spot_open,spot_high,spot_low,spot_close,spread'];
    
    for (let i = 0; i < futuresBars.length; i++) {
        const future = futuresBars[i];
        const spot = alignedSpotBars[i];
        const spread = future.close - spot.close;
        
        csvRows.push(
            `${future.timestamp},${future.minute},` +
            `${future.open},${future.high},${future.low},${future.close},` +
            `${spot.open},${spot.high},${spot.low},${spot.close},` +
            `${spread}`
        );
    }
    
    const csvContent = csvRows.join('\n');
    const csvPath = getEnvOrDefault('GOLD_FUTURES_CSV_PATH', path.join(outputDir, 'gold-futures-aligned-data.csv'));
    fs.writeFileSync(csvPath, csvContent, 'utf8');

    // Generate raw futures data CSV
    const futuresCsvRows = ['timestamp,minute,open,high,low,close,volume'];
    for (const future of futuresBars) {
        futuresCsvRows.push(
            `${future.timestamp},${future.minute},` +
            `${future.open},${future.high},${future.low},${future.close},${future.volume}`
        );
    }
    const futuresCsvContent = futuresCsvRows.join('\n');
    const futuresCsvPath = getEnvOrDefault('GOLD_FUTURES_RAW_CSV_PATH', path.join(outputDir, 'gold-futures-raw-data.csv'));
    fs.writeFileSync(futuresCsvPath, futuresCsvContent, 'utf8');

    // Generate raw spot data CSV
    const spotCsvRows = ['timestamp,minute,open,high,low,close,volume'];
    for (const spot of alignedSpotBars) {
        spotCsvRows.push(
            `${spot.timestamp},${spot.minute},` +
            `${spot.open},${spot.high},${spot.low},${spot.close},${spot.volume}`
        );
    }
    const spotCsvContent = spotCsvRows.join('\n');
    const spotCsvPath = getEnvOrDefault('GOLD_SPOT_RAW_CSV_PATH', path.join(outputDir, 'gold-spot-raw-data.csv'));
    fs.writeFileSync(spotCsvPath, spotCsvContent, 'utf8');

    const spread = futuresBars[futuresBars.length - 1].close - alignedSpotBars[alignedSpotBars.length - 1].close;
    const estimatedFutures = realtimeSpot + spread;
    const now = Date.now();
    const futuresAgeMs = Math.max(0, now - new Date(futuresBars[futuresBars.length - 1].timestamp).getTime());
    const spotAgeMs = Math.max(0, now - new Date(alignedSpotBars[alignedSpotBars.length - 1].timestamp).getTime());

    const canvas = drawCombinedChart(alignedSpotBars, futuresBars);
    const outputPath = getEnvOrDefault('GOLD_FUTURES_PLOT_PATH', path.join(chartsDir, 'gold-futures-aligned-kline.png'));
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
        csvPath,
        futuresCsvPath,
        spotCsvPath,
        dataQuality: {
            totalBars: futuresBars.length,
            priceCorrelation: 'checking...',
            avgSpread: (futuresBars.reduce((sum, f, i) => sum + (f.close - alignedSpotBars[i].close), 0) / futuresBars.length).toFixed(2),
            futuresPriceRange: {
                min: Math.min(...futuresBars.map(f => f.close)),
                max: Math.max(...futuresBars.map(f => f.close))
            },
            spotPriceRange: {
                min: Math.min(...alignedSpotBars.map(s => s.close)),
                max: Math.max(...alignedSpotBars.map(s => s.close))
            }
        },
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
