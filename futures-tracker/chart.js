const fs = require('fs');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// 注册系统中文字体
function initChineseFonts() {
    const candidatePaths = [
        'C:/Windows/Fonts/msyh.ttc',
        'C:/Windows/Fonts/msyhbd.ttc',
        'C:/Windows/Fonts/simhei.ttf',
        'C:/Windows/Fonts/simsun.ttc',
        '/System/Library/Fonts/PingFang.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'
    ];
    for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
            try {
                GlobalFonts.registerFromPath(p, 'ChineseFont');
                break;
            } catch (e) {}
        }
    }
}
initChineseFonts();

const FONT_FAMILY = 'ChineseFont, "Microsoft YaHei", "PingFang SC", "SimHei", sans-serif';

/**
 * 绘制高质量 24 小时 5 分钟 K 线图 (1800x850, 亮色白底)
 */
function drawKlineChart(bars, triggerPrice, priceDiff, priceStep, sourceName) {
    const width = 1800;
    const height = 850;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const padLeft = 100;
    const padRight = 80;
    const padTop = 80;
    const padBottom = 80;
    const chartHeight = height - padTop - padBottom;
    const chartWidth = width - padLeft - padRight;

    // 1. 亮色背景 (白色主画布 + 极简浅灰绘图区)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(padLeft, padTop, chartWidth, chartHeight);

    // 2. 顶部标题与数据源徽标
    ctx.fillStyle = '#0f172a';
    ctx.font = `bold 26px ${FONT_FAMILY}`;
    ctx.fillText('COMEX 黄金期货 24小时 5分钟 K线图', padLeft, 38);

    ctx.font = `14px ${FONT_FAMILY}`;
    ctx.fillStyle = '#64748b';
    ctx.fillText(`📊 走势数据源: ${sourceName || '多源智能对齐'}`, padLeft + 480, 38);

    const diffSign = typeof priceDiff === 'number' ? (priceDiff >= 0 ? '+' : '') : '';
    const diffStr = typeof priceDiff === 'number' && priceDiff !== 0 ? ` | 较上次: ${diffSign}$${priceDiff.toFixed(2)} (步长: $${priceStep || 2.0})` : ` | 触发基准线: $${triggerPrice.toFixed(2)}`;

    ctx.font = `16px ${FONT_FAMILY}`;
    ctx.fillStyle = '#d97706'; // 高对比度琥珀金
    ctx.fillText(`🎯 当前价格: $${triggerPrice.toFixed(2)}${diffStr}`, padLeft, 68);

    const firstBar = bars[0];
    const lastBar = bars[bars.length - 1];
    const formatTime = (ts) => new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    ctx.font = `14px ${FONT_FAMILY}`;
    ctx.fillStyle = '#64748b';
    ctx.fillText(`时间跨度: ${formatTime(firstBar.timestamp)}  ➜  ${formatTime(lastBar.timestamp)}  (共 ${bars.length} 根K线)`, padLeft + 620, 68);

    // 3. 计算价格极值与 Y 轴映射
    const allPrices = bars.flatMap(b => [b.open, b.high, b.low, b.close, triggerPrice]);
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const span = Math.max(1, maxPrice - minPrice);
    const padding = span * 0.06;
    const plotMin = minPrice - padding;
    const plotMax = maxPrice + padding;

    const priceToY = (p) => padTop + chartHeight - ((p - plotMin) / (plotMax - plotMin)) * chartHeight;

    // 4. 绘制水平网格与 Y 轴刻度
    const gridCount = 6;
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= gridCount; i++) {
        const y = padTop + (chartHeight / gridCount) * i;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();

        const priceLabel = (plotMax - ((plotMax - plotMin) / gridCount) * i).toFixed(2);
        ctx.fillStyle = '#475569';
        ctx.font = `12px ${FONT_FAMILY}`;
        ctx.textAlign = 'right';
        ctx.fillText(`$${priceLabel}`, padLeft - 12, y + 4);
    }

    // 绘图区浅灰边框
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, padTop, chartWidth, chartHeight);

    // 5. 绘制触发水平金色虚线
    const trigY = priceToY(triggerPrice);
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(padLeft, trigY);
    ctx.lineTo(width - padRight, trigY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 触发价金色气泡标签
    ctx.fillStyle = '#d97706';
    ctx.fillRect(width - padRight + 6, trigY - 11, 70, 22);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 12px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(`$${triggerPrice.toFixed(2)}`, width - padRight + 12, trigY + 4);

    // 6. 绘制蜡烛图 (实体与上下影线)
    const count = bars.length;
    const candleWidth = Math.max(2, (chartWidth / count) * 0.72);
    const labelStep = Math.max(1, Math.floor(count / 12));

    for (let i = 0; i < count; i++) {
        const bar = bars[i];
        const x = padLeft + (i + 0.5) * (chartWidth / count);
        const openY = priceToY(bar.open);
        const closeY = priceToY(bar.close);
        const highY = priceToY(bar.high);
        const lowY = priceToY(bar.low);

        const isUp = bar.close >= bar.open;
        const color = isUp ? '#16a34a' : '#dc2626';

        // 影线
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        // 实体
        ctx.fillStyle = color;
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
        ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);

        // 时间轴刻度标签
        if (i % labelStep === 0 || i === count - 1) {
            ctx.strokeStyle = '#94a3b8';
            ctx.beginPath();
            ctx.moveTo(x, padTop + chartHeight);
            ctx.lineTo(x, padTop + chartHeight + 6);
            ctx.stroke();

            const timeStr = new Date(bar.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
            ctx.fillStyle = '#475569';
            ctx.font = `11px ${FONT_FAMILY}`;
            ctx.textAlign = 'center';
            ctx.fillText(timeStr, x, height - 55);
        }
    }

    // 7. 底部图例
    ctx.textAlign = 'left';
    ctx.fillStyle = '#16a34a';
    ctx.fillRect(padLeft, height - 30, 12, 12);
    ctx.fillStyle = '#334155';
    ctx.font = `13px ${FONT_FAMILY}`;
    ctx.fillText('上涨 (Up)', padLeft + 18, height - 20);

    ctx.fillStyle = '#dc2626';
    ctx.fillRect(padLeft + 120, height - 30, 12, 12);
    ctx.fillStyle = '#334155';
    ctx.fillText('下跌 (Down)', padLeft + 138, height - 20);

    ctx.fillStyle = '#d97706';
    ctx.fillRect(padLeft + 240, height - 30, 20, 3);
    ctx.fillStyle = '#334155';
    ctx.fillText(`当前价格线 ($${triggerPrice.toFixed(2)})`, padLeft + 268, height - 20);

    return canvas.toBuffer('image/png');
}

module.exports = {
    drawKlineChart
};
