const crypto = require('crypto');
let fetch;
if (typeof global.fetch === 'undefined') {
    const nodeFetch = require('node-fetch');
    fetch = nodeFetch.default || nodeFetch;
} else {
    fetch = global.fetch;
}

const { WECOM_WEBHOOK_URL } = require('./config');

/**
 * 发送企业微信提醒 (Markdown 卡片 + 高清 Base64 PNG 图片)
 */
async function sendToWeCom({ price, prevPrice, priceDiff, priceStep, open, high, low, timeStr, imageBuffer, sourceName, statusList }) {
    if (!WECOM_WEBHOOK_URL) {
        console.log('⚠️ 未配置 WECOM_WEBHOOK_URL，跳过企业微信推送');
        return;
    }

    try {
        console.log('📤 正在向企业微信机器人推送消息...');

        const change = open > 0 ? (((price - open) / open) * 100).toFixed(2) : '0.00';
        const changeSign = change >= 0 ? '+' : '';
        const trendEmoji = price >= open ? '📈' : '📉';

        const diffSign = typeof priceDiff === 'number' ? (priceDiff >= 0 ? '+' : '') : '';
        const diffEmoji = typeof priceDiff === 'number' && priceDiff >= 0 ? '🔺' : '🔻';
        const diffLine = typeof prevPrice === 'number' && prevPrice > 0
            ? `> **本次波动**：<font color="info">**${diffEmoji} ${diffSign}$${priceDiff.toFixed(2)}**</font> (设定步长: $${priceStep || 2.0})`
            : `> **触发类型**：<font color="info">**服务启动初始基准**</font>`;

        // 1. 发送文字消息：价格：*** (保留1位小数)
        const textContent = `价格：${price.toFixed(1)}`;

        const textRes = await fetch(WECOM_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                msgtype: 'text',
                text: { content: textContent }
            })
        });
        const textJson = await textRes.json();
        console.log(`✓ 企微文字已发送 [${textContent}]:`, textJson);

        // 2. 发送图片消息 (base64 + md5)
        if (imageBuffer) {
            const md5 = crypto.createHash('md5').update(imageBuffer).digest('hex');
            const base64 = imageBuffer.toString('base64');

            const imgRes = await fetch(WECOM_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    msgtype: 'image',
                    image: { base64, md5 }
                })
            });
            const imgJson = await imgRes.json();
            console.log('✓ 企微 K 线图片已发送:', imgJson);
        }
    } catch (err) {
        console.error('❌ 企业微信推送失败:', err.message);
    }
}

module.exports = {
    sendToWeCom
};
