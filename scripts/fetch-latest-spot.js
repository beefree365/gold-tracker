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

function normalizeTwelveBar(raw) {
    const timestamp = new Date(`${raw.datetime.replace(' ', 'T')}Z`);
    return {
        timestamp: timestamp.toISOString(),
        minute: new Date(Math.floor(timestamp.getTime() / 60000) * 60000).toISOString(),
        open: toNumber(raw.open),
        high: toNumber(raw.high),
        low: toNumber(raw.low),
        close: toNumber(raw.close),
        volume: 0,
    };
}

async function fetchYesterdaySpotBars() {
    const token = requireEnv('TWELVE_TOKEN');
    const symbol = getEnvOrDefault('TWELVE_SYMBOL', 'XAU/USD');
    const interval = getEnvOrDefault('TWELVE_INTERVAL', '1min');

    // Calculate yesterday's date
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const year = yesterday.getUTCFullYear();
    const month = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
    const day = String(yesterday.getUTCDate()).padStart(2, '0');
    
    const startDate = `${year}-${month}-${day} 00:00:00`;
    const endDate = `${year}-${month}-${day} 23:59:59`;

    console.log('Fetching yesterday spot data from TwelveData...');
    console.log(`  Symbol: ${symbol}`);
    console.log(`  Interval: ${interval}`);
    console.log(`  Date: ${year}-${month}-${day} (yesterday)`);
    console.log(`  Range: ${startDate} to ${endDate}`);

    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('outputsize', '1440'); // Full day: 24 * 60 = 1440 minutes
    url.searchParams.set('apikey', token);
    url.searchParams.set('start_date', startDate);
    url.searchParams.set('end_date', endDate);

    const response = await fetch(url.toString(), {
        headers: {
            'User-Agent': 'gold-tracker-spot-yesterday/1.0',
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
        throw new Error('No spot data returned for yesterday');
    }

    // Normalize and sort by time (oldest first)
    const bars = payload.values.map(normalizeTwelveBar).sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
    );

    console.log(`  Retrieved ${bars.length} bars`);
    console.log(`  Time range: ${bars[0].timestamp} to ${bars[bars.length - 1].timestamp}`);
    
    return bars;
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

function drawSpotChart(spotBars) {
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
    ctx.fillText('Gold Spot (XAU/USD) Yesterday Full-Day K-Line', padLeft, 30);

    // Subtitle
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`${spotBars.length} bars | ${formatTimestamp(spotBars[0].timestamp)} -> ${formatTimestamp(spotBars[spotBars.length - 1].timestamp)}`, padLeft, 62);

    // Calculate price range
    const allPrices = spotBars.flatMap((bar) => [bar.open, bar.high, bar.low, bar.close]);
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

    const candleWidth = Math.max(2, Math.floor(chartWidth / Math.max(spotBars.length, 1) * 0.55));

    // Draw candlesticks
    for (let i = 0; i < spotBars.length; i += 1) {
        const bar = spotBars[i];
        const x = padLeft + i * (chartWidth / Math.max(spotBars.length - 1, 1));
        const openY = priceToY(bar.open, plotMin, plotMax, padTop, chartHeight);
        const closeY = priceToY(bar.close, plotMin, plotMax, padTop, chartHeight);
        const highY = priceToY(bar.high, plotMin, plotMax, padTop, chartHeight);
        const lowY = priceToY(bar.low, plotMin, plotMax, padTop, chartHeight);

        // Wick
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        // Body
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(x - candleWidth / 2, Math.min(openY, closeY), candleWidth, Math.max(2, Math.abs(closeY - openY)));

        // Time labels
        if (i % Math.max(1, Math.floor(spotBars.length / 10)) === 0) {
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(formatTimestamp(bar.timestamp).slice(5, 16), x, height - 20);
        }
    }

    // Legend
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13px sans-serif';
    ctx.fillText('Spot (XAU/USD)', padLeft + 120, 100);
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(padLeft + 70, 88, 12, 12);

    return canvas;
}

async function main() {
    try {
        // Step 1: Fetch yesterday spot data
        const spotBars = await fetchYesterdaySpotBars();

        // Step 2: Save to CSV
        console.log('\nSaving spot data to CSV...');
        const csvRows = ['timestamp,minute,open,high,low,close,volume'];
        for (const bar of spotBars) {
            csvRows.push(`${bar.timestamp},${bar.minute},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}`);
        }
        const csvPath = getEnvOrDefault('YESTERDAY_SPOT_CSV_PATH', path.join(__dirname, '..', 'yesterday-spot-data.csv'));
        fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
        console.log(`Saved to: ${csvPath}`);

        // Step 3: Draw chart
        console.log('\nDrawing spot chart...');
        const canvas = drawSpotChart(spotBars);
        const outputPath = getEnvOrDefault('YESTERDAY_SPOT_PLOT_PATH', path.join(__dirname, '..', 'yesterday-spot-kline.png'));
        fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
        console.log(`Chart saved to: ${outputPath}`);

        // Summary
        console.log('\n=== Summary ===');
        console.log(`Total bars: ${spotBars.length}`);
        console.log(`Price range: $${Math.min(...spotBars.map(b => b.close)).toFixed(2)} - $${Math.max(...spotBars.map(b => b.close)).toFixed(2)}`);
        console.log(`Time range: ${spotBars[0].timestamp.split('T')[1].slice(0, 5)} - ${spotBars[spotBars.length - 1].timestamp.split('T')[1].slice(0, 5)} UTC`);
        console.log('\n✓ Latest spot data processing complete!');

    } catch (error) {
        console.error('Error:', error.message);
        process.exitCode = 1;
    }
}

main();
