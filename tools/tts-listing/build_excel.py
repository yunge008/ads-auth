"""listing spec + 定价 + 图片 URL → 往 TikTok 批量上传模板里填行，产出可直接导入 Seller Center 的 xlsx。

用法：
  python3 build_excel.py --site PH --template "PH ...template.xlsx" --specs work/listings/*.json \
      [--prices work/prices.json] [--images work/images] [-o work/out/PH_upload.xlsx] [--allow-missing-images]

- 模板 styles.xml 不规范，openpyxl 打不开也写不回，这里直接改 sheet1.xml，其余文件（下拉、隐藏表、校验）原样保留。
- 数据从第 7 行开始写（1-6 行是模板表头/说明/示例）；同一 listing 每个 SKU 一行，商品级字段每行重复（与模板示例一致）。
- 售价 = prices.json 里该站点、该 SKU、站点默认包装的价格（日常价×2）；查不到的 SKU 不写，并在报告里列出。
- 库存 1000 写在「The Chinese mainland Pickup Warehouse」列（TTS-SEA 跨境发货）；SG 模板只有单一 quantity 列。
- 图片列写 TOS 公网 URL（work/images/urls.json）；未上传时默认报错退出，--allow-missing-images 时留空（只用于预览）。
"""
from __future__ import annotations

import argparse
import glob
import re
import shutil
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

from common import DEFAULT_STOCK, SITES, RawBook, col2n, die, dump_json, load_json, n2col

FIRST_ROW = 7


