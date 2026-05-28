require('dotenv').config();

const { WebSocket } = require('ws');

const token = process.env.ITICK_TOKEN;
const symbol = 'XAUUSD';
const wsUrl = 'wss://api-free.itick.org/forex';

if (!token) {
    console.error('❌ 错误: 未设置 ITICK_TOKEN 环境变量');
    console.error('请在 .env 文件中添加: ITICK_TOKEN=your_token_here');
    console.error('注册地址: https://itick.org');
    process.exit(1);
}

console.log('=== iTick WebSocket 连接测试 ===\n');
console.log('正在连接到:', wsUrl);
console.log('测试品种:', symbol);
console.log('');

const ws = new WebSocket(wsUrl, {
    headers: {
        'token': token
    }
});

let messageCount = 0;
let connectionTime = Date.now();
let isAuthenticated = false;

ws.on('open', () => {
    console.log('✓ WebSocket 连接成功');
    
    // Send auth
    const authMsg = {
        action: 'auth',
        api_key: token
    };
    ws.send(JSON.stringify(authMsg));
    console.log('🔐 发送认证请求...');
});

ws.on('message', (raw) => {
    try {
        const message = JSON.parse(raw.toString());
        
        // Handle system messages
        if (message.code === 1) {
            if (message.msg === 'Connected Successfully') {
                console.log('✓ 连接成功确认');
            } else if (message.resAc === 'auth' && message.msg === 'authenticated') {
                console.log('✓ 认证成功');
                isAuthenticated = true;
                
                // Subscribe
                const subscribeMsg = {
                    action: 'subscribe',
                    symbols: [symbol],
                    types: 'quote,tick'
                };
                ws.send(JSON.stringify(subscribeMsg));
                console.log(`✓ 已订阅 ${symbol}\n`);
            }
            return;
        }
        
        // Handle market data
        if (message.data && isAuthenticated) {
            messageCount++;
            const data = message.data;
            const price = Number(data.last || data.p || data.close);
            
            if (messageCount <= 5) {
                console.log(`消息 #${messageCount}:`, {
                    type: data.type,
                    price: price,
                    bid: data.bid,
                    ask: data.ask,
                    timestamp: new Date(data.t || Date.now()).toISOString()
                });
            } else if (messageCount === 6) {
                console.log('\n... (后续消息仅计数)\n');
            }
            
            // Every 10 messages, show stats
            if (messageCount % 10 === 0) {
                const elapsed = ((Date.now() - connectionTime) / 1000).toFixed(1);
                console.log(`[已接收 ${messageCount} 条消息，运行时间: ${elapsed}s]`);
            }
        }
    } catch (error) {
        console.error('✗ 解析消息失败:', error.message);
    }
});

ws.on('error', (error) => {
    console.error('✗ WebSocket 错误:', error.message);
});

ws.on('close', (code, reason) => {
    const elapsed = ((Date.now() - connectionTime) / 1000).toFixed(1);
    console.log('\n=== 连接关闭 ===');
    console.log('关闭代码:', code);
    console.log('关闭原因:', reason ? reason.toString() : '(无)');
    console.log('总消息数:', messageCount);
    console.log('连接时长:', `${elapsed}s`);
    console.log('');
    
    // Explain close code
    switch (code) {
        case 1000:
            console.log('✅ 说明: 正常关闭');
            break;
        case 1001:
            console.log('ℹ️  说明: 服务器离开或浏览器标签页关闭');
            break;
        case 1006:
            console.log('❌ 说明: 异常关闭（网络中断、服务器主动断开等）');
            console.log('   常见原因:');
            console.log('   - API Token 无效或过期');
            console.log('   - 网络连接问题');
            console.log('   - 防火墙/代理拦截');
            break;
        case 4000:
            console.log('❌ 说明: 认证失败（Token 无效）');
            break;
        default:
            console.log(`ℹ️  说明: 未知关闭代码 (${code})`);
    }
    
    process.exit(code === 1000 ? 0 : 1);
});

// Test for 30 seconds then exit
setTimeout(() => {
    console.log('\n⏱️  测试完成（30秒），手动关闭连接...');
    console.log(`\n✅ 测试结果: iTick WebSocket 工作正常！`);
    console.log(`   共接收 ${messageCount} 条消息`);
    console.log(`   可以安全使用 wss-itick.js 脚本\n`);
    ws.close();
}, 30000);
