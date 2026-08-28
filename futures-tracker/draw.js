const fs = require('fs');
const path = require('path');

const { OUTPUT_DIR, LATEST_IMAGE_PATH } = require('./config');
const { fetchCurrentFuturesTicker, fetch24Hours5MinKline } = require('./fetcher');
const { drawKlineChart } = require('./chart');

async function main() {
    console.log('正在获取当前期货实时数据与 24 小时 5 分钟 K 线...');
    const cur = await fetchCurrentFuturesTicker();
    const { bars, sourceName, statusList } = await fetch24Hours5MinKline(cur.price, cur.open);

    console.log('\n┌────────────────────────────── 3 级数据源状态排查 ──────────────────────────────┐');
    for (const item of (statusList || [])) {
        console.log(`│ [${item.status}] ${item.name.padEnd(28)} : ${item.reason}`);
    }
    console.log('└────────────────────────────────────────────────────────────────────────────────┘\n');

    if (!bars || bars.length === 0) {
        console.error('❌ 未能获取到 K 线数据');
        process.exit(1);
    }

    const buffer = drawKlineChart(bars, cur.price, 0, 2.0, sourceName);

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const timeTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const historyPath = path.join(OUTPUT_DIR, `manual-futures-5m-${timeTag}.png`);
    const latestModulePath = LATEST_IMAGE_PATH;
    const rootPath = path.join(__dirname, '..', 'futures-5m-kline-latest.png');

    fs.writeFileSync(historyPath, buffer);
    fs.writeFileSync(latestModulePath, buffer);
    try { fs.writeFileSync(rootPath, buffer); } catch (e) {}

    console.log('✅ K 线图已成功绘制并保存到以下本地路径:');
    console.log(`   1. [历史存档] ${historyPath}`);
    console.log(`   2. [模块最新] ${latestModulePath}`);
    console.log(`   3. [根目录]   ${rootPath}`);
}

main().catch(console.error);
