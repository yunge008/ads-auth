"""第 2 步：把 PH 商品同步到 MY / TH / VN / SG（Seller Center「同步本地商品」模板）。

用法：python3 fill_sync.py <sync_local_product_template.xlsx> [--prices work/prices.json] [-o work/out/sync_filled.xlsx]

模板来源：Seller Center 勾选已发布的 PH 商品 → 批量操作 → 同步到其他站点 → 下载模板
（模板每个站点一个 sheet，已预填源商品 ID / SKU ID / 商家 SKU，只需填 price 和仓库数量）。
- 价格 = 该站点定价表「日常价 × 2」，按商家 SKU 查；商家 SKU 末尾带包装码（如 AR1060-B+B4）时用该包装，否则用站点默认包装。
- 库存 1000 写「The Chinese mainland Pickup Warehouse」列。
- 查不到价格的行不填，打印出来；同步后翻译由平台自动完成，本地化改稿走 fill_localize.py。
"""
from __future__ import annotations

import argparse
import re

from common import DEFAULT_STOCK, SITES, RawBook, dump_json, load_json, patch_xlsx

PKG_RE = re.compile(r"\+([BD]\d+)$", re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("template")
    ap.add_argument("--prices", default="work/prices.json")
    ap.add_argument("--stock", type=int, default=DEFAULT_STOCK)
    ap.add_argument("-o", "--out", default="work/out/sync_filled.xlsx")
    a = ap.parse_args()
    prices = load_json(a.prices)["sites"]
    book = RawBook(a.template)
    updates, report = {}, {}
    for sheet in book.sheets:
        site = sheet.strip().upper()
        if site not in SITES:
            continue
        rows = book.rows(sheet)
        hdr, cn = rows[1], rows[3]
        col = {v: k for k, v in hdr.items()}
        qty = next((h for h in hdr.values() if h.startswith("warehouse_quantity/") and "Chinese mainland" in (cn.get(col[h]) or "")), None)
        if not qty:
            report[site] = {"error": f"找不到 Chinese mainland 仓库列：{[cn.get(col[h]) for h in hdr.values() if h.startswith('warehouse_quantity/')]}"}
            continue
        ups, done, miss = {}, [], []
        for rn, r in rows.items():
            if rn < 6 or not r.get(col["source_sku_id"]):
                continue
            sku = (r.get(col["seller_sku"]) or "").strip()
            m = PKG_RE.search(sku)
            key, pkg = (sku[: m.start()], m.group(1).upper()) if m else (sku, SITES[site]["pkg"])
            p = prices.get(site, {}).get(key, {}).get(pkg)
            if not p:
                miss.append({"row": rn, "seller_sku": sku, "key": key, "pkg": pkg,
                             "pkg_available": sorted(prices.get(site, {}).get(key, {}).keys())})
                continue
            ups[rn] = {col["price"]: p["price"], col[qty]: a.stock}
            done.append({"row": rn, "seller_sku": sku, "pkg": pkg, "price": p["price"]})
        updates[sheet] = ups
        report[site] = {"filled": done, "missing_price": miss}
        print(f"{site}: 填 {len(done)} 行，缺价 {len(miss)} 行" + (f" {[(x['seller_sku'], x['pkg']) for x in miss]}" if miss else ""))
    patch_xlsx(a.template, a.out, {s: u for s, u in updates.items() if u})
    dump_json(report, a.out.rsplit(".", 1)[0] + ".report.json")
    print("→", a.out)


if __name__ == "__main__":
    main()
