# -*- coding: utf-8 -*-
"""
stats.py — 價格統計（模組 D）
=============================
嚴格遵守需求：**不使用一般平均數（Mean）**，改用「中位數（Median）」
並以 Tukey IQR 方法剔除極端離群值。

集換式卡牌價格分布非常偏斜（同一張卡可以 $20 也可以 $5000），
所以先用 IQR 濾掉極端值，再取中位數，避免基準價被少數天價或瑕疵品灌水。
"""

from __future__ import annotations

import math
import statistics
from typing import List, Optional

from models import PriceStats


def quantile_sorted(sorted_vals: List[float], p: float) -> float:
    """分位數（線性插值），sorted_vals 必須已升冪排序。"""
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    idx = (len(sorted_vals) - 1) * p
    lo = math.floor(idx)
    hi = math.ceil(idx)
    if lo == hi:
        return float(sorted_vals[lo])
    return float(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (idx - lo))


def iqr_bounds(values: List[float], k: float = 1.5) -> dict:
    """Tukey IQR 上下界。"""
    vals = sorted(v for v in values if v is not None and v > 0)
    q1 = quantile_sorted(vals, 0.25)
    q3 = quantile_sorted(vals, 0.75)
    iqr = q3 - q1
    return {
        "q1": q1,
        "q3": q3,
        "iqr": iqr,
        "lower": q1 - k * iqr,
        "upper": q3 + k * iqr,
    }


def robust_median(values: List[float], k: float = 1.5, min_samples: int = 1) -> PriceStats:
    """計算穩健中位數：剔除 IQR 離群值後取中位數。

    :param values:      成交價陣列
    :param k:           IQR 倍數（預設 1.5）
    :param min_samples: 至少幾筆樣本才回傳有效結果（預設 1）
    """
    vals = sorted(v for v in values if v is not None and v > 0)
    count = len(vals)

    if count == 0:
        return PriceStats(count=0)

    bounds = iqr_bounds(vals, k)
    inliers = [v for v in vals if bounds["lower"] <= v <= bounds["upper"]]
    # 極端情況：全部被濾光（例如全部同價、IQR=0）時退回原始樣本，避免空結果
    used = inliers if inliers else vals

    if len(used) < min_samples:
        return PriceStats(
            count=count,
            used_count=len(used),
            removed=count - len(used),
            q1=bounds["q1"],
            q3=bounds["q3"],
            iqr=bounds["iqr"],
            lower=bounds["lower"],
            upper=bounds["upper"],
            values=used,
        )

    med = statistics.median(used)
    return PriceStats(
        count=count,
        used_count=len(used),
        removed=count - len(used),
        median=med,
        min=used[0],
        max=used[-1],
        q1=bounds["q1"],
        q3=bounds["q3"],
        iqr=bounds["iqr"],
        lower=bounds["lower"],
        upper=bounds["upper"],
        values=used,
    )


def discount_percent(price: float, baseline: float) -> float:
    """相對基準價的折扣百分比（正值 = 比基準便宜）。"""
    if not price or not baseline or baseline <= 0:
        return 0.0
    return (baseline - price) / baseline * 100.0
