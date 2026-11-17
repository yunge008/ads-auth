"""经 Edge Function `tts-listing` 的只读动作取商品数据，给 Excel 方案自动填表（不用用户手动下载/导出）。

依赖：环境变量 ADS_AUTH_PASSCODE；店铺授权含 Product Basic 权限包。
"""
from __future__ import annotations

from api_push import call, pick_shop
from common import die

STATUS_CN = {"ACTIVATE": "在售(1)", "SELLER_DEACTIVATED": "已下架", "PLATFORM_DEACTIVATED": "平台下架", "DRAFT": "草稿",
             "PENDING": "审核中", "FAILED": "审核失败", "FREEZE": "冻结", "DELETED": "已删除"}


def find_source_product(site: str, spec: dict, product_id: str | None = None) -> tuple[str, str]:
    """在 site 店铺找到这个 spec 新建的商品：SKU 全部属于 spec，且标题与 spec 该站点标题一致；多个取最新。返回 (shop_id, product_id)。"""
    shop_id = pick_shop(site, None)
    if product_id:
        return shop_id, product_id
    skus = [s["seller_sku"] for s in spec["skus"]]
    r = call("find_products", shop_id=shop_id, seller_skus=skus)
    if not r.get("ok"):
        die(f"{site} 搜商品失败：{r}")
    title = (spec.get("sites", {}).get(site) or {}).get("title")
    cands = []
    for p in r.get("products") or []:
        ps = {s.get("seller_sku") for s in p.get("skus") or []}
        if ps and ps <= set(skus):
            cands.append(p)
    exact = [p for p in cands if title and p.get("title") == title]
    pick = sorted(exact or cands, key=lambda p: int(p.get("create_time") or 0), reverse=True)
    if not pick:
        die(f"{site} 找不到 SKU 全部属于 {skus} 的商品（导入/审核完成了吗？），可用 --source-product-id 指定")
    if not exact:
        print(f"[注意] {site} 没有标题完全一致的商品，按最新创建取 {pick[0]['id']}「{pick[0].get('title')}」")
    if len(exact) > 1:
        print(f"[注意] {site} 有 {len(exact)} 个同标题商品，取最新 {pick[0]['id']}；其他：{[p['id'] for p in exact[1:]]}")
    return shop_id, str(pick[0]["id"])


def get_product(shop_id: str, product_id: str, locale: str = "zh-CN") -> dict:
    r = call("product", shop_id=shop_id, product_id=product_id, locale=locale)
    p = (r.get("products") or {}).get(product_id)
    if not p or "title" not in p:
        die(f"取商品详情失败 {product_id}: {p}")
    return p


def replicated_ids(shop_id: str, product_id: str) -> dict[str, str]:
    r = call("replicated", shop_id=shop_id, product_id=product_id)
    if not r.get("ok"):
        die(f"查同步副本失败 {product_id}: {r}")
    return {x["region"].upper(): x["product_id"] for x in (r.get("data") or {}).get("replicated_products") or []}


def category_label(p: dict) -> str:
    chain = p.get("category_chains") or []
    leaf = next((c for c in chain if c.get("is_leaf")), chain[-1] if chain else None)
    return f"{leaf.get('local_name', '')} ({leaf.get('id', '')})" if leaf else ""


def _grams(w: dict | None):
    if not w or not w.get("value"):
        return None
    v = float(w["value"])
    if w.get("unit") == "GRAM":
        return round(v)
    if w.get("unit") == "POUND":
        return round(v * 453.592)
    g = round(v * 1000, 2)
    return int(g) if g == int(g) else g


def _num(v):
    return None if v in (None, "") else float(v) if "." in str(v) else int(v)


def all_information_rows(p: dict) -> list[dict]:
    """Get Product 详情 → 「批量编辑-全部信息」模板行（列名 = 机器列名），口径与 tts-export 的商品导出一致。"""
    imgs = [(i.get("urls") or [""])[0] for i in p.get("main_images") or []]
    dim = p.get("package_dimensions") or {}
    attrs = {f"product_property/{a['id']}": ",".join(v.get("name", "") for v in a.get("values") or [] if v.get("name"))
             for a in p.get("product_attributes") or [] if a.get("id")}
    sc = p.get("size_chart") or {}
    rows = []
    for s in p.get("skus") or []:
        price = s.get("price") or {}
        row = {
            "product_id": p["id"], "category": category_label(p), "product_name": p.get("title", ""),
            "product_status": STATUS_CN.get(p.get("status", ""), p.get("status", "")), "sku_id": s.get("id", ""),
            "variation_value": ", ".join(a.get("value_name", "") for a in s.get("sales_attributes") or []),
            "product_description": p.get("description", ""),
            "brand": f"{p['brand'].get('name', '')} ({p['brand'].get('id', '')})" if (p.get("brand") or {}).get("name") else "",
            "price": _num(price.get("sale_price")),
            "pre_order_time": ((s.get("pre_sale") or {}).get("fulfillment_type") or {}).get("handling_duration_days"),
            "seller_sku": s.get("seller_sku", ""),
            "parcel_weight": _grams(p.get("package_weight")), "parcel_length": _num(dim.get("length")),
            "parcel_width": _num(dim.get("width")), "parcel_height": _num(dim.get("height")),
            "cod": "" if p.get("is_cod_allowed") is None else ("Y" if p["is_cod_allowed"] else "N"),
            "size_chart": (sc.get("template") or {}).get("id") or ((sc.get("image") or {}).get("urls") or [""])[0],
            "special_product_listing_type": "Live auction" if p.get("selling_format") == "AUCTION" else "Fixed price",
            "auction_starting_price": _num(price.get("starting_bid_price")),
            **attrs,
        }
        for i, u in enumerate(imgs[:9]):
            row["main_image" if i == 0 else f"image_{i + 1}"] = u
        rows.append(row)
    return rows
