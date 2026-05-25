const { WebSocket } = require('ws');

const token = process.env.FINNHUB_TOKEN;
const symbol = process.env.FINNHUB_SYMBOL || 'OANDA:XAU_USD';
const reconnectDelay = Number(process.env.FINNHUB_RECONNECT_DELAY_MS || 3000);
const wsUrl = process.env.FINNHUB_WS_URL || `wss://ws.finnhub.io?token=${token}`;
const displayWsUrl = wsUrl.replace(/token=[^&]+/i, 'token=***');

if (!token) {
    console.error('请先设置 FINNHUB_TOKEN');
    process.exit(1);
}

let ws;
let reconnectTimer = null;
let isConnecting = false;

function log(message, extra) {
    const payload = extra ? ` ${JSON.stringify(extra)}` : '';
    console.log(`[${new Date().toISOString()}] ${message}${payload}`);
}

function subscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    ws.send(JSON.stringify({
        type: 'subscribe',
        symbol,
    }));

    log(`已订阅 ${symbol}`);
}

function connect() {
    if (isConnecting) {
        return;
    }

    isConnecting = true;

    log(`正在连接 ${displayWsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        isConnecting = false;
        log('WebSocket 已连接');
        subscribe();
    });

    ws.on('message', (raw) => {
        try {
            const message = JSON.parse(raw.toString());
            handleMessage(message);
        } catch (error) {
            log('解析消息失败', { error: error.message, raw: raw.toString() });
        }
    });

    ws.on('error', (error) => {
        log('WebSocket 错误', { error: error.message });
    });

    ws.on('close', () => {
        isConnecting = false;
        log('WebSocket 已关闭，准备重连');

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
        }

        reconnectTimer = setTimeout(() => {
            connect();
        }, reconnectDelay);
    });
}

function handleMessage(message) {
    if (message.type === 'trade') {
        const trade = message.data?.[0];
        if (!trade) {
            return;
        }

        log('收到实时交易数据', {
            symbol: trade.s,
            price: trade.p,
            volume: trade.v,
            timestamp: trade.t,
        });
        return;
    }

    if (message.type === 'quote') {
        const quote = message.data?.[0];
        if (!quote) {
            return;
        }

        log('收到实时报价数据', {
            symbol: quote.s,
            price: quote.p,
            high: quote.h,
            low: quote.l,
            timestamp: quote.t,
        });
        return;
    }

    if (message.type === 'ping') {
        return;
    }

    if (message.type === 'error') {
        log('服务端返回错误', message);
        return;
    }

    log('收到未知消息类型', message);
}

process.on('SIGINT', () => {
    log('收到退出信号，关闭连接');
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    if (ws) {
        ws.close();
    }

    process.exit(0);
});

connect();
