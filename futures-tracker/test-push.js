const { fetchCurrentFuturesTicker, fetch24Hours5MinKline } = require('./fetcher');
const { drawKlineChart } = require('./chart');
const { sendToWeCom } = require('./wecom');

async function testPush() {
    console.log('🚀 开始执行企业微信手动推送联调测试...');
    
    // 1. 获取当前行情
    const cur = await fetchCurrentFuturesTicker();
    console.log(`📊 当前实时期货价: $${cur.price.toFixed(2)} | 今日开盘: $${cur.open.toFixed(2)}`);

    // 2. 获取 24 小时 5 分钟 K 线
    const { bars, sourceName, statusList } = await fetch24Hours5MinKline(cur.price, cur.open);

    if (!bars || bars.length === 0) {
        console.error('❌ 未能获取到 K 线数据');
        process.exit(1);
    }

    // 3. 内存绘制 K 线图
    const imageBuffer = drawKlineChart(bars, cur.price, 2.0, 2.0, sourceName);

    // 4. 推送到企业微信
    console.log('📤 正在发送测试图文消息到企业微信...');
    await sendToWeCom({
        price: cur.price,
        prevPrice: cur.price - 2.0,
        priceDiff: 2.0,
        priceStep: 2.0,
        open: cur.open,
        high: cur.high,
        low: cur.low,
        timeStr: new Date().toLocaleTimeString(),
        imageBuffer,
        sourceName,
        statusList
    });

    console.log('✅ 测试推送完成！请检查企业微信群消息。');
}

testPush().catch(console.error);
