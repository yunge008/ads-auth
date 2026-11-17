"""第 3 步：同步后的各站点商品，用本地语言改写标题 / 描述（Seller Center「批量编辑 - 全部信息」模板）。

用法（默认，API 自动取数，不用用户导出）：
  python3 fill_localize.py --site TH --specs "work/listings/*.json" [--source-product-id PH商品ID] [--target-product-id TH商品ID]
  → 在 PH 找到源商品 → 查它同步到 TH 的商品 ID → 取 TH 商品详情生成整行 → 写入 spec 的 TH 标题/描述
    → 写进仓库内置空壳 templates/<站点>_all_information_shell.xlsx
备用（手动模式）：
  python3 fill_localize.py --site TH --export <后台「全部信息」导出.xlsx> --specs ...

- 每个商品所有 SKU 行写同一个 title / description；其余列沿用平台现值（API 模式由商品详情生成，口径同 tts-export）。
- 变体选项（variation_value）在该模板里「不可编辑」，平台自动翻译的变体名保留；需改变体名只能后台手改或走 API。
- 输出文件只保留被改写的商品行（避免整店商品重新提交审核）；商品里有 SKU 不属于同一个 spec（混合链接）就整条跳过。
"""
from __future__ import annotations

import argparse
import glob

from common import ROOT, RawBook, SITES, die, dump_json, keep_only_rows, load_json, patch_xlsx


def load_specs(paths, site):
    by_sku, specs = {}, []
    for sp in [x for s in paths for x in sorted(glob.glob(s))]:
        spec = load_json(sp)
        ss = spec.get("sites", {}).get(site)
        if not ss:
            print(f"[注意] {spec['spu']} 没有 {site} 内容，跳过")
            continue
        specs.append(spec)
        for k in spec["skus"]:
            by_sku[k["seller_sku"]] = (spec["spu"], ss)
    return by_sku, specs


def api_mode(a, specs, by_sku):
    from api_push import pick_shop
    from from_api import all_information_rows, find_source_product, get_product, replicated_ids
    tpl = str(ROOT / "templates" / f"{a.site}_all_information_shell.xlsx")
    book = RawBook(tpl)
    col = {v: k for k, v in book.rows("Template")[1].items()}
    rows, rep = {}, {"site": a.site, "template": tpl, "products": [], "skipped_mixed": [], "dropped_columns": set()}
    target_shop = pick_shop(a.site, None)
    for spec in specs:
        if a.target_product_id:
            tpid = a.target_product_id
        else:
            src_shop, src_pid = find_source_product("PH", spec, a.source_product_id)
            ids = replicated_ids(src_shop, src_pid)
            tpid = ids.get(a.site)
            if not tpid:
                print(f"{spec['spu']}: PH 商品 {src_pid} 还没有同步到 {a.site}（已同步：{ids}），跳过")
                continue
        p = get_product(target_shop, tpid)
        lines = all_information_rows(p)
        skus = [r["seller_sku"] for r in lines]
        if not all(by_sku.get(s, (None,))[0] == spec["spu"] for s in skus):
            rep["skipped_mixed"].append({"product_id": tpid, "skus": skus})
            print(f"  [跳过] 商品 {tpid} 含 spec 以外的 SKU：{skus}")
            continue
        ss = spec["sites"][a.site]
        for r in lines:
            r["product_name"], r["product_description"] = ss["title"], ss["description"]
            rn = 6 + len(rows)
            rows[rn] = {col[k]: v for k, v in r.items() if k in col}
            rep["dropped_columns"] |= {k for k in r if k not in col and r[k] not in (None, "")}
        rep["products"].append({"spu": spec["spu"], "product_id": tpid, "status": p.get("status"), "skus": skus,
                                "old_title": p.get("title")})
        print(f"{spec['spu']}: {a.site} 商品 {tpid}（{p.get('status')}）{len(lines)} 行，原标题「{p.get('title')}」→ 新标题「{ss['title']}」")
    if not rows:
        die("没有可写的商品")
    out = a.out or f"work/out/{a.site}_localize.xlsx"
    patch_xlsx(tpl, out, {"Template": rows})
    rep["dropped_columns"] = sorted(rep["dropped_columns"])
    if rep["dropped_columns"]:
        print(f"[注意] 这些属性列在模板里没有，未写入：{rep['dropped_columns']}")
    return out, rep


def export_mode(a, by_sku):
    out = a.out or f"work/out/{a.site}_localize.xlsx"
    book = RawBook(a.export)
    rows = book.rows("Template")
    col = {v: k for k, v in rows[1].items()}
    if rows.get(2, {}).get(2) != "All_Information":
        print("[注意] 第 2 行不是 All_Information，确认导出的是「全部信息」模板")
    prod_skus: dict = {}
    for rn, r in rows.items():
        if rn >= 6 and r.get(col["product_id"]):
            prod_skus.setdefault(r[col["product_id"]], []).append((r.get(col["seller_sku"]) or "").strip())
    prod_spec, rep = {}, {"site": a.site, "skipped_mixed": [], "matched": []}
    for pid, skus in prod_skus.items():
        if a.target_product_id and pid != a.target_product_id:
            continue
        hits = {by_sku[k][0] for k in skus if k in by_sku}
        if not hits:
            continue
        if len(hits) == 1 and all(k in by_sku for k in skus):
            prod_spec[pid] = by_sku[skus[0]]
        else:
            rep["skipped_mixed"].append({"product_id": pid, "skus": skus})
            print(f"  [跳过] 商品 {pid} 含 spec 以外的 SKU：{skus}")
    ups = {}
    for rn, r in rows.items():
        hit = prod_spec.get(r.get(col["product_id"])) if rn >= 6 else None
        if hit:
            ups[rn] = {col["product_name"]: hit[1]["title"], col["product_description"]: hit[1]["description"]}
            rep["matched"].append({"row": rn, "product_id": r[col["product_id"]], "seller_sku": r.get(col["seller_sku"]), "spu": hit[0]})
    if not ups:
        die("导出文件里没有可改写的商品")
    patch_xlsx(a.export, out, {"Template": ups})
    keep_only_rows(out, out, "Template", 6, sorted(ups))
    print(f"{a.site}: 改写 {len(ups)} 行（{len(prod_spec)} 个商品）")
    return out, rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, choices=[s for s in SITES if s != "PH"])
    ap.add_argument("--specs", nargs="+", required=True)
    ap.add_argument("--export", help="手动模式：后台「全部信息」导出文件")
    ap.add_argument("--source-product-id", help="PH 源商品 ID（不填按 SKU+标题自动找）")
    ap.add_argument("--target-product-id", help="目标站点商品 ID（不填按同步关系自动找）")
    ap.add_argument("-o", "--out")
    a = ap.parse_args()
    by_sku, specs = load_specs(a.specs, a.site)
    out, rep = export_mode(a, by_sku) if a.export else api_mode(a, specs, by_sku)
    dump_json(rep, out.rsplit(".", 1)[0] + ".report.json")
    print("→", out)


if __name__ == "__main__":
    main()
