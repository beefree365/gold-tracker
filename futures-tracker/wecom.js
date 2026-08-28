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
async function sendToWeCom({ price, level, open, high, low, timeStr, imageBuffer, sourceName, statusList }) {
    if (!WECOM_WEBHOOK_URL) {
        console.log('⚠️ 未配置 WECOM_WEBHOOK_URL，跳过企业微信推送');
        return;
    }

    try {
        console.log('📤 正在向企业微信机器人推送消息...');

        const change = open > 0 ? (((price - open) / open) * 100).toFixed(2) : '0.00';
        const changeSign = change >= 0 ? '+' : '';
        const trendEmoji = price >= open ? '📈' : '📉';

        // 状态摘要行
        const sourceLines = (statusList || []).map(s => `> - ${s.status} **${s.name}**: ${s.reason}`).join('\n');

        // 1. 发送 Markdown 卡片消息
        const markdownContent = [
            `### 🔔 COMEX 黄金期货价格触发提醒 ${trendEmoji}`,
            `> **触发价格**：<font color="warning">**$${price.toFixed(2)}**</font>`,
            `> **触发水平**：**$${level}** (2的倍数)`,
            `> **行情时间**：${timeStr}`,
            `> **今日开盘**：$${open.toFixed(2)} (涨跌: ${changeSign}${change}%)`,
            `> **今日区间**：$${low.toFixed(2)} ~ $${high.toFixed(2)}`,
            `> **走势数据源**：<font color="info">${sourceName || '多源智能对齐'}</font>`,
            `> **数据源状态**：\n${sourceLines}`,
            `> **K线图表**：已生成最近 24 小时 5 分钟走势图 (如下)`
        ].join('\n');

        const textRes = await fetch(WECOM_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                msgtype: 'markdown',
                markdown: { content: markdownContent }
            })
        });
        const textJson = await textRes.json();
        console.log('✓ 企微文字消息已发送:', textJson);

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
