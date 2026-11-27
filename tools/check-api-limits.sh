#!/usr/bin/env bash
# 外部 API 限速登记核对（docs/API_RATE_LIMITS.md §6）
# 扫 supabase/functions 与 src 里出现的 TikTok Business / Shop 接口路径，
# 与 docs/API_RATE_LIMITS.md 登记表第一列比对：代码里有、文档没登记的 → 列出并返回 1。
# 文档登记了、代码里已没有的 → 只提示（可能已下线，顺手删掉登记行）。
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import re, pathlib, sys
DOC = pathlib.Path("docs/API_RATE_LIMITS.md").read_text(encoding="utf-8")
norm = lambda p: re.sub(r"\$\{[^}]+\}", "{x}", p).rstrip("/") + ("/" if p.endswith("/") else "")
doc = set()
for line in DOC.splitlines():
    m = re.match(r"\|\s*`(/[^`]+)`", line)
    if m: doc.add(norm(m.group(1)))
# Shop：/<模块>/<6 位版本>/...；BC：被 ttGet/tt()/fetch(`${TT}/...`) 调用、以 / 结尾的路径
SHOP = re.compile(r"[\"'`](/(?:api|product|order|finance|affiliate_seller|affiliate_creator|analytics|seller|authorization|logistics|promotion|return_refund|customer_service|event|fulfillment)/20\d{4}/[^\"'`?\s]*)")
BC = re.compile(r"[\"'`](?:\$\{TT\}(?:/v1\.3)?)?(/(?:gmv_max|campaign|bc|advertiser|identity|oauth2|report|store|tt_video|adgroup|comment|ad|creative|file|pangle|business|catalog|tool)(?:/[a-z_0-9]+)*/)[\"'`]")
code = {}
for f in list(pathlib.Path("supabase/functions").rglob("*.ts")) + list(pathlib.Path("src").rglob("*.ts")) + list(pathlib.Path("src").rglob("*.tsx")):
    n = f.name
    if n.endswith((".test.ts", "_test.ts")) or "routeTree.gen" in n: continue
    t = f.read_text(encoding="utf-8", errors="ignore")
    for rx in (SHOP, BC):
        for m in rx.finditer(t):
            p = norm(m.group(1))
            if p.endswith("/{x}") or p.endswith("/{x}/"):  # 仅前缀拼接，跳过
                pass
            code.setdefault(p, set()).add(str(f))
missing = sorted(p for p in code if p not in doc)
stale = sorted(p for p in doc if p not in code)
print(f"代码中接口路径 {len(code)} 个，文档登记 {len(doc)} 个")
if stale:
    print("\n文档登记但代码里已找不到（可能已下线，确认后删登记行）：")
    for p in stale: print("  ", p)
if missing:
    print("\n❌ 未登记（请补 docs/API_RATE_LIMITS.md §3：调用方、触发、每次调用量、峰值；新定时任务补 §4）：")
    for p in missing: print("  ", p, "←", ", ".join(sorted(code[p])))
    sys.exit(1)
print("\n✅ 全部已登记")
PY