def cell_xml(ref: str, val, style: str | None) -> str:
    s = f' s="{style}"' if style else ""
    if val is None or val == "":
        return f'<c r="{ref}"{s}/>' if style else ""
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return f'<c r="{ref}"{s}><v>{val}</v></c>'
    txt = escape(str(val))
    return f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{txt}</t></is></c>'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, choices=list(SITES))
    ap.add_argument("--template", required=True)
    ap.add_argument("--specs", nargs="+", required=True)
    ap.add_argument("--prices", default="work/prices.json")
    ap.add_argument("--images", default="work/images")
    ap.add_argument("--stock", type=int, default=DEFAULT_STOCK)
    ap.add_argument("-o", "--out")
    ap.add_argument("--allow-missing-images", action="store_true")
    a = ap.parse_args()
    site, cfg = a.site, SITES[a.site]
    out = Path(a.out or f"work/out/{site}_upload.xlsx")

    prices = load_json(a.prices)["sites"].get(site, {})
    urls_p = Path(a.images) / "urls.json"
    urls = load_json(urls_p) if urls_p.exists() else {}

    book = RawBook(a.template)
    trows = book.rows("Template")
    hdr = trows[1]                      # 机器列名
    col = {v: k for k, v in hdr.items()}
    cn = trows[3]                       # 中文列名
    cats = {r.get(2): r.get(1) for r in book.rows("Category").values() if r.get(1)}
    brands = [r.get(1) for r in book.rows("Brand").values() if r.get(1)]
    # HiddenAttr：每两列一组（类目, 可选值），顺序与 product_property 列一致
    prop_cols = [h for h in hdr.values() if h.startswith("product_property/")]
    hidden = book.rows("HiddenAttr")
    allowed: dict[str, dict[str, set]] = {}
    for i, h in enumerate(prop_cols):
        for r in hidden.values():
            c_, v_ = r.get(2 * i + 1), r.get(2 * i + 2)
            if c_ and v_:
                allowed.setdefault(h.split("/")[1], {}).setdefault(c_, set()).add(v_)
    qty_cols = [h for h in hdr.values() if h.startswith("warehouse_quantity/") or h == "quantity"]
    qty_col = next((h for h in qty_cols if "Chinese mainland" in (cn.get(col[h]) or "")), None) or \
        next((h for h in qty_cols if h == "quantity"), None)
    if not qty_col:
        die(f"模板里找不到库存列：{[(h, cn.get(col[h])) for h in qty_cols]}")

    report = {"site": site, "template": a.template, "qty_column": cn.get(col[qty_col]), "listings": [], "errors": [], "warnings": []}
    rows_out: list[dict] = []
    specs = [p for s in a.specs for p in sorted(glob.glob(s))]
    for sp in specs:
        spec = load_json(sp)
        spu = spec["spu"]
        s_site = spec.get("sites", {}).get(site)
        if not s_site:
            report["warnings"].append(f"{spu}: spec 没有 {site} 站点内容，跳过")
            continue
        cat_name = cats.get(str(spec["category_id"]))
        if not cat_name:
            report["errors"].append(f"{spu}: 类目 {spec['category_id']} 不在 {site} 模板可选类目里")
            continue
        brand = spec.get("brand") or ""
        if brand and brand not in brands:
            report["errors"].append(f"{spu}: 品牌 {brand} 不在模板品牌列表 {brands}")
            continue
        title = s_site["title"]
        if not (25 <= len(title) <= 255):
            report["errors"].append(f"{spu}: 标题长度 {len(title)} 不在 25-255")
            continue

        def url_of(sha):
            if not sha:
                return ""
            u = urls.get(sha)
            if not u and not a.allow_missing_images:
                die(f"{spu}: 图片 {sha} 还没上传 TOS（先跑 tos_upload.py）")
            return u or ""

        imgs = [url_of(x) for x in spec["main_images"][:9]]
        props = {}
        for pid, v in (spec.get("properties") or {}).items():
            ok = allowed.get(pid, {}).get(cat_name)
            if ok and v not in ok:
                report["warnings"].append(f"{spu}: 属性 {pid}={v} 不在下拉可选值里（可选：{sorted(ok)[:15]}…），若该列不允许自定义会导入失败")
            props[pid] = v
        names = s_site.get("variant_names") or []
        done, missing = [], []
        for sku in spec["skus"]:
            code = sku["seller_sku"]
            if code in s_site.get("skip_skus", []):
                continue
            pk = prices.get(code, {}).get(cfg["pkg"])
            if not pk:
                missing.append({"sku": code, "pkg_available": sorted(prices.get(code, {}).keys())})
                continue
            vals = s_site.get("values", {}).get(code) or []
            if len(names) != len(vals) and len(spec["skus"]) > 1:
                report["errors"].append(f"{spu}/{code}: 变体名 {names} 与变体值 {vals} 数量不一致")
                continue
            r = {
                "category": cat_name, "brand": brand, "product_name": title,
                "product_description": s_site["description"],
                "parcel_weight": spec["parcel"]["weight"], "parcel_length": spec["parcel"]["length"],
                "parcel_width": spec["parcel"]["width"], "parcel_height": spec["parcel"]["height"],
                "price": pk["price"], qty_col: a.stock, "seller_sku": code,
                "special_product_listing_type": "Fixed price",
            }
            for i, u in enumerate(imgs):
                r["main_image" if i == 0 else f"image_{i + 1}"] = u
            if names:
                r["property_name_1"], r["property_value_1"] = names[0], vals[0]
                r["property_1_image"] = url_of(sku.get("image"))
                if len(names) > 1:
                    r["property_name_2"], r["property_value_2"] = names[1], vals[1]
            for pid, v in props.items():
                r[f"product_property/{pid}"] = v
            rows_out.append(r)
            done.append({"sku": code, "price": pk["price"], "values": vals})
        report["listings"].append({"spu": spu, "spec": sp, "title": title, "skus": done, "missing_price": missing})
        if missing:
            report["warnings"].append(f"{spu}: {len(missing)} 个 SKU 在 {site} 定价表（包装 {cfg['pkg']}）查不到，未写入：{missing}")

    if len(rows_out) > 2000 - FIRST_ROW + 1:
        die("行数超过模板上限（单文件 1994 行），请拆分 specs")

    # ── 写回 sheet1.xml ──
    target = book.sheets["Template"]
    xml = book.z.read(target).decode("utf-8")
    styles: dict[int, dict[int, str]] = {}
    for m in re.finditer(r'<row r="(\d+)"[^>]*?(?:/>|>(.*?)</row>)', xml, re.S):
        rn = int(m.group(1))
        if rn >= FIRST_ROW and m.group(2):
            styles[rn] = {}
            for c in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>.*?</c>)', m.group(2), re.S):
                s = re.search(r's="(\d+)"', c.group(2))
                if s:
                    styles[rn][col2n(c.group(1))] = s.group(1)

    def build_row(rn: int, data: dict | None) -> str:
        st = styles.get(rn, {})
        cells = {}
        for cnum, s in st.items():
            cells[cnum] = cell_xml(f"{n2col(cnum)}{rn}", None, s)
        for k, v in (data or {}).items():
            cnum = col[k]
            cells[cnum] = cell_xml(f"{n2col(cnum)}{rn}", v, st.get(cnum))
        body = "".join(cells[k] for k in sorted(cells) if cells[k])
        return f'<row r="{rn}">{body}</row>' if body else f'<row r="{rn}"/>'

    def repl(m):
        rn = int(m.group(1))
        if rn < FIRST_ROW:
            return m.group(0)
        i = rn - FIRST_ROW
        return build_row(rn, rows_out[i] if i < len(rows_out) else None)

    xml = re.sub(r'<row r="(\d+)"[^>]*?(?:/>|>.*?</row>)', repl, xml, flags=re.S)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(a.template) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = xml.encode("utf-8") if item.filename == target else zin.read(item.filename)
            zout.writestr(item, data)
    report["rows"] = len(rows_out)
    dump_json(report, out.with_suffix(".report.json"))
    print(f"{site}: 写入 {len(rows_out)} 行（{len(report['listings'])} 个 listing），库存列「{report['qty_column']}」→ {out}")
    for e in report["errors"]:
        print("  [错误]", e)
    for w in report["warnings"]:
        print("  [注意]", w)


if __name__ == "__main__":
    main()
