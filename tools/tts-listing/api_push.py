"""listing spec → 经 Edge Function `tts-listing` 在 TikTok Shop 建「草稿」（不会直接上架）。

用法：
  python3 api_push.py shops                                   # 看已授权店铺 / 站点 / scope
  python3 api_push.py push --site PH --specs work/listings/*.json [--shop-id 店铺ID] [--dry-run]

环境变量：ADS_AUTH_PASSCODE（网站管理员口令，必填）；ADS_AUTH_NAME（可选，管理员名）。
Supabase 地址与公开 key 从仓库根目录 .env 读（SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY）。

流程（每个站点）：
  1. 找店铺（--shop-id，或 shops 里 region=站点 的唯一店铺）
  2. prepare：取仓库列表 + 类目属性；库存仓库默认选名称含 "Chinese mainland" 的仓库（--warehouse 可指定 ID）
  3. 图片：TOS URL → upload_image → TikTok uri（缓存在 work/images/tts_uris.json，同店铺不重复传）
  4. 组装 Create Product 请求体 → create_draft（idempotency_key = 站点+SPU+spec 内容哈希，重跑不重复建）
--dry-run：只组装请求体写到 work/out/<site>_<spu>.payload.json，不传图、不建草稿。
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

from common import DEFAULT_STOCK, REPO, SITES, die, dump_json, load_json


def repo_env() -> dict:
    env = {}
    p = REPO / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"')
    return env


def call(action: str, **body):
    env = repo_env()
    base = os.environ.get("SUPABASE_URL") or env.get("SUPABASE_URL") or env.get("VITE_SUPABASE_URL")
    key = os.environ.get("SUPABASE_PUBLISHABLE_KEY") or env.get("SUPABASE_PUBLISHABLE_KEY") or env.get("VITE_SUPABASE_PUBLISHABLE_KEY")
    pw = os.environ.get("ADS_AUTH_PASSCODE")
    if not (base and key):
        die("找不到 SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY（仓库 .env）")
    if not pw:
        die("缺环境变量 ADS_AUTH_PASSCODE（网站管理员口令）")
    req = urllib.request.Request(
        f"{base.rstrip('/')}/functions/v1/tts-listing", method="POST",
        data=json.dumps({"action": action, **body}).encode(),
        headers={"content-type": "application/json", "apikey": key, "authorization": f"Bearer {key}",
                 "x-admin-passcode": pw, "x-admin-name": urllib.request.quote(os.environ.get("ADS_AUTH_NAME", ""))})
    try:
        with urllib.request.urlopen(req, timeout=150) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        txt = e.read().decode(errors="replace")
        die(f"tts-listing/{action} HTTP {e.code}: {txt[:800]}")


def pick_shop(site: str, shop_id: str | None) -> str:
    if shop_id:
        return shop_id
    shops = [s for s in call("shops")["shops"] if (s.get("region") or "").upper() == site]
    if len(shops) != 1:
        die(f"{site} 店铺不唯一或不存在：{[(s['shop_id'], s['shop_name']) for s in shops]}，请用 --shop-id 指定")
    return shops[0]["shop_id"]


def match_attr_values(attrs: list, pid: str, value: str):
    a = next((x for x in attrs if str(x.get("id")) == pid), None)
    if not a:
        return None, f"类目属性里没有 {pid}"
    for v in a.get("values") or []:
        if v.get("name") == value:
            return {"id": pid, "values": [{"id": v["id"]}]}, None
    if a.get("is_customizable"):
        return {"id": pid, "values": [{"name": value}]}, None
    return None, f"属性 {pid}「{a.get('name')}」没有可选值「{value}」且不允许自定义（可选：{[v.get('name') for v in (a.get('values') or [])][:12]}）"


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("shops")
    p = sub.add_parser("push")
    p.add_argument("--site", required=True, choices=[s for s in SITES if s != "JP"])
    p.add_argument("--specs", nargs="+", required=True)
    p.add_argument("--shop-id")
    p.add_argument("--warehouse")
    p.add_argument("--prices", default="work/prices.json")
    p.add_argument("--images", default="work/images")
    p.add_argument("--stock", type=int, default=DEFAULT_STOCK)
    p.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if a.cmd == "shops":
        for s in call("shops")["shops"]:
            print(s["region"], s["shop_id"], s["shop_name"], s.get("seller_type"), "到期", s.get("access_expires_at"), "scopes", s.get("scopes"))
        return

    site, cfg = a.site, SITES[a.site]
    prices = load_json(a.prices)["sites"].get(site, {})
    urls = load_json(Path(a.images) / "urls.json") if (Path(a.images) / "urls.json").exists() else {}
    shop_id = None if a.dry_run and not a.shop_id else pick_shop(site, a.shop_id)
    uri_cache_p = Path(a.images) / "tts_uris.json"
    uri_cache = load_json(uri_cache_p) if uri_cache_p.exists() else {}
    prep_cache: dict = {}

    def tts_uri(sha: str, use_case: str) -> dict:
        if a.dry_run:
            return {"uri": f"<{use_case}:{sha}>"}
        ck = f"{shop_id}:{use_case}:{sha}"
        if ck not in uri_cache:
            if sha not in urls:
                die(f"图片 {sha} 还没上传 TOS（先跑 tos_upload.py）")
            r = call("upload_image", shop_id=shop_id, url=urls[sha], use_case=use_case)
            if not r.get("ok"):
                die(f"传图失败 {sha}: {r}")
            uri_cache[ck] = r["data"]["uri"]
            dump_json(uri_cache, uri_cache_p)
        return {"uri": uri_cache[ck]}

    for sp in [x for s in a.specs for x in sorted(glob.glob(s))]:
        spec = load_json(sp)
        spu, ss = spec["spu"], spec.get("sites", {}).get(site)
        if not ss:
            print(f"{spu}: 无 {site} 内容，跳过")
            continue
        report = {"spu": spu, "site": site, "warnings": []}
        attrs, wh_id = [], a.warehouse
        if not a.dry_run:
            cat = str(spec["category_id"])
            if cat not in prep_cache:
                prep_cache[cat] = call("prepare", shop_id=shop_id, category_id=cat)
            prep = prep_cache[cat]
            attrs = ((prep.get("attributes") or {}).get("data") or {}).get("attributes") or []
            whs = ((prep.get("warehouses") or {}).get("data") or {}).get("warehouses") or []
            if not wh_id:
                cands = [w for w in whs if "chinese mainland" in (w.get("name") or "").lower()]
                if len(cands) != 1:
                    die(f"{site} 无法自动确定发货仓（名称含 Chinese mainland 的有 {len(cands)} 个）：{[(w.get('id'), w.get('name')) for w in whs]}，用 --warehouse 指定")
                wh_id = cands[0]["id"]
        names = ss.get("variant_names") or []
        skus = []
        for sku in spec["skus"]:
            code = sku["seller_sku"]
            pk = prices.get(code, {}).get(cfg["pkg"])
            if not pk:
                report["warnings"].append(f"{code} 在定价表（包装 {cfg['pkg']}）查不到，跳过")
                continue
            vals = ss.get("values", {}).get(code) or []
            sa = []
            for i, (n, v) in enumerate(zip(names, vals)):
                item = {"name": n, "value_name": v}
                if i == 0 and sku.get("image"):
                    item["sku_img"] = tts_uri(sku["image"], "ATTRIBUTE_IMAGE")
                sa.append(item)
            skus.append({"seller_sku": code, "price": {"amount": str(pk["price"]), "currency": cfg["currency"]},
                         "inventory": [{"warehouse_id": wh_id or "<warehouse_id>", "quantity": a.stock}],
                         **({"sales_attributes": sa} if sa else {})})
        if not skus:
            print(f"{spu}: {site} 没有可定价的 SKU，跳过")
            continue
        props = []
        for pid, v in (spec.get("api_properties", {}).get(site) or spec.get("properties") or {}).items():
            if a.dry_run:
                props.append({"id": pid, "values": [{"name": v}]})
                continue
            item, err = match_attr_values(attrs, pid, v)
            if item:
                props.append(item)
            else:
                report["warnings"].append(err + "（已省略该属性）")
        brand_id = (re.search(r"\((\d+)\)", spec.get("brand") or "") or [None, None])[1]
        pc = spec["parcel"]
        body = {
            "title": ss["title"], "description": ss["description"], "category_id": str(spec["category_id"]),
            **({"brand_id": brand_id} if brand_id else {}),
            "main_images": [tts_uri(x, "MAIN_IMAGE") for x in spec["main_images"][:9]],
            "skus": skus,
            "package_weight": {"value": f"{pc['weight'] / 1000:.3f}", "unit": "KILOGRAM"},
            "package_dimensions": {"length": str(pc["length"]), "width": str(pc["width"]), "height": str(pc["height"]), "unit": "CENTIMETER"},
            **({"product_attributes": props} if props else {}),
        }
        body["idempotency_key"] = hashlib.sha1(f"{site}|{spu}|{json.dumps(body, sort_keys=True, ensure_ascii=False)}".encode()).hexdigest()
        out = Path(f"work/out/{site}_{spu}.payload.json")
        dump_json(body, out)
        if a.dry_run:
            print(f"{spu}: {site} 请求体已生成（dry-run）→ {out}  SKU {len(skus)}  警告 {report['warnings']}")
            continue
        r = call("create_draft", shop_id=shop_id, product=body, confirm="DRAFT")
        report["result"] = r
        dump_json(report, out.with_suffix(".result.json"))
        if r.get("ok"):
            print(f"{spu}: {site} 草稿已建 product_id={(r.get('data') or {}).get('product_id')}  警告 {report['warnings']}")
        else:
            print(f"{spu}: {site} 建草稿失败 code={r.get('code')} {r.get('message')} request_id={r.get('request_id')}")


if __name__ == "__main__":
    main()
