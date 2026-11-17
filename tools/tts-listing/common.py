"""TTS 上架工具链公共配置与小工具（Python 3.10+，依赖 openpyxl、Pillow）。

站点口径（2026-11-17 负责人确认）：
- 只取定价表「渠道 = TTS-SEA」的行；TH 用「TH (关税版)」sheet；JP sheet 里站点写 PH 的行忽略。
- 默认包装 SKU2：PH / TH = B2；MY / SG / VN = B4（JP 未指定）。
- 售价 = 日常价 × 2（VN 的日常价列叫「提价-日常价」）。
- 库存默认 1000。
"""
from __future__ import annotations

import json
import os
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent

SITES: dict[str, dict] = {
    # sheet: 定价表 sheet 名；pkg: 默认 SKU2；dec: 价格小数位；lang: 模板要求的录入语言
    "PH": {"sheet": "PH", "pkg": "B2", "currency": "PHP", "dec": 0, "lang": "English"},
    "TH": {"sheet": "TH (关税版)", "pkg": "B2", "currency": "THB", "dec": 0, "lang": "Thai"},
    "MY": {"sheet": "MY", "pkg": "B4", "currency": "MYR", "dec": 1, "lang": "Malay"},
    "SG": {"sheet": "SG", "pkg": "B4", "currency": "SGD", "dec": 1, "lang": "English"},
    "VN": {"sheet": "VN", "pkg": "B4", "currency": "VND", "dec": 0, "lang": "Vietnamese"},
    "JP": {"sheet": "JP", "pkg": None, "currency": "JPY", "dec": 0, "lang": "Japanese"},
}
DEFAULT_STOCK = 1000
CHANNEL = "TTS-SEA"
SPU_RE = re.compile(r"^(AR\d+)", re.I)


def die(msg: str) -> "None":
    print(f"[ERROR] {msg}", file=sys.stderr)
    sys.exit(1)


def spu_of(sku: str) -> str | None:
    m = SPU_RE.match(str(sku or "").strip())
    return m.group(1).upper() if m else None


