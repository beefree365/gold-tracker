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

async function fetchSpotBarsFromFuturesTimeWindow(futuresCsvPath) {
    console.log('Reading futures time window from CSV...');
    const futuresData = fs.readFileSync(futuresCsvPath, 'utf8').split('\n').slice(1).filter(l => l);
    
    if (futuresData.length === 0) {
        throw new Error('No futures data found in CSV');
    }

    // Extract all minutes from futures data
    const minuteIsos = futuresData.map(line => line.split(',')[1]);
    console.log(`Found ${minuteIsos.length} time points from futures data`);
    console.log(`Time range: ${minuteIsos[0]} to ${minuteIsos[minuteIsos.length - 1]}`);

    // Fetch spot data for these time points
    const token = requireEnv('TWELVE_TOKEN');
    const symbol = getEnvOrDefault('TWELVE_SYMBOL', 'XAU/USD');
    const interval = getEnvOrDefault('TWELVE_INTERVAL', '1min');

    // Get the time range
    const sortedMinutes = [...minuteIsos].sort();
    const startDate = new Date(sortedMinutes[0]).toISOString().replace('T', ' ').slice(0, 19);
    const endDate = new Date(sortedMinutes[sortedMinutes.length - 1]).toISOString().replace('T', ' ').slice(0, 19);

    console.log(`\nFetching spot data from TwelveData...`);
    console.log(`  Symbol: ${symbol}`);
    console.log(`  Range: ${startDate} to ${endDate}`);

    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('outputsize', String(minuteIsos.length + 10));
    url.searchParams.set('apikey', token);
    url.searchParams.set('start_date', startDate);
    url.searchParams.set('end_date', endDate);

    const response = await fetch(url.toString(), {
        headers: {
            'User-Agent': 'gold-tracker-spot/1.0',
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
        throw new Error(`No spot data found for range ${startDate} to ${endDate}`);
    }

    console.log(`  Retrieved ${payload.values.length} bars from API`);

    // Create a map of minute -> bar
    const minuteMap = new Map();
    for (const raw of payload.values) {
        const bar = normalizeTwelveBar(raw);
        minuteMap.set(bar.minute, bar);
    }

    // Build result array matching futures order
    const spotBars = [];
    let missingCount = 0;
    for (const minuteIso of minuteIsos) {
        const bar = minuteMap.get(minuteIso);
        if (!bar) {
            missingCount++;
            if (missingCount <= 5) {
                console.log(`  WARNING: Missing spot data for ${minuteIso}`);
            }
        } else {
            spotBars.push(bar);
        }
    }

    if (missingCount > 0) {
        console.log(`   Missing ${missingCount} out of ${minuteIsos.length} time points`);
    } else {
        console.log(`  ✓ All ${spotBars.length} time points matched!`);
    }

    return spotBars;
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
    ctx.fillText('Gold Spot (XAU/USD) 1-Minute K-Line', padLeft, 30);

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
        // Step 1: Read futures time window
        const futuresCsvPath = getEnvOrDefault('FUTURES_CSV_PATH', path.join(__dirname, '..', 'futures-only-data.csv'));
        
        if (!fs.existsSync(futuresCsvPath)) {
            console.error(`Error: Futures CSV not found at ${futuresCsvPath}`);
            console.error('Please run "npm run fetch:futures-only" first!');
            process.exit(1);
        }

        const spotBars = await fetchSpotBarsFromFuturesTimeWindow(futuresCsvPath);

        if (spotBars.length === 0) {
            throw new Error('No spot data retrieved');
        }

        // Step 2: Save to CSV
        console.log('\nSaving spot data to CSV...');
        const csvRows = ['timestamp,minute,open,high,low,close,volume'];
        for (const bar of spotBars) {
            csvRows.push(`${bar.timestamp},${bar.minute},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}`);
        }
        const csvPath = getEnvOrDefault('SPOT_CSV_PATH', path.join(__dirname, '..', 'spot-only-data.csv'));
        fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
        console.log(`Saved to: ${csvPath}`);

        // Step 3: Draw chart
        console.log('\nDrawing spot chart...');
        const canvas = drawSpotChart(spotBars);
        const outputPath = getEnvOrDefault('SPOT_PLOT_PATH', path.join(__dirname, '..', 'spot-only-kline.png'));
        fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
        console.log(`Chart saved to: ${outputPath}`);

        // Summary
        console.log('\n=== Summary ===');
        console.log(`Total bars: ${spotBars.length}`);
        console.log(`Price range: $${Math.min(...spotBars.map(b => b.close)).toFixed(2)} - $${Math.max(...spotBars.map(b => b.close)).toFixed(2)}`);
        console.log(`Time range: ${spotBars[0].timestamp.split('T')[1].slice(0, 5)} - ${spotBars[spotBars.length - 1].timestamp.split('T')[1].slice(0, 5)} UTC`);
        console.log('\n✓ Spot data processing complete!');

    } catch (error) {
        console.error('Error:', error.message);
        process.exitCode = 1;
    }
}

main();
