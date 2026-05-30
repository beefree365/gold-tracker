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

async function fetchSpotData(startDate, endDate) {
    const token = requireEnv('TWELVE_TOKEN');
    const symbol = getEnvOrDefault('TWELVE_SYMBOL', 'XAU/USD');
    const interval = getEnvOrDefault('TWELVE_INTERVAL', '1min');

    console.log(`Fetching spot data from TwelveData...`);
    console.log(`  Symbol: ${symbol}`);
    console.log(`  Interval: ${interval}`);
    console.log(`  Start: ${startDate}`);
    console.log(`  End: ${endDate}`);

    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('apikey', token);
    url.searchParams.set('start_date', startDate);
    url.searchParams.set('end_date', endDate);
    url.searchParams.set('order', 'asc');
    
    // 【修复】：强制请求最大数据量，覆盖默认的 30 条限制
    url.searchParams.set('outputsize', '5000'); 

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

    const bars = payload.values.map(normalizeTwelveBar);
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
    ctx.fillText('XAU/USD Spot Price K-Line', padLeft, 30);

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

function parseDateInput(dateStr) {
    if (!dateStr) {
        throw new Error('Date string is required');
    }

    let normalizedStr = dateStr.trim();
    // 【修复】：仅判断末尾是否包含时区信息，避免匹配到日期中的 '-'
    const hasTimezone = /[Zz]$/.test(normalizedStr) || /[+\-]\d{2}:?\d{2}$/.test(normalizedStr);
    
    if (!hasTimezone) {
        normalizedStr = normalizedStr.replace(' ', 'T') + 'Z';
    }

    const date = new Date(normalizedStr);
    
    if (isNaN(date.getTime())) {
        throw new Error(`Invalid date format: ${dateStr}. Use format like "2024-01-01" or "2024-01-01 10:00:00"`);
    }

    return date;
}

function formatDateForTwelve(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function generateTimestampSuffix(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    const formatPart = (date) => {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        return `${year}${month}${day}_${hours}${minutes}`;
    };
    
    return `${formatPart(start)}_to_${formatPart(end)}`;
}

async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage: node scripts/fetch-spot-custom.js <start_date> <end_date>');
        console.log('       node scripts/fetch-spot-custom.js latest  (Fetches last 24 hours)');
        console.log('');
        console.log('Examples:');
        console.log('  node scripts/fetch-spot-custom.js latest');
        console.log('  node scripts/fetch-spot-custom.js "2024-01-01" "2024-01-02"');
        console.log('  node scripts/fetch-spot-custom.js "2024-01-01 10:00:00" "2024-01-01 18:00:00"');
        process.exit(1);
    }

    try {
        let startDate, endDate;

        // 【新增】：支持 latest 参数，获取最近 24 小时的数据
        if (args[0].toLowerCase() === 'latest') {
            endDate = new Date();
            startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
            console.log('=== Gold Spot Data Fetcher (Latest 24h) ===\n');
        } else {
            if (args.length < 2) throw new Error('Must provide both start and end dates');
            console.log('=== Gold Spot Data Fetcher ===\n');
            startDate = parseDateInput(args[0]);
            endDate = parseDateInput(args[1]);
        }

        console.log(`Resolved start date (UTC): ${startDate.toISOString()}`);
        console.log(`Resolved end date (UTC): ${endDate.toISOString()}\n`);

        if (startDate >= endDate) {
            throw new Error('Start date must be before end date');
        }

        const formattedStart = formatDateForTwelve(startDate);
        const formattedEnd = formatDateForTwelve(endDate);

        const spotBars = await fetchSpotData(formattedStart, formattedEnd);
        const timestampSuffix = generateTimestampSuffix(startDate, endDate);

        console.log('\nSaving spot data to CSV...');
        const csvRows = ['timestamp,minute,open,high,low,close,volume'];
        for (const bar of spotBars) {
            csvRows.push(`${bar.timestamp},${bar.minute},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}`);
        }
        
        const csvFilename = `spot-data-${timestampSuffix}.csv`;
        const outputDir = path.join(__dirname, '..', 'output', 'csv');
        
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const csvPath = path.join(outputDir, csvFilename);
        fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
        console.log(`Saved to: ${csvPath}`);

        console.log('\nDrawing spot chart...');
        const canvas = drawSpotChart(spotBars);
        
        const pngFilename = `spot-kline-${timestampSuffix}.png`;
        const chartsDir = path.join(__dirname, '..', 'output', 'charts');
        
        if (!fs.existsSync(chartsDir)) {
            fs.mkdirSync(chartsDir, { recursive: true });
        }
        
        const outputPath = path.join(chartsDir, pngFilename);
        fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
        console.log(`Chart saved to: ${outputPath}`);

        console.log('\n=== Summary ===');
        console.log(`Total bars: ${spotBars.length}`);
        console.log(`Price range: $${Math.min(...spotBars.map(b => b.close)).toFixed(2)} - $${Math.max(...spotBars.map(b => b.close)).toFixed(2)}`);
        console.log(`Time range: ${spotBars[0].timestamp.split('T')[1].slice(0, 5)} - ${spotBars[spotBars.length - 1].timestamp.split('T')[1].slice(0, 5)} UTC`);
        console.log(`Output files:`);
        console.log(`  CSV: ${csvFilename}`);
        console.log(`  PNG: ${pngFilename}`);
        console.log('\n✓ Spot data processing complete!');

    } catch (error) {
        console.error('\nError:', error.message);
        process.exitCode = 1;
    }
}

main();