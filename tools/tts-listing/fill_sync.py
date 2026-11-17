"""第 2 步：把 PH 商品同步到 MY / TH / VN / SG（Seller Center「同步本地商品」模板）。

用法（默认，API 自动取数，不用用户下载模板）：
  python3 fill_sync.py --specs "work/listings/*.json" [--source-product-id PH商品ID] [-o work/out/sync_filled.xlsx]
  → 按 spec 的 SKU + PH 标题在 PH 店铺找到新建的商品，取商品 ID / SKU ID / 变体，写进仓库内置空壳 templates/sync_local_product_shell.xlsx
备用（手动模式）：
  python3 fill_sync.py --template <后台下载的 sync_local_product_template.xlsx>   # 只填已有行的价格和库存

- 价格 = 该站点定价表「日常价 × 2」，按商家 SKU 查；商家 SKU 末尾带包装码（如 AR1060-B+B4）时用该包装，否则用站点默认包装。
- 库存 1000 写「The Chinese mainland Pickup Warehouse」列。
- 查不到价格的行价格留空并在报告列出（导入会报错，需人工补价或从 spec 里排除该 SKU）。
"""
from __future__ import annotations

import argparse
import glob
import re

from common import DEFAULT_STOCK, ROOT, SITES, RawBook, die, dump_json, load_json, patch_xlsx

PKG_RE = re.compile(r"\+([BD]\d+)$", re.I)
SHELL = ROOT / "templates" / "sync_local_product_shell.xlsx"
SOURCE_LANG = {"PH": "英语", "SG": "英语", "MY": "马来语", "TH": "泰语", "VN": "越南语"}


def price_of(prices: dict, site: str, sku: str):
    m = PKG_RE.search(sku)
    key, pkg = (sku[: m.start()], m.group(1).upper()) if m else (sku, SITES[site]["pkg"])
    return key, pkg, prices.get(site, {}).get(key, {}).get(pkg)


def api_rows(specs: list[str], source_site: str, source_pid: str | None) -> list[dict]:
    from from_api import category_label, find_source_product, get_product
    rows = []
    for sp in specs:
        spec = load_json(sp)
        shop_id, pid = find_source_product(source_site, spec, source_pid)
        p = get_product(shop_id, pid)
        print(f"{spec['spu']}: 源商品 {source_site} {pid}「{p.get('title')}」状态 {p.get('status')}，{len(p.get('skus') or [])} 个 SKU")
        if p.get("status") != "ACTIVATE":
            print(f"  [注意] 源商品状态不是在售（{p.get('status')}），后台可能不允许同步")
        for s in p.get("skus") or []:
            rows.append({
                "source_product_id": pid, "category": category_label(p), "product_name": p.get("title", ""),
                "source_sku_id": s.get("id", ""), "seller_sku": s.get("seller_sku", ""),
                "variation_value": ", ".join(a.get("value_name", "") for a in s.get("sales_attributes") or []),
                "input_language": SOURCE_LANG.get(source_site, "英语"),
            })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--specs", nargs="*")
    ap.add_argument("--template", help="手动模式：后台下载的同步模板；API 模式默认用内置空壳")
    ap.add_argument("--source-site", default="PH")
    ap.add_argument("--source-product-id")
    ap.add_argument("--prices", default="work/prices.json")
    ap.add_argument("--stock", type=int, default=DEFAULT_STOCK)
    ap.add_argument("-o", "--out", default="work/out/sync_filled.xlsx")
    a = ap.parse_args()
    specs = [x for s in (a.specs or []) for x in sorted(glob.glob(s))]
    if not specs and not a.template:
        die("给 --specs（API 自动取数）或 --template（手动模式）")
    tpl = a.template or str(SHELL)
    src_rows = api_rows(specs, a.source_site, a.source_product_id) if specs else None
    prices = load_json(a.prices)["sites"]
    book = RawBook(tpl)
    updates, report = {}, {"template": tpl, "sites": {}}
    for sheet in book.sheets:
        site = sheet.strip().upper()
        if site not in SITES:
            continue
        rows = book.rows(sheet)
        hdr, cn = rows[1], rows[3]
        col = {v: k for k, v in hdr.items()}
        qty = next((h for h in hdr.values() if h.startswith("warehouse_quantity/") and "Chinese mainland" in (cn.get(col[h]) or "")), None)
        if not qty:
            report["sites"][site] = {"error": "找不到 Chinese mainland 仓库列"}
            print(site, "找不到 Chinese mainland 仓库列，跳过")
            continue
        if src_rows is not None:   # API 模式：从第 6 行起整行写入
            data = {6 + i: dict(r) for i, r in enumerate(src_rows)}
        else:                      # 手动模式：只填已有行
            data = {rn: {"seller_sku": r.get(col["seller_sku"], "")} for rn, r in rows.items() if rn >= 6 and r.get(col["source_sku_id"])}
        ups, done, miss = {}, [], []
        for rn, r in data.items():
            sku = (r.get("seller_sku") or "").strip()
            key, pkg, p = price_of(prices, site, sku)
            # API 模式写整行（含商家 SKU）；手动模式只写价格和库存
            cells = {col[k]: v for k, v in r.items() if k in col} if src_rows is not None else {}
            if p:
                cells[col["price"]] = p["price"]
                cells[col[qty]] = a.stock
                done.append({"row": rn, "seller_sku": sku, "pkg": pkg, "price": p["price"]})
            else:
                miss.append({"row": rn, "seller_sku": sku, "key": key, "pkg": pkg,
                             "pkg_available": sorted(prices.get(site, {}).get(key, {}).keys())})
            if cells:
                ups[rn] = cells
        updates[sheet] = ups
        report["sites"][site] = {"filled": done, "missing_price": miss}
        print(f"{site}: 定价 {len(done)} 行，缺价 {len(miss)} 行" + (f" {[(x['seller_sku'], x['pkg'], x['pkg_available']) for x in miss]}" if miss else ""))
    patch_xlsx(tpl, a.out, {s: u for s, u in updates.items() if u})
    dump_json(report, a.out.rsplit(".", 1)[0] + ".report.json")
    print("→", a.out)


if __name__ == "__main__":
    main()