def decode_u(name: str) -> str:
    """Windows 压缩包里的 #Uxxxx 文件名还原成中文。"""
    return re.sub(r"#U([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), name)


def load_json(p) -> dict:
    return json.loads(Path(p).read_text(encoding="utf-8"))


def dump_json(obj, p) -> None:
    Path(p).parent.mkdir(parents=True, exist_ok=True)
    Path(p).write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def round_price(v: float, dec: int) -> float | int:
    r = round(v + 1e-9, dec)
    return int(r) if dec == 0 else r


# ── 只读 XLSX（TikTok 模板的 styles.xml 不规范，openpyxl 打不开，所以直接读 XML）──
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
M = "{%s}" % NS["m"]


def col2n(c: str) -> int:
    n = 0
    for ch in c:
        n = n * 26 + ord(ch) - 64
    return n


def n2col(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


class RawBook:
    def __init__(self, path):
        self.path = str(path)
        self.z = zipfile.ZipFile(self.path)
        self.ss: list[str] = []
        if "xl/sharedStrings.xml" in self.z.namelist():
            for si in ET.fromstring(self.z.read("xl/sharedStrings.xml")).findall("m:si", NS):
                self.ss.append("".join(t.text or "" for t in si.iter(M + "t")))
        wb = ET.fromstring(self.z.read("xl/workbook.xml"))
        rels = ET.fromstring(self.z.read("xl/_rels/workbook.xml.rels"))
        rmap = {r.get("Id"): r.get("Target") for r in rels}
        self.sheets: dict[str, str] = {}
        for s in wb.find("m:sheets", NS):
            t = rmap[s.get("{%s}id" % NS["r"])].lstrip("/")
            self.sheets[s.get("name")] = t if t.startswith("xl/") else "xl/" + t

    def rows(self, sheet: str) -> dict[int, dict[int, str]]:
        out: dict[int, dict[int, str]] = {}
        root = ET.fromstring(self.z.read(self.sheets[sheet]))
        for row in root.iter(M + "row"):
            d: dict[int, str] = {}
            for c in row.findall("m:c", NS):
                ref = re.match(r"([A-Z]+)", c.get("r")).group(1)
                v = c.find("m:v", NS)
                t = c.get("t")
                if t == "s" and v is not None:
                    val = self.ss[int(v.text)]
                elif t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter(M + "t"))
                else:
                    val = v.text if v is not None else None
                if val not in (None, ""):
                    d[col2n(ref)] = val
            out[int(row.get("r"))] = d
        return out


# ── 写 XLSX：只改指定单元格，其余（下拉、隐藏表、校验、样式）原样保留 ──
def _cell_xml(ref: str, val, style: str | None) -> str:
    from xml.sax.saxutils import escape
    s = f' s="{style}"' if style else ""
    if val is None or val == "":
        return f'<c r="{ref}"{s}/>'
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return f'<c r="{ref}"{s}><v>{val}</v></c>'
    return f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{escape(str(val))}</t></is></c>'


def patch_xlsx(src, out, sheet_updates: dict[str, dict[int, dict[int, object]]]) -> None:
    """sheet_updates = {sheet名: {行号: {列号: 值}}}。行必须已存在或会被追加到 sheetData 末尾（按行号插入）。"""
    book = RawBook(src)
    new_xml: dict[str, bytes] = {}
    for sheet, updates in sheet_updates.items():
        target = book.sheets[sheet]
        xml = book.z.read(target).decode("utf-8")
        row_re = re.compile(r'<row r="(\d+)"([^>]*?)(?:/>|>(.*?)</row>)', re.S)
        seen = set()

        def merge(rn: int, attrs: str, inner: str | None) -> str:
            cells: dict[int, str] = {}
            styles: dict[int, str] = {}
            for c in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>.*?</c>)', inner or "", re.S):
                n = col2n(c.group(1))
                cells[n] = c.group(0)
                st = re.search(r'\bs="(\d+)"', c.group(2))
                if st:
                    styles[n] = st.group(1)
            for cnum, v in updates[rn].items():
                cells[cnum] = _cell_xml(f"{n2col(cnum)}{rn}", v, styles.get(cnum))
            attrs = re.sub(r'\s*spans="[^"]*"', "", attrs)
            return f'<row r="{rn}"{attrs}>' + "".join(cells[k] for k in sorted(cells)) + "</row>"

        def repl(m):
            rn = int(m.group(1))
            if rn not in updates:
                return m.group(0)
            seen.add(rn)
            return merge(rn, m.group(2), m.group(3))

        xml = row_re.sub(repl, xml)
        missing = sorted(set(updates) - seen)
        if missing:
            extra = "".join(merge(rn, "", None) for rn in missing)
            if "<sheetData/>" in xml:
                xml = xml.replace("<sheetData/>", f"<sheetData>{extra}</sheetData>")
            else:
                # 按行号插入：简单起见要求追加的行号都大于现有最大行号
                last = max([int(x) for x in re.findall(r'<row r="(\d+)"', xml)] or [0])
                if missing[0] <= last:
                    die(f"{sheet}: 要写的第 {missing[0]} 行不存在且不在末尾，模板结构异常")
                xml = xml.replace("</sheetData>", extra + "</sheetData>")
        xml = re.sub(r'<dimension ref="[^"]*"\s*/?>(</dimension>)?', "", xml)
        new_xml[target] = xml.encode("utf-8")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            zout.writestr(item, new_xml.get(item.filename, zin.read(item.filename)))


def keep_only_rows(src, out, sheet: str, first_data_row: int, keep: list[int]) -> None:
    """只保留表头（< first_data_row）和 keep 里的数据行，数据行按顺序紧凑重编号；其余文件不动。"""
    book = RawBook(src)
    target = book.sheets[sheet]
    xml = book.z.read(target).decode("utf-8")
    m = re.search(r"<sheetData>(.*)</sheetData>", xml, re.S)
    rows = {int(r.group(1)): r.group(0) for r in re.finditer(r'<row r="(\d+)"[^>]*?(?:/>|>.*?</row>)', m.group(1), re.S)}
    parts = [rows[n] for n in sorted(rows) if n < first_data_row]
    for i, old in enumerate(sorted(keep)):
        new = first_data_row + i
        rx = rows[old]
        rx = re.sub(r'<row r="\d+"', f'<row r="{new}"', rx, count=1)
        rx = re.sub(r'(<c r="[A-Z]+)\d+"', lambda mm: f'{mm.group(1)}{new}"', rx)
        parts.append(rx)
    xml = xml[: m.start(1)] + "".join(parts) + xml[m.end(1):]
    xml = re.sub(r'<dimension ref="[^"]*"\s*/?>(</dimension>)?', "", xml)
    tmp = str(out) + ".tmp"
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            zout.writestr(item, xml.encode("utf-8") if item.filename == target else zin.read(item.filename))
    os.replace(tmp, out)
