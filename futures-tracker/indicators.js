/**
 * 计算成交量加权平均价 (VWAP) 及 1 倍、2 倍标准差轨道线 (VWAP Standard Deviation Bands)
 * 
 * 公式:
 * Typical Price (TP) = (High + Low + Close) / 3
 * VWAP = Σ(TP * Volume) / Σ(Volume)
 * Variance = Σ(Volume * (TP - VWAP)^2) / Σ(Volume)
 * Standard Deviation (σ) = sqrt(Variance)
 * 
 * 轨道线:
 * Upper Band 2 (UB2) = VWAP + 2 * σ
 * Upper Band 1 (UB1) = VWAP + 1 * σ
 * Lower Band 1 (LB1) = VWAP - 1 * σ
 * Lower Band 2 (LB2) = VWAP - 2 * σ
 */

function calculateVWAP(bars) {
    if (!bars || bars.length === 0) {
        return [];
    }

    let cumVolume = 0;
    let cumTypicalVolume = 0;
    let cumVarianceSum = 0;

    const results = [];

    for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        const tp = (bar.high + bar.low + bar.close) / 3;
        // 如果当前数据源无 volume 或 volume 为 0，退化为均匀加权 1.0 (TWAP 保底)
        const vol = (typeof bar.volume === 'number' && bar.volume > 0) ? bar.volume : 1.0;

        cumVolume += vol;
        cumTypicalVolume += tp * vol;

        const currentVWAP = cumTypicalVolume / cumVolume;

        // 计算加权方差 (基于当前累计加权均价)
        cumVarianceSum += vol * Math.pow(tp - currentVWAP, 2);
        const variance = cumVarianceSum / cumVolume;
        const std = Math.sqrt(variance);

        results.push({
            timestamp: bar.timestamp,
            vwap: currentVWAP,
            std: std,
            upper1: currentVWAP + 1 * std,
            lower1: currentVWAP - 1 * std,
            upper2: currentVWAP + 2 * std,
            lower2: currentVWAP - 2 * std
        });
    }

    return results;
}

module.exports = {
    calculateVWAP
};
