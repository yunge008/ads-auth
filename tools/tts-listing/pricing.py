"""定价表 → prices.json。

用法：python3 pricing.py <定价表.xlsx> [-o work/prices.json]

口径：
- SKU 键 = SKU1 + SKU3 + SKU4 + SKU5 依次用 "+" 连接（= 商家 SKU / seller_sku）；SKU2 是包装，单独匹配站点默认包装。
- 列按表头名定位（各站点 sheet 列位置不同）：SKU1..5 / 渠道 / 站点 在第 1 行；原价 / 日常价 在第 2 行
  （VN 的日常价 = 第 2 行「提价-日常价」）。
- 售价 = 日常价 × 2，按站点小数位四舍五入；同时记录原价，便于核对差异。
- 同一 (站点, SKU 键, 包装) 出现多个不同日常价 → 记为冲突，不取值。
"""
from __future__ import annotations

import argparse
import collections

import openpyxl

from common import CHANNEL, SITES, dump_json, round_price


def find_col(row, *names):
    for n in names:
        for i, v in enumerate(row):
            if isinstance(v, str) and v.strip().replace("\n", "") == n:
                return i
    return None


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("-o", "--out", default="work/prices.json")
    a = ap.parse_args()

    wb = openpyxl.load_workbook(a.xlsx, data_only=True, read_only=True)
    result: dict = {"source": a.xlsx, "sites": {}, "report": {}}
    for site, cfg in SITES.items():
        if cfg["sheet"] not in wb.sheetnames:
            result["report"][site] = {"error": f"缺 sheet {cfg['sheet']}"}
            continue
        rows = list(wb[cfg["sheet"]].iter_rows(values_only=True))
        h1, h2 = rows[0], rows[1]
        c = {k: find_col(h1, k) for k in ["SKU1", "SKU2", "SKU3", "SKU4", "SKU5", "渠道", "站点", "产品毛重(g)", "计费重量(g)"]}
        c["orig"] = find_col(h2, "原价")
        c["daily"] = find_col(h2, "提价-日常价", "日常价")
        missing = [k for k in ("SKU1", "SKU2", "渠道", "站点", "orig", "daily") if c[k] is None]
        if missing:
            result["report"][site] = {"error": f"表头缺列 {missing}"}
            continue
        groups: dict = collections.defaultdict(list)
        skipped = collections.Counter()
        for r in rows[2:]:
            sku1 = r[c["SKU1"]]
            if not sku1:
                continue
            if r[c["渠道"]] != CHANNEL:
                skipped["渠道非TTS-SEA"] += 1
                continue
            if str(r[c["站点"]]).strip() != site:
                skipped["站点不符"] += 1
                continue
            parts = [str(sku1).strip()] + [str(r[c[k]]).strip() for k in ("SKU3", "SKU4", "SKU5") if c[k] is not None and r[c[k]]]
            key = "+".join(parts)
            pkg = str(r[c["SKU2"]] or "").strip()
            groups[(key, pkg)].append({
                "daily": num(r[c["daily"]]), "orig": num(r[c["orig"]]),
                "gross_g": num(r[c["产品毛重(g)"]]) if c["产品毛重(g)"] is not None else None,
                "charge_g": num(r[c["计费重量(g)"]]) if c["计费重量(g)"] is not None else None,
            })
        out: dict = {}
        conflicts, nodaily = [], []
        for (key, pkg), lst in groups.items():
            dailies = {x["daily"] for x in lst if x["daily"]}
            if len(dailies) > 1:
                conflicts.append({"sku": key, "pkg": pkg, "daily": sorted(dailies)})
                continue
            if not dailies:
                nodaily.append({"sku": key, "pkg": pkg})
                continue
            x = next(x for x in lst if x["daily"])
            price = round_price(x["daily"] * 2, cfg["dec"])
            out.setdefault(key, {})[pkg] = {
                "price": price, "daily": x["daily"], "orig": x["orig"],
                "orig_diff": (round(price - x["orig"], 2) if x["orig"] else None),
                "gross_g": x["gross_g"], "charge_g": x["charge_g"], "rows": len(lst),
            }
        result["sites"][site] = out
        result["report"][site] = {
            "sheet": cfg["sheet"], "default_pkg": cfg["pkg"], "skus": len(out),
            "with_default_pkg": sum(1 for v in out.values() if cfg["pkg"] in v),
            "conflicts": conflicts, "no_daily_price": nodaily, "skipped": dict(skipped),
            "price_ne_orig": sum(1 for v in out.values() for p in v.values() if p["orig_diff"] not in (None, 0, 0.0)),
        }
    dump_json(result, a.out)
    for s, r in result["report"].items():
        if "error" in r:
            print(s, r["error"])
        else:
            print(f"{s}: SKU {r['skus']}（有默认包装 {r['default_pkg']} 的 {r['with_default_pkg']}）"
                  f" 冲突 {len(r['conflicts'])} 无日常价 {len(r['no_daily_price'])} 售价≠原价 {r['price_ne_orig']} 跳过 {r['skipped']}")
    print("→", a.out)


if __name__ == "__main__":
    main()
