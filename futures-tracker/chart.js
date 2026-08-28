const fs = require('fs');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const { calculateVWAP } = require('./indicators');

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
 * 绘制高质量 24 小时 5 分钟 K 线图 (1800x850, 亮色白底, 集成 VWAP 与 +-1σ, +-2σ 标准差轨道)
 */
function drawKlineChart(bars, triggerPrice, priceDiff, priceStep, sourceName) {
    const width = 1800;
    const height = 850;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const padLeft = 100;
    const padRight = 95;
    const padTop = 80;
    const padBottom = 80;
    const chartHeight = height - padTop - padBottom;
    const chartWidth = width - padLeft - padRight;

    // 1. 计算 VWAP 及标准差轨道
    const vwapData = calculateVWAP(bars);
    const latestVWAP = vwapData.length > 0 ? vwapData[vwapData.length - 1] : null;

    // 2. 亮色背景 (白色主画布 + 极简浅灰绘图区)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(padLeft, padTop, chartWidth, chartHeight);

    // 3. 顶部标题与数据源徽标
    ctx.fillStyle = '#0f172a';
    ctx.font = `bold 26px ${FONT_FAMILY}`;
    ctx.fillText('COMEX 黄金期货 24小时 5分钟 K线图', padLeft, 38);

    ctx.font = `14px ${FONT_FAMILY}`;
    ctx.fillStyle = '#64748b';
    ctx.fillText(`走势数据源: ${sourceName || '多源智能对齐'}`, padLeft + 480, 38);

    const stepStr = typeof priceStep === 'number' ? priceStep.toFixed(1) : (priceStep ? String(priceStep) : '2.0');
    const diffSign = typeof priceDiff === 'number' ? (priceDiff >= 0 ? '+' : '') : '';
    const diffStr = typeof priceDiff === 'number' && priceDiff !== 0 ? ` | 较上次: ${diffSign}$${priceDiff.toFixed(1)} (步长: $${stepStr})` : ` | 触发基准线: $${triggerPrice.toFixed(1)}`;
    const vwapHeaderStr = latestVWAP ? ` | VWAP: $${latestVWAP.vwap.toFixed(1)} (±1σ: $${latestVWAP.std.toFixed(1)})` : '';

    ctx.font = `16px ${FONT_FAMILY}`;
    ctx.fillStyle = '#d97706'; // 高对比度琥珀金
    ctx.fillText(`当前价格: $${triggerPrice.toFixed(1)}${diffStr}${vwapHeaderStr}`, padLeft, 68);

    const firstBar = bars[0];
    const lastBar = bars[bars.length - 1];
    const formatTime = (ts) => new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    ctx.font = `14px ${FONT_FAMILY}`;
    ctx.fillStyle = '#64748b';
    ctx.fillText(`时间跨度: ${formatTime(firstBar.timestamp)} ~ ${formatTime(lastBar.timestamp)} (共 ${bars.length} 根K线)`, padLeft + 780, 68);

    // 4. 计算价格极值与 Y 轴映射 (涵盖 K线、触发价与 VWAP +-2std 轨道)
    const allPrices = [
        ...bars.flatMap(b => [b.open, b.high, b.low, b.close]),
        triggerPrice,
        ...vwapData.flatMap(v => [v.upper2, v.lower2])
    ].filter(p => typeof p === 'number' && !isNaN(p));

    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const span = Math.max(1, maxPrice - minPrice);
    const padding = span * 0.06;
    const plotMin = minPrice - padding;
    const plotMax = maxPrice + padding;

    const priceToY = (p) => padTop + chartHeight - ((p - plotMin) / (plotMax - plotMin)) * chartHeight;

    // 5. 绘制水平网格与 Y 轴刻度
    const gridCount = 6;
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= gridCount; i++) {
        const y = padTop + (chartHeight / gridCount) * i;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();

        const priceLabel = (plotMax - ((plotMax - plotMin) / gridCount) * i).toFixed(1);
        ctx.fillStyle = '#475569';
        ctx.font = `12px ${FONT_FAMILY}`;
        ctx.textAlign = 'right';
        ctx.fillText(`$${priceLabel}`, padLeft - 12, y + 4);
    }

    // 绘图区浅灰边框
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, padTop, chartWidth, chartHeight);

    const count = bars.length;

    // 6. 绘制 VWAP 标准差轨道带阴影填充与线条 (按交易会话分段渲染，支持 06:00 每日重置)
    if (vwapData.length === count && count > 1) {
        // 按会话切分片段
        const segments = [];
        let currentSegment = [];
        for (let i = 0; i < count; i++) {
            if (vwapData[i].isNewSession && currentSegment.length > 0) {
                segments.push(currentSegment);
                currentSegment = [];
            }
            currentSegment.push({ index: i, data: vwapData[i] });
        }
        if (currentSegment.length > 0) {
            segments.push(currentSegment);
        }

        // 针对每个独立会话片段分别绘制阴影和线条
        for (const seg of segments) {
            if (seg.length < 2) continue;

            // A. 绘制 +-2σ 外部阴影带
            ctx.fillStyle = 'rgba(139, 92, 246, 0.04)';
            ctx.beginPath();
            for (let j = 0; j < seg.length; j++) {
                const x = padLeft + (seg[j].index + 0.5) * (chartWidth / count);
                const y = priceToY(seg[j].data.upper2);
                if (j === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            for (let j = seg.length - 1; j >= 0; j--) {
                const x = padLeft + (seg[j].index + 0.5) * (chartWidth / count);
                const y = priceToY(seg[j].data.lower2);
                ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.fill();

            // B. 绘制 +-1σ 内部核心阴影带
            ctx.fillStyle = 'rgba(139, 92, 246, 0.08)';
            ctx.beginPath();
            for (let j = 0; j < seg.length; j++) {
                const x = padLeft + (seg[j].index + 0.5) * (chartWidth / count);
                const y = priceToY(seg[j].data.upper1);
                if (j === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            for (let j = seg.length - 1; j >= 0; j--) {
                const x = padLeft + (seg[j].index + 0.5) * (chartWidth / count);
                const y = priceToY(seg[j].data.lower1);
                ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.fill();

            // C. 辅助函数：绘制分段线条
            const drawSegmentLine = (getY, color, lineWidth, dash) => {
                ctx.strokeStyle = color;
                ctx.lineWidth = lineWidth;
                ctx.setLineDash(dash || []);
                ctx.beginPath();
                for (let j = 0; j < seg.length; j++) {
                    const x = padLeft + (seg[j].index + 0.5) * (chartWidth / count);
                    const y = priceToY(getY(seg[j].data));
                    if (j === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
                ctx.setLineDash([]);
            };

            // 绘制 +-2σ 轨道 (紫色虚线)
            drawSegmentLine(v => v.upper2, '#c084fc', 1.2, [6, 4]);
            drawSegmentLine(v => v.lower2, '#c084fc', 1.2, [6, 4]);

            // 绘制 +-1σ 轨道 (紫蓝虚线)
            drawSegmentLine(v => v.upper1, '#a855f7', 1.3, [4, 3]);
            drawSegmentLine(v => v.lower1, '#a855f7', 1.3, [4, 3]);

            // 绘制 VWAP 主均线 (深紫实线)
            drawSegmentLine(v => v.vwap, '#7c3aed', 2.2, []);
        }

        // 最新 VWAP 气泡标签
        if (latestVWAP) {
            const lastX = width - padRight;
            const vwapY = priceToY(latestVWAP.vwap);
            ctx.fillStyle = '#7c3aed';
            ctx.fillRect(lastX + 6, vwapY - 10, 75, 20);
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold 11px ${FONT_FAMILY}`;
            ctx.textAlign = 'left';
            ctx.fillText(`V $${latestVWAP.vwap.toFixed(1)}`, lastX + 10, vwapY + 4);
        }
    }

    // 7. 绘制触发水平金色虚线
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
    ctx.fillRect(width - padRight + 6, trigY - 11, 75, 22);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 12px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(`$${triggerPrice.toFixed(1)}`, width - padRight + 12, trigY + 4);

    // 8. 绘制蜡烛图 (实体与上下影线)
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

    // 9. 底部多元素图例
    ctx.textAlign = 'left';
    
    // 上涨
    ctx.fillStyle = '#16a34a';
    ctx.fillRect(padLeft, height - 30, 12, 12);
    ctx.fillStyle = '#334155';
    ctx.font = `13px ${FONT_FAMILY}`;
    ctx.fillText('上涨 (Up)', padLeft + 18, height - 20);

    // 下跌
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(padLeft + 110, height - 30, 12, 12);
    ctx.fillStyle = '#334155';
    ctx.fillText('下跌 (Down)', padLeft + 128, height - 20);

    // 当前价格线
    ctx.fillStyle = '#d97706';
    ctx.fillRect(padLeft + 220, height - 30, 20, 3);
    ctx.fillStyle = '#334155';
    ctx.fillText(`当前价格线 ($${triggerPrice.toFixed(1)})`, padLeft + 248, height - 20);

    // VWAP 主线
    ctx.fillStyle = '#7c3aed';
    ctx.fillRect(padLeft + 410, height - 30, 20, 3);
    ctx.fillStyle = '#334155';
    ctx.fillText('VWAP 均线', padLeft + 438, height - 20);

    // +-1std
    ctx.fillStyle = '#a855f7';
    ctx.fillRect(padLeft + 540, height - 30, 20, 3);
    ctx.fillStyle = '#334155';
    ctx.fillText('±1σ 轨道', padLeft + 568, height - 20);

    // +-2std
    ctx.fillStyle = '#c084fc';
    ctx.fillRect(padLeft + 660, height - 30, 20, 3);
    ctx.fillStyle = '#334155';
    ctx.fillText('±2σ 轨道', padLeft + 688, height - 20);

    return canvas.toBuffer('image/png');
}

module.exports = {
    drawKlineChart
};
