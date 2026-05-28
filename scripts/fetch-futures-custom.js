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
        // Massive API returns nanosecond timestamps
        // Divide by 1,000,000 to convert to milliseconds
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

async function fetchFuturesData(startDate, endDate) {
    const token = requireEnv('MASSIVE_TOKEN');

    console.log('Fetching GCM6 futures data from Massive.com...');
    console.log(`  Start: ${startDate}`);
    console.log(`  End: ${endDate}`);

    // Calculate the time range in minutes to estimate how many bars we need
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    const durationMinutes = Math.ceil((endMs - startMs) / (1000 * 60));
    
    // Add some buffer (20% more) to ensure we get all data
    const limit = Math.ceil(durationMinutes * 1.2);
    
    console.log(`  Estimated duration: ${durationMinutes} minutes`);
    console.log(`  Requesting limit: ${limit} bars`);

    const url = new URL('https://api.massive.com/futures/v1/aggs/GCM6');
    url.searchParams.set('resolution', '1min');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('sort', 'window_start.desc');

    const response = await fetch(url.toString(), {
        headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'gold-tracker-futures-custom/1.0',
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
    
    // Filter to only include bars within the specified time range
    const filteredBars = bars.filter(bar => {
        const barTime = new Date(bar.timestamp).getTime();
        return barTime >= startMs && barTime <= endMs;
    });
    
    console.log(`  Total bars retrieved: ${bars.length}`);
    console.log(`  Filtered to range: ${filteredBars.length} bars`);
    
    if (filteredBars.length === 0) {
        throw new Error(`No futures data found in the specified time range`);
    }
    
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
    ctx.fillText('GCM6 Gold Futures K-Line', padLeft, 30);

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

function parseDateInput(dateStr) {
    if (!dateStr) {
        throw new Error('Date string is required');
    }

    const date = new Date(dateStr);
    
    if (isNaN(date.getTime())) {
        throw new Error(`Invalid date format: ${dateStr}. Use format like "2024-01-01" or "2024-01-01 10:00:00"`);
    }

    return date;
}

function formatDateForFilename(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${year}${month}${day}_${hours}${minutes}`;
}

function generateTimestampSuffix(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    return `${formatDateForFilename(start)}_to_${formatDateForFilename(end)}`;
}

async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    
    if (args.length < 2) {
        console.log('Usage: node scripts/fetch-futures-custom.js <start_date> <end_date>');
        console.log('');
        console.log('Examples:');
        console.log('  node scripts/fetch-futures-custom.js "2024-01-01" "2024-01-02"');
        console.log('  node scripts/fetch-futures-custom.js "2024-01-01 10:00:00" "2024-01-01 18:00:00"');
        console.log('  node scripts/fetch-futures-custom.js "2024-01-01T10:00:00Z" "2024-01-01T18:00:00Z"');
        console.log('');
        console.log('Note: Dates can be in any format supported by JavaScript Date constructor');
        console.log('Note: For best results, use UTC times (with Z suffix)');
        process.exit(1);
    }

    try {
        const startDateStr = args[0];
        const endDateStr = args[1];

        console.log('=== Gold Futures Data Fetcher ===\n');
        console.log(`Input start date: ${startDateStr}`);
        console.log(`Input end date: ${endDateStr}\n`);

        // Parse dates
        const startDate = parseDateInput(startDateStr);
        const endDate = parseDateInput(endDateStr);

        if (startDate >= endDate) {
            throw new Error('Start date must be before end date');
        }

        // Format dates for display (ISO format)
        const formattedStart = startDate.toISOString();
        const formattedEnd = endDate.toISOString();

        // Step 1: Fetch futures data
        const futuresBars = await fetchFuturesData(formattedStart, formattedEnd);

        // Step 2: Generate timestamp suffix for filenames
        const timestampSuffix = generateTimestampSuffix(startDate, endDate);

        // Step 3: Save to CSV
        console.log('\nSaving futures data to CSV...');
        const csvRows = ['timestamp,minute,open,high,low,close,volume'];
        for (const bar of futuresBars) {
            csvRows.push(`${bar.timestamp},${bar.minute},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}`);
        }
        
        const csvFilename = `futures-data-${timestampSuffix}.csv`;
        const outputDir = path.join(__dirname, '..', 'output', 'csv');
        
        // Ensure output directory exists
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const csvPath = path.join(outputDir, csvFilename);
        fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
        console.log(`Saved to: ${csvPath}`);

        // Step 4: Draw chart
        console.log('\nDrawing futures chart...');
        const canvas = drawFuturesChart(futuresBars);
        
        const pngFilename = `futures-kline-${timestampSuffix}.png`;
        const chartsDir = path.join(__dirname, '..', 'output', 'charts');
        
        // Ensure charts directory exists
        if (!fs.existsSync(chartsDir)) {
            fs.mkdirSync(chartsDir, { recursive: true });
        }
        
        const outputPath = path.join(chartsDir, pngFilename);
        fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
        console.log(`Chart saved to: ${outputPath}`);

        // Summary
        console.log('\n=== Summary ===');
        console.log(`Total bars: ${futuresBars.length}`);
        console.log(`Price range: $${Math.min(...futuresBars.map(b => b.close)).toFixed(2)} - $${Math.max(...futuresBars.map(b => b.close)).toFixed(2)}`);
        console.log(`Time range: ${futuresBars[0].timestamp.split('T')[1].slice(0, 5)} - ${futuresBars[futuresBars.length - 1].timestamp.split('T')[1].slice(0, 5)} UTC`);
        console.log(`Output files:`);
        console.log(`  CSV: ${csvFilename}`);
        console.log(`  PNG: ${pngFilename}`);
        console.log('\n✓ Futures data processing complete!');

    } catch (error) {
        console.error('\nError:', error.message);
        process.exitCode = 1;
    }
}

main();
