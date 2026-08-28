const path = require('path');
const fs = require('fs');

// 优先尝试加载同级 .env，其次加载上级项目 .env
const localEnv = path.join(__dirname, '.env');
const parentEnv = path.join(__dirname, '..', '.env');

if (fs.existsSync(localEnv)) {
    require('dotenv').config({ path: localEnv });
} else if (fs.existsSync(parentEnv)) {
    require('dotenv').config({ path: parentEnv });
} else {
    require('dotenv').config();
}

module.exports = {
    // WebSocket 行情源 (COMEX 纽约黄金期货实时 0 延迟行情)
    WS_URL: 'wss://hq.sinajs.cn/wskt?list=hf_GC',
    HTTP_FALLBACK_URL: 'http://hq.sinajs.cn/list=hf_GC',

    // 企业微信 Webhook
    DEFAULT_WEBHOOK_URL: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=219fe697-90f0-4d8b-a14d-412a43447d5e',
    WECOM_WEBHOOK_URL: process.env.WECOM_WEBHOOK_URL || 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=219fe697-90f0-4d8b-a14d-412a43447d5e',

    // API Tokens
    MASSIVE_TOKEN: process.env.MASSIVE_TOKEN,
    TWELVE_TOKEN: process.env.TWELVE_TOKEN,

    // 主力期货候选合约 (按流动性优先级排序)
    ACTIVE_FUTURES_CONTRACTS: ['GCZ6', 'GCV6', 'GCQ6'],

    // K 线新鲜度阈值 (超过 15 分钟未更新则判定为滞后历史数据，自动切换到实时流)
    MAX_STALE_MS: 15 * 60 * 1000,

    // 重连与心跳
    RECONNECT_DELAY_MS: 3000,
    PING_INTERVAL_MS: 30000,

    // 是否保存图片到本地 (false 表示纯内存生成并推送企微，不写入本地磁盘)
    SAVE_LOCAL_IMAGE: false,

    // 输出目录 (如需开启本地保存时生效)
    OUTPUT_DIR: path.join(__dirname, 'output'),
    LATEST_IMAGE_PATH: path.join(__dirname, 'latest-futures-5m-kline.png')
};
