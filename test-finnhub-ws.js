require('dotenv').config();

const { WebSocket } = require('ws');

const token = process.env.FINNHUB_TOKEN;
const symbol = process.env.SPOT_SYMBOL || 'OANDA:XAU_USD';
const wsUrl = `wss://ws.finnhub.io?token=${token}`;

if (!token) {
    console.error('请先设置 FINNHUB_TOKEN 环境变量');
    process.exit(1);
}

console.log('=== Finnhub WebSocket 连接诊断 ===\n');
console.log('正在连接到:', wsUrl.replace(/token=[^&]+/i, 'token=***'));
console.log('订阅品种:', symbol);
console.log('');

const ws = new WebSocket(wsUrl);
let messageCount = 0;
let connectionTime = Date.now();

ws.on('open', () => {
    console.log('✓ 连接成功！');
    console.log('发送订阅请求...');
    
    ws.send(JSON.stringify({
        type: 'subscribe',
        symbol: symbol,
    }));
});

ws.on('message', (raw) => {
    messageCount++;
    const message = JSON.parse(raw.toString());
    
    if (messageCount <= 5) {
        console.log(`\n消息 #${messageCount}:`, JSON.stringify(message, null, 2));
    } else if (messageCount === 6) {
        console.log('\n... (后续消息省略，仅计数)');
    }
    
    // 每 10 条消息显示一次统计
    if (messageCount % 10 === 0) {
        const elapsed = ((Date.now() - connectionTime) / 1000).toFixed(1);
        console.log(`[已接收 ${messageCount} 条消息，运行时间: ${elapsed}s]`);
    }
});

ws.on('error', (error) => {
    console.error('✗ 连接错误:', error.message);
});

ws.on('close', (code, reason) => {
    const elapsed = ((Date.now() - connectionTime) / 1000).toFixed(1);
    console.log('\n=== 连接关闭 ===');
    console.log('关闭代码:', code);
    console.log('关闭原因:', reason ? reason.toString() : '(无)');
    console.log('总消息数:', messageCount);
    console.log('连接时长:', `${elapsed}s`);
    console.log('');
    
    // 解释关闭代码
    switch (code) {
        case 1000:
            console.log('说明: 正常关闭');
            break;
        case 1001:
            console.log('说明: 服务器离开或浏览器标签页关闭');
            break;
        case 1006:
            console.log('说明: 异常关闭（网络中断、服务器主动断开等）');
            console.log('      常见原因:');
            console.log('      - 免费版 WebSocket 连接时长限制');
            console.log('      - 订阅的品种不支持');
            console.log('      - API Token 无效或权限不足');
            console.log('      - 防火墙/代理拦截');
            break;
        case 4000:
            console.log('说明: Finnhub 自定义错误（可能是认证失败）');
            break;
        default:
            console.log(`说明: 未知关闭代码 (${code})`);
    }
    
    process.exit(0);
});

// 30 秒后自动退出
setTimeout(() => {
    console.log('\n⏱️  诊断超时（30秒），手动关闭连接...');
    ws.close();
}, 30000);
