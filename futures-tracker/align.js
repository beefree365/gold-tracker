/**
 * 双锚点时间加权线性插值对齐算法 (Dual-Anchor Time-Weighted Linear Interpolation)
 * 
 * 作用:
 * 1. 起点锚定: 锚定今日开盘价差 (期货今日开盘 - 现货今日开盘)，确保历史时段价格基准绝对准确，消除日内基差漂移。
 * 2. 终点锚定: 锚定当前实时平滑价差 (期货秒级现价 - 现货最新3根平滑均价)，过滤买卖一档跳价毛刺，确保最右侧与当前分钟无缝吻合。
 * 3. 动态平滑: 沿 24 小时时间轴平滑过渡，保留 100% 真实的 K 线内部振幅与高低点形态。
 */

function alignBarsWithDualAnchor(rawBars, currentFuturesPrice, futuresOpen) {
    if (!rawBars || rawBars.length === 0 || !currentFuturesPrice) {
        return rawBars || [];
    }

    const count = rawBars.length;
    const latestBar = rawBars[count - 1];
    const latestTs = new Date(latestBar.timestamp).getTime();

    // 1. 终点锚点: 最新实时平滑基差 (平滑最近 3 根蜡烛过滤微观买卖一档跳价毛刺)
    const recentBars = rawBars.slice(-3);
    const smoothedLatestSpot = recentBars.reduce((acc, b) => acc + b.close, 0) / recentBars.length;
    const latestOffset = currentFuturesPrice - smoothedLatestSpot;

    // 2. 起点锚点: 今日开盘基准基差
    const nowUtcDate = new Date().getUTCDate();
    const todayOpenBar = rawBars.find(b => new Date(b.timestamp).getUTCDate() === nowUtcDate) || rawBars[Math.floor(count / 2)];
    const openTs = new Date(todayOpenBar.timestamp).getTime();
    const spotOpen = todayOpenBar.open;

    const openOffset = (futuresOpen && futuresOpen > 0 && spotOpen > 0)
        ? (futuresOpen - spotOpen)
        : latestOffset;

    // 3. 沿 24 小时时间轴执行双锚点动态线性插值平滑
    const alignedBars = rawBars.map(b => {
        const ts = new Date(b.timestamp).getTime();
        let offset;
        if (ts <= openTs) {
            offset = openOffset;
        } else {
            const ratio = (ts - openTs) / Math.max(1, latestTs - openTs);
            offset = openOffset + (latestOffset - openOffset) * ratio;
        }

        return {
            timestamp: b.timestamp,
            open: b.open + offset,
            high: b.high + offset,
            low: b.low + offset,
            close: b.close + offset,
            volume: b.volume || 0
        };
    });

    // 4. 实时终点精准咬合: 将最后一根K线的最新收盘价强制咬合为当前的实时期货价
    if (alignedBars.length > 0 && currentFuturesPrice) {
        const last = alignedBars[alignedBars.length - 1];
        last.close = currentFuturesPrice;
        last.high = Math.max(last.high, currentFuturesPrice);
        last.low = Math.min(last.low, currentFuturesPrice);
    }

    return alignedBars;
}

module.exports = {
    alignBarsWithDualAnchor
};
