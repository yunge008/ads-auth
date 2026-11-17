"""图片包 → 压缩图 + manifest.json（初始排序建议，由 Agent 看图后在 listing spec 里定稿）。

用法：python3 images.py <图片包.zip 或 已解压目录> [-o work/images]

图片包约定（以 2026-11 样例为准）：
- 每个子文件夹一个 SPU，文件夹名以数字或 AR+数字 开头（如「140 已改」→ AR140）。
- 文件名以数字开头 = 图集序号（1 = 主图，2 = 佩戴图，其后按序号）；后面的文字是图片说明。
- 文件名以 SKU 编码开头（如「AR140-B45-K ...」）= 变体图。
- 文件名以「未使用」开头、desktop.ini、隐藏文件 → 跳过。
- 其他（如 size.png）→ extra，由 Agent 决定是否使用。

压缩：统一转 JPEG（透明底铺白），长边 > 1600 缩到 1600，质量 88；小于 600×600 记警告（主图要求 ≥ 300×300）。
输出文件名 = 内容 sha1 前 16 位，重复上传天然去重。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

from PIL import Image

from common import decode_u, dump_json

EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
MAX_SIDE = 1600
QUALITY = 88


def extract(src: Path) -> Path:
    if src.is_dir():
        return src
    tmp = Path(tempfile.mkdtemp(prefix="tts-imgs-"))
    with zipfile.ZipFile(src) as z:
        for info in z.infolist():
            name = info.filename
            if not (info.flag_bits & 0x800):  # 非 UTF-8 标记：按 cp437 → gbk 尝试还原
                try:
                    name = name.encode("cp437").decode("gbk")
                except (UnicodeEncodeError, UnicodeDecodeError):
                    pass
            name = decode_u(name)
            if name.endswith("/") or ".." in Path(name).parts:
                continue
            dst = tmp / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as r, open(dst, "wb") as w:
                shutil.copyfileobj(r, w)
    return tmp


def compress(p: Path, out_dir: Path) -> dict:
    im = Image.open(p)
    im.load()
    w0, h0 = im.size
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")
    if max(im.size) > MAX_SIDE:
        im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    data = buf.getvalue()
    h = hashlib.sha1(data).hexdigest()[:16]
    dst = out_dir / f"{h}.jpg"
    if not dst.exists():
        dst.write_bytes(data)
    warn = []
    if min(im.size) < 600:
        warn.append(f"尺寸偏小 {im.size}")
    if abs(im.size[0] - im.size[1]) > 2:
        warn.append(f"非正方形 {im.size}")
    return {"file": dst.name, "sha": h, "src_size": [w0, h0], "size": list(im.size),
            "kb": len(data) // 1024, "src_kb": p.stat().st_size // 1024, "warn": warn}


def contact_sheets(manifest: dict, out: Path, w: int = 200, cols: int = 6) -> None:
    """每个 SPU 一张缩略图总览（标注 序号/SKU + sha 前 6 位），给 Agent 看图排序用。"""
    from PIL import ImageDraw
    (out / "sheets").mkdir(exist_ok=True)
    for spu, e in manifest["spus"].items():
        items = e["gallery"] + e["variants"] + e["extra"]
        if not items:
            continue
        rows = (len(items) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * w, rows * (w + 20)), "white")
        d = ImageDraw.Draw(sheet)
        for i, x in enumerate(items):
            im = Image.open(out / "jpg" / x["file"])
            im.thumbnail((w, w))
            px, py = (i % cols) * w, (i // cols) * (w + 20)
            sheet.paste(im, (px, py))
            label = x.get("sku") or (str(x["order"]) if "order" in x else "extra")
            d.text((px + 3, py + w + 3), f"{label} {x['sha'][:6]}", fill="black")
        sheet.save(out / "sheets" / f"{spu}.jpg", quality=80)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("-o", "--out", default="work/images")
    a = ap.parse_args()
    root = extract(Path(a.src))
    out = Path(a.out)
    (out / "jpg").mkdir(parents=True, exist_ok=True)
    manifest: dict = {"source": a.src, "spus": {}}
    folders = [d for d in sorted(root.rglob("*")) if d.is_dir() and any(f.suffix.lower() in EXT for f in d.iterdir())]
    for d in folders:
        name = decode_u(d.name)
        m = re.match(r"^(?:AR)?(\d+)", name, re.I)
        if not m:
            print("跳过（文件夹名不是 SPU）:", name)
            continue
        spu = f"AR{m.group(1)}"
        entry = manifest["spus"].setdefault(spu, {"folder": str(d), "gallery": [], "variants": [], "extra": [], "skipped": []})
        for f in sorted(d.iterdir()):
            fname = decode_u(f.name)
            if f.is_dir() or f.suffix.lower() not in EXT or fname.startswith("."):
                if f.is_file():
                    entry["skipped"].append(fname)
                continue
            stem = Path(fname).stem
            if stem.startswith("未使用"):
                entry["skipped"].append(fname)
                continue
            info = {"src": str(f), "name": fname, **compress(f, out / "jpg")}
            mv = re.match(r"^(AR[\w+\-]+)\s*(.*)$", stem, re.I)
            mn = re.match(r"^(\d+)\s*(.*)$", stem)
            if mv:
                info.update(sku=mv.group(1).upper(), caption=mv.group(2))
                entry["variants"].append(info)
            elif mn:
                info.update(order=int(mn.group(1)), caption=mn.group(2))
                entry["gallery"].append(info)
            else:
                info.update(caption=stem)
                entry["extra"].append(info)
        entry["gallery"].sort(key=lambda x: x["order"])
    dump_json(manifest, out / "manifest.json")
    contact_sheets(manifest, out)
    for spu, e in manifest["spus"].items():
        warns = [f"{x['name']}: {','.join(x['warn'])}" for x in e["gallery"] + e["variants"] + e["extra"] if x["warn"]]
        print(f"{spu}: 图集 {len(e['gallery'])} 变体图 {len(e['variants'])} 其他 {len(e['extra'])} 跳过 {len(e['skipped'])}"
              + (f" 警告 {warns}" if warns else ""))
    print("→", out / "manifest.json")


if __name__ == "__main__":
    main()
