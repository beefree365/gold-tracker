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
    // ================= 动态分辨率计算 =================
    // 保证每根K线至少有 4 像素宽，确保绝对清晰。最窄 1920 (1080p标准)，最宽限制在 12000 像素防内存溢出
    const minPixelsPerCandle = 3;
    const padLeft = 100;
    const padRight = 40;
    const calculatedWidth = padLeft + padRight + (spotBars.length * minPixelsPerCandle);
    const width = Math.min(Math.max(1920, calculatedWidth), 12000); 
    const height = 1980; // 高度统一提升到 1080 级别，细节更丰富

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const padTop = 80;    // 调整顶部留白，因为标题合并为了一行
    const padBottom = 80;
    const chartHeight = height - padTop - padBottom;
    const chartWidth = width - padLeft - padRight;

    // 常用美观字体栈
    const fontFamily = '"Helvetica Neue", Helvetica, Arial, "Microsoft YaHei", sans-serif';

    // 背景 (亮色)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // ================= 顶部信息栏 (合并为一行) =================
    const headerY = 46;

    // 1. 大标题
    ctx.fillStyle = '#0f172a';
    ctx.font = `bold 28px ${fontFamily}`;
    const titleText = 'XAU/USD Spot Price K-Line';
    ctx.fillText(titleText, padLeft, headerY);
    const titleWidth = ctx.measureText(titleText).width;

    // 2. 副标题 (大标题右侧 30px)
    const subX = padLeft + titleWidth + 30;
    ctx.font = `16px ${fontFamily}`;
    ctx.fillStyle = '#64748b';
    const subText = `${spotBars.length} bars | ${formatTimestamp(spotBars[0].timestamp)} -> ${formatTimestamp(spotBars[spotBars.length - 1].timestamp)}`;
    ctx.fillText(subText, subX, headerY);
    const subWidth = ctx.measureText(subText).width;

    // 3. 图例与 Label (副标题右侧 50px)
    const legendX = subX + subWidth + 50;
    ctx.fillStyle = '#10b981'; // 绿块
    ctx.fillRect(legendX, headerY - 14, 16, 16);
    ctx.fillStyle = '#ef4444'; // 红块
    ctx.fillRect(legendX + 22, headerY - 14, 16, 16);
    
    ctx.fillStyle = '#475569';
    ctx.font = `15px ${fontFamily}`;
    ctx.fillText('Spot (XAU/USD)', legendX + 48, headerY);

    // ================= 计算价格极值 =================
    const allPrices = spotBars.flatMap((bar) => [bar.open, bar.high, bar.low, bar.close]);
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const span = Math.max(1, maxPrice - minPrice);
    const padding = span * 0.05;
    const plotMin = minPrice - padding;
    const plotMax = maxPrice + padding;

    // ================= 绘制网格与 Y 轴刻度 =================
    ctx.strokeStyle = '#e2e8f0'; 
    ctx.lineWidth = 1;
    // 高度变大了，把网格线加到 8 根让刻度更精细
    const gridLines = 8;
    for (let i = 0; i <= gridLines; i += 1) {
        const y = padTop + (chartHeight / gridLines) * i;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();

        ctx.fillStyle = '#475569';
        ctx.font = `14px ${fontFamily}`;
        // 价格刻度保留两位小数
        ctx.fillText((plotMax - ((plotMax - plotMin) / gridLines) * i).toFixed(2), 16, y + 5);
    }

    // 动态蜡烛宽度：画布变宽后，适当增加蜡烛实体的占比，看起来更饱满
    const candleWidth = Math.max(3, Math.floor((chartWidth / Math.max(spotBars.length, 1)) * 0.65));

    // ================= 绘制 K 线与 X 轴时间 =================
    for (let i = 0; i < spotBars.length; i += 1) {
        const bar = spotBars[i];
        const x = padLeft + i * (chartWidth / Math.max(spotBars.length - 1, 1));
        const openY = priceToY(bar.open, plotMin, plotMax, padTop, chartHeight);
        const closeY = priceToY(bar.close, plotMin, plotMax, padTop, chartHeight);
        const highY = priceToY(bar.high, plotMin, plotMax, padTop, chartHeight);
        const lowY = priceToY(bar.low, plotMin, plotMax, padTop, chartHeight);

        const isUp = bar.close >= bar.open;
        const candleColor = isUp ? '#10b981' : '#ef4444'; 

        // 上下影线
        ctx.strokeStyle = candleColor;
        ctx.lineWidth = 1.5; // 分辨率提高后，影线稍微加粗一点
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        // 实体
        ctx.fillStyle = candleColor;
        ctx.fillRect(x - candleWidth / 2, Math.min(openY, closeY), candleWidth, Math.max(2, Math.abs(closeY - openY)));

        // X轴时间标签 (画布变长了，可以展示更多的时间节点，大约分成 20 个节点)
        const timeLabelInterval = Math.max(1, Math.floor(spotBars.length / 20));
        if (i % timeLabelInterval === 0) {
            ctx.fillStyle = '#64748b'; 
            ctx.font = `14px ${fontFamily}`;
            ctx.textAlign = 'center';
            // 提取 HH:mm 格式，例如 14:30
            ctx.fillText(formatTimestamp(bar.timestamp).slice(11, 16), x, height - 30);
            
            // X轴上的小刻度标记
            ctx.strokeStyle = '#cbd5e1';
            ctx.beginPath();
            ctx.moveTo(x, height - padBottom + 5);
            ctx.lineTo(x, height - padBottom + 10);
            ctx.stroke();
        }
    }

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