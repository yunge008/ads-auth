"""第 3 步：同步后的各站点商品，用本地语言改写标题 / 描述（Seller Center「批量编辑 - 全部信息」模板）。

用法：python3 fill_localize.py --site TH <TH 批量编辑全部信息导出.xlsx> --specs work/listings/*.json [-o work/out/TH_localize.xlsx]

模板来源：Seller Center → 商品 → 批量编辑 → 全部信息 → 选中同步出来的商品导出（即之前给过的「商品表」格式）。
- 按商家 SKU 找到属于哪个 spec，整行写入该站点的 title / description（同一商品各行一致）。
- 变体选项（variation_value）在该模板里「不可编辑」，平台自动翻译的变体名保留；需改变体名只能后台手改或走 API。
- 输出文件只保留被改写的商品行（其余商品删掉，避免整店重新提交审核）；其他列不动；未匹配到 spec 的商品行不改；商品里只要有一个 SKU 不在同一个 spec 内（混合链接）就整条跳过。
"""
from __future__ import annotations

import argparse
import glob

from common import RawBook, SITES, dump_json, keep_only_rows, load_json, patch_xlsx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, choices=list(SITES))
    ap.add_argument("export")
    ap.add_argument("--specs", nargs="+", required=True)
    ap.add_argument("--product-ids", nargs="*", help="只改这些商品 ID（建议填同步出来的新商品 ID）")
    ap.add_argument("-o", "--out")
    a = ap.parse_args()
    out = a.out or f"work/out/{a.site}_localize.xlsx"
    by_sku = {}
    for sp in [x for s in a.specs for x in sorted(glob.glob(s))]:
        spec = load_json(sp)
        ss = spec.get("sites", {}).get(a.site)
        if ss:
            for k in spec["skus"]:
                by_sku[k["seller_sku"]] = (spec["spu"], ss)
    book = RawBook(a.export)
    rows = book.rows("Template")
    col = {v: k for k, v in rows[1].items()}
    if rows.get(2, {}).get(2) != "All_Information":
        print("[注意] 第 2 行不是 All_Information，确认导出的是「全部信息」模板")
    ups, rep = {}, {"site": a.site, "matched": [], "unmatched_products": set()}
    # 一个商品的全部 SKU 都属于同一个 spec 才改写（防止误改含其他款的混合链接）
    prod_skus: dict = {}
    for rn, r in rows.items():
        if rn >= 6 and r.get(col["product_id"]):
            prod_skus.setdefault(r[col["product_id"]], []).append((r.get(col["seller_sku"]) or "").strip())
    prod_spec: dict = {}
    rep["skipped_mixed"] = []
    for pid, skus in prod_skus.items():
        if a.product_ids and pid not in a.product_ids:
            continue
        hits = {by_sku[k][0] for k in skus if k in by_sku}
        if not hits:
            continue
        if len(hits) == 1 and all(k in by_sku for k in skus):
            prod_spec[pid] = by_sku[skus[0]]
        else:
            rep["skipped_mixed"].append({"product_id": pid, "skus": skus})
    for rn, r in rows.items():
        if rn < 6 or not r.get(col["product_id"]):
            continue
        hit = prod_spec.get(r[col["product_id"]])
        if not hit:
            rep["unmatched_products"].add(r[col["product_id"]])
            continue
        spu, ss = hit
        ups[rn] = {col["product_name"]: ss["title"], col["product_description"]: ss["description"]}
        rep["matched"].append({"row": rn, "product_id": r[col["product_id"]], "seller_sku": r.get(col["seller_sku"]), "spu": spu})
    patch_xlsx(a.export, out, {"Template": ups})
    keep_only_rows(out, out, "Template", 6, sorted(ups))  # 只上传要改的商品，避免整店商品被重新提交
    rep["unmatched_products"] = sorted(rep["unmatched_products"])
    dump_json(rep, out.rsplit(".", 1)[0] + ".report.json")
    print(f"{a.site}: 改写 {len(ups)} 行（{len(prod_spec)} 个商品），未匹配商品 {len(rep['unmatched_products'])} 个 → {out}")
    for x in rep["skipped_mixed"]:
        print(f"  [跳过] 商品 {x['product_id']} 含 spec 以外的 SKU，未改：{x['skus']}")


if __name__ == "__main__":
    main()
