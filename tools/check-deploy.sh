#!/usr/bin/env bash
# 检查 Edge Function 线上是否已部署最新代码（每次会话开工前跑一次，见 docs/PLAN.md「待部署 Edge Function 清单」）。
# 只发无权限的探测请求，不读写任何数据。
#
# 探测 1：_shared/auth.ts 口令注入修复（1123.200）
#   口令头带「,不存在的列.eq.1」：旧版把口令拼进 .or()，PostgREST 报「列不存在」→ 400 + 列名报错；
#   新版参数化查询 → 401「用户名或密码错误」。
set -u
URL="https://ifwyjsdvptbfuqhonnzd.supabase.co/functions/v1"
KEY="sb_publishable_3EjrcsK9Xp3ILAzRnhED1g_PGogg4VK"   # 前端公开的 publishable key
cd "$(dirname "$0")/.."
old=0
for f in $(ls supabase/functions | grep -v '^_'); do
  r=$(curl -s --max-time 40 -X POST "$URL/$f" -H "apikey: $KEY" -H "Content-Type: application/json" \
      -H "x-admin-passcode: zz,deploy_probe_no_such_col.eq.1" -d '{}' -w "|%{http_code}" | tr -d '\n')
  if echo "$r" | grep -q "deploy_probe_no_such_col"; then echo "旧版  $f  $r"; old=$((old+1)); fi
done
echo "auth.ts 口令修复：旧版函数 $old 个（0 = 全部已部署）"
