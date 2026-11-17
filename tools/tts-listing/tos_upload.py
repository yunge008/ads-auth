"""把 images.py 产出的压缩图上传到火山引擎 TOS，回写公网 URL 到 work/images/urls.json。

用法：python3 tos_upload.py [-d work/images] [--check]

走 TOS 的 S3 兼容接口（AWS SigV4，纯标准库，不依赖 boto3）。需要环境变量（不要写进仓库）：
  TOS_ACCESS_KEY / TOS_SECRET_KEY   火山引擎访问密钥（建议子账号，只授权这个桶的 PutObject/GetObject）
  TOS_BUCKET                       桶名
  TOS_REGION                       如 cn-beijing / cn-shanghai / cn-guangzhou / ap-southeast-1
  TOS_PREFIX        可选，默认 tts-listing/
  TOS_PUBLIC_BASE   可选，对外访问域名（绑定了自定义域名/CDN 时填，如 https://img.example.com）；
                    默认 https://{bucket}.tos-{region}.volces.com
  TOS_OBJECT_ACL    可选，默认 public-read（桶已配公共读策略可设为空）
--check：只上传 1 张并回读 URL，验证密钥、地域、公共读是否都对。
对象名 = 内容 sha1，已上传过的直接跳过（urls.json 缓存）。
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from common import die, dump_json, load_json


def env(k, default=None, required=True):
    v = os.environ.get(k, default)
    if required and not v:
        die(f"缺环境变量 {k}（见 tos_upload.py 顶部说明）")
    return v


def _h(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def put_object(host: str, region: str, key: str, data: bytes, ak: str, sk: str, acl: str | None):
    now = dt.datetime.now(dt.timezone.utc)
    amzdate, datestamp = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(data).hexdigest()
    headers = {"host": host, "x-amz-content-sha256": payload_hash, "x-amz-date": amzdate, "content-type": "image/jpeg"}
    if acl:
        headers["x-amz-acl"] = acl
    signed = ";".join(sorted(headers))
    canon = "\n".join(["PUT", "/" + urllib.request.quote(key), "",
                       "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), signed, payload_hash])
    scope = f"{datestamp}/{region}/s3/aws4_request"
    sts = "\n".join(["AWS4-HMAC-SHA256", amzdate, scope, hashlib.sha256(canon.encode()).hexdigest()])
    k = _h(_h(_h(_h(("AWS4" + sk).encode(), datestamp), region), "s3"), "aws4_request")
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = f"AWS4-HMAC-SHA256 Credential={ak}/{scope}, SignedHeaders={signed}, Signature={sig}"
    req = urllib.request.Request(f"https://{host}/{urllib.request.quote(key)}", data=data, method="PUT",
                                 headers={k: v for k, v in headers.items() if k != "host"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status
    except urllib.error.HTTPError as e:
        die(f"TOS 上传失败 HTTP {e.code}: {e.read()[:500].decode(errors='replace')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-d", "--dir", default="work/images")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    ak, sk = env("TOS_ACCESS_KEY"), env("TOS_SECRET_KEY")
    bucket, region = env("TOS_BUCKET"), env("TOS_REGION")
    prefix = env("TOS_PREFIX", "tts-listing/", required=False)
    acl = env("TOS_OBJECT_ACL", "public-read", required=False) or None
    base = (env("TOS_PUBLIC_BASE", None, required=False) or f"https://{bucket}.tos-{region}.volces.com").rstrip("/")
    s3host = f"{bucket}.tos-s3-{region}.volces.com"

    d = Path(a.dir)
    urls_path = d / "urls.json"
    urls = load_json(urls_path) if urls_path.exists() else {}
    files = sorted((d / "jpg").glob("*.jpg"))
    if a.check:
        files = files[:1]
    n_new = 0
    for f in files:
        sha = f.stem
        if sha in urls and not a.check:
            continue
        key = f"{prefix}{sha}.jpg"
        put_object(s3host, region, key, f.read_bytes(), ak, sk, acl)
        urls[sha] = f"{base}/{key}"
        n_new += 1
    dump_json(urls, urls_path)
    if a.check:
        u = urls[files[0].stem]
        try:
            with urllib.request.urlopen(u, timeout=30) as r:
                print(f"OK 上传并公网回读成功 HTTP {r.status} {r.headers.get('content-type')} {u}")
        except urllib.error.HTTPError as e:
            die(f"上传成功但公网读取失败 HTTP {e.code}（检查桶公共读策略 / TOS_OBJECT_ACL / TOS_PUBLIC_BASE）：{u}")
    print(f"新上传 {n_new} 张，累计 {len(urls)} 张 → {urls_path}")


if __name__ == "__main__":
    main()
