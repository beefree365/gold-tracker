require('dotenv').config();

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

function toNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        throw new Error(`Invalid numeric value: ${value}`);
    }
    return n;
}

function normalizeMassiveBar(raw) {
    // Handle different timestamp formats
    let timestamp;
    if (typeof raw.window_start === 'number') {
        // If it's a Unix timestamp in nanoseconds (Massive API)
        timestamp = new Date(raw.window_start / 1000000);
    } else if (typeof raw.window_start === 'string') {
        // If it's already an ISO string
        timestamp = new Date(raw.window_start);
    } else {
        throw new Error(`Unsupported timestamp format: ${raw.window_start}`);
    }
    
    return {
        timestamp: timestamp.toISOString(),
        minute: new Date(Math.floor(timestamp.getTime() / 60000) * 60000).toISOString(),
        open: toNumber(raw.open),
        high: toNumber(raw.high),
        low: toNumber(raw.low),
        close: toNumber(raw.close),
        volume: toNumber(raw.volume || 0),
    };
}

async function fetchMassiveBars() {
    const token = requireEnv('MASSIVE_TOKEN');

    console.log('Fetching GCM6 futures data from Massive.com...');
    
    // Gold futures trading hours: 6:00 AM ET to 5:00 AM ET next day (23 hours)
    // Calculate the start of "yesterday's" trading session
    const now = new Date();
    const currentHour = now.getUTCHours();
    
    // Convert to ET (UTC-5 for EST, UTC-4 for EDT)
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
            'User-Agent': 'gold-tracker-futures/1.0',
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
    console.log(`  Time range: ${filteredBars[0].timestamp} to ${filteredBars[filteredBars.length - 1].timestamp}`);
    
    return filteredBars;
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

function drawFuturesChart(futureBars) {
    const width = 1400;
    const height = 700;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const padLeft = 96;
    const padRight = 24;
    const padTop = 46;
    const padBottom = 80;
    const chartHeight = height - padTop - padBottom;
    const chartWidth = width - padLeft - padRight;

    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    // Title
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('GCM6 Gold Futures 1-Minute K-Line', padLeft, 30);

    // Subtitle
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`${futureBars.length} bars | ${formatTimestamp(futureBars[0].timestamp)} -> ${formatTimestamp(futureBars[futureBars.length - 1].timestamp)}`, padLeft, 62);

    // Calculate price range
    const allPrices = futureBars.flatMap((bar) => [bar.open, bar.high, bar.low, bar.close]);
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

    const candleWidth = Math.max(2, Math.floor(chartWidth / Math.max(futureBars.length, 1) * 0.55));

    // Draw candlesticks
    for (let i = 0; i < futureBars.length; i += 1) {
        const bar = futureBars[i];
        const x = padLeft + i * (chartWidth / Math.max(futureBars.length - 1, 1));
        const openY = priceToY(bar.open, plotMin, plotMax, padTop, chartHeight);
        const closeY = priceToY(bar.close, plotMin, plotMax, padTop, chartHeight);
        const highY = priceToY(bar.high, plotMin, plotMax, padTop, chartHeight);
        const lowY = priceToY(bar.low, plotMin, plotMax, padTop, chartHeight);

        // Wick
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        // Body
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(x - candleWidth / 2, Math.min(openY, closeY), candleWidth, Math.max(2, Math.abs(closeY - openY)));

        // Time labels
        if (i % Math.max(1, Math.floor(futureBars.length / 10)) === 0) {
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(formatTimestamp(bar.timestamp).slice(5, 16), x, height - 20);
        }
    }

    // Legend
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13px sans-serif';
    ctx.fillText('Futures (GCM6)', padLeft + 120, 100);
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(padLeft + 70, 88, 12, 12);

    return canvas;
}

async function main() {
    try {
        // Step 1: Fetch futures data
        const futuresBars = await fetchMassiveBars();

        // Step 2: Save to CSV
        console.log('\nSaving futures data to CSV...');
        const csvRows = ['timestamp,minute,open,high,low,close,volume'];
        for (const bar of futuresBars) {
            csvRows.push(`${bar.timestamp},${bar.minute},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}`);
        }
        const outputDir = path.join(__dirname, '..', 'output', 'csv');
        
        // Ensure output directory exists
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const csvPath = getEnvOrDefault('FUTURES_CSV_PATH', path.join(outputDir, 'futures-only-data.csv'));
        fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
        console.log(`Saved to: ${csvPath}`);

        // Step 3: Draw chart
        console.log('\nDrawing futures chart...');
        const canvas = drawFuturesChart(futuresBars);
        
        const chartsDir = path.join(__dirname, '..', 'output', 'charts');
        
        // Ensure charts directory exists
        if (!fs.existsSync(chartsDir)) {
            fs.mkdirSync(chartsDir, { recursive: true });
        }
        
        const outputPath = getEnvOrDefault('FUTURES_PLOT_PATH', path.join(chartsDir, 'futures-only-kline.png'));
        fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
        console.log(`Chart saved to: ${outputPath}`);

        // Summary
        console.log('\n=== Summary ===');
        console.log(`Total bars: ${futuresBars.length}`);
        console.log(`Price range: $${Math.min(...futuresBars.map(b => b.close)).toFixed(2)} - $${Math.max(...futuresBars.map(b => b.close)).toFixed(2)}`);
        console.log(`Time range: ${futuresBars[0].timestamp.split('T')[1].slice(0, 5)} - ${futuresBars[futuresBars.length - 1].timestamp.split('T')[1].slice(0, 5)} UTC`);
        console.log('\n✓ Futures data processing complete!');

    } catch (error) {
        console.error('Error:', error.message);
        process.exitCode = 1;
    }
}

main();
