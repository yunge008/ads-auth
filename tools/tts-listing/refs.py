"""卖家后台「批量编辑-全部信息」导出（商品表）→ refs.json，供生成标题/描述/属性时参考。

用法：python3 refs.py <PH 商品表.xlsx> <TH 商品表.xlsx> ... [-o work/refs.json]
站点从文件名前两个字母识别（PH/TH/MY/SG/VN/JP）。
一个 listing 可能包含多个 SPU（如 AR138/139/140/141 同链接），会挂到每个 SPU 名下。
"""
from __future__ import annotations

import argparse
import collections
import os
import re

from common import RawBook, SITES, dump_json, spu_of

IMG_COLS = ["main_image"] + [f"image_{i}" for i in range(2, 10)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("-o", "--out", default="work/refs.json")
    a = ap.parse_args()
    out: dict = {"sites": {}}
    for f in a.files:
        site = os.path.basename(f)[:2].upper()
        if site not in SITES:
            print("跳过（无法识别站点）:", f)
            continue
        b = RawBook(f)
        rows = b.rows("Template")
        hdr = rows[1]
        idx = {v: k for k, v in hdr.items()}
        data = [v for k, v in rows.items() if k >= 6 and v.get(idx["product_id"])]
        products: dict = collections.OrderedDict()
        for d in data:
            g = lambda name: d.get(idx[name]) if name in idx else None
            pid = g("product_id")
            p = products.setdefault(pid, {
                "product_id": pid, "category": g("category"), "title": g("product_name"),
                "description": g("product_description"), "brand": g("brand"),
                "parcel": {k: g(k) for k in ("parcel_weight", "parcel_length", "parcel_width", "parcel_height")},
                "images": [g(c) for c in IMG_COLS if g(c)],
                "properties": {h.split("/")[1]: d[k] for k, h in hdr.items() if h.startswith("product_property/") and d.get(k)},
                "cod": g("cod"), "skus": [],
            })
            p["skus"].append({"seller_sku": g("seller_sku"), "variation": g("variation_value"), "price": g("price")})
        by_spu: dict = collections.defaultdict(list)
        for p in products.values():
            spus = sorted({s for x in p["skus"] for part in str(x["seller_sku"] or "").split("+")[:1] if (s := spu_of(part))})
            for s in spus:
                by_spu[s].append(p["product_id"])
        out["sites"][site] = {"file": f, "products": products, "by_spu": by_spu,
                              "property_names": {h.split("/")[1]: rows[3].get(k) for k, h in hdr.items() if h.startswith("product_property/")}}
        print(f"{site}: 商品 {len(products)} 行 {len(data)} SPU {len(by_spu)}")
    dump_json(out, a.out)
    print("→", a.out)


if __name__ == "__main__":
    main()
