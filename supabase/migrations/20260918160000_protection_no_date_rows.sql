-- A4：无日期的登记行不参与归属判定 —— SQL 第二实现同步。
--
-- `attribution_protection_owner_90d` 是 `_shared/attribution.ts` 的 `resolveOwnership` 的
-- 独立重算实现，两边口径必须逐条对齐，否则 `attribution_protection_check_90d` 会开始报假差异。
-- TS 侧已改成「无日期的登记行直接跳过」，这里同步：
--   · WHERE 加一条 `COALESCE(register_date, sample_date) IS NOT NULL`
--   · ORDER BY 去掉 NULLS FIRST（没有 NULL 了）
--   · 删掉「owner 无日期 → 异 BD 直接转移」那条分支（不可能再触发）
--
-- 为什么要改：无日期行以前按 '0000-00-00' 排最前，等于「没填日期的人最早建联」，
-- 会凭空抢到归属；而且 owner 没有日期就无法主张保护期，后面任何人一登记就立刻转移。
-- 阿木那张建联表里 5,564 行 2000-01-01 的占位日期是同一类问题的另一种形态
-- （那种有日期、但日期是假的，要回飞书改，代码这边拦不住）。

CREATE OR REPLACE FUNCTION public.attribution_protection_owner_90d(
  _country text DEFAULT NULL,
  _protection_days integer DEFAULT 90
)
RETURNS TABLE (
  country text,
  match_key text,
  owner_bd text,
  first_date date,
  owner_last_date date,
  transfer_count integer,
  grab_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r            record;
  cur_key      text := NULL;
  v_country    text;
  v_match      text;
  v_owner      text;
  v_owner_last date;
  v_first      date;
  v_transfers  integer;
  v_grabs      integer;
BEGIN
  FOR r IN
    SELECT
      cr.country                                 AS c,
      cr.nickname_norm                           AS nm,
      cr.staff_name                              AS staff,
      COALESCE(cr.register_date, cr.sample_date) AS d
    FROM public.creator_registry cr
    WHERE cr.role = 'BD'
      AND cr.nickname_norm <> ''
      AND cr.staff_name <> ''
      -- A4：无日期行不参与判定（与 TS 侧 resolveOwnership 一致）
      AND COALESCE(cr.register_date, cr.sample_date) IS NOT NULL
      AND (_country IS NULL OR cr.country = _country)
    ORDER BY cr.country, cr.nickname_norm, COALESCE(cr.register_date, cr.sample_date), cr.id
  LOOP
    IF cur_key IS DISTINCT FROM (r.c || '|' || r.nm) THEN
      IF cur_key IS NOT NULL THEN
        country := v_country; match_key := v_match; owner_bd := v_owner;
        first_date := v_first; owner_last_date := v_owner_last;
        transfer_count := v_transfers; grab_count := v_grabs;
        RETURN NEXT;
      END IF;
      cur_key := r.c || '|' || r.nm;
      v_country := r.c; v_match := r.nm;
      v_owner := r.staff; v_owner_last := r.d; v_first := r.d;
      v_transfers := 0; v_grabs := 0;
      CONTINUE;
    END IF;

    IF r.staff = v_owner THEN
      IF r.d > v_owner_last THEN
        v_owner_last := r.d;
      END IF;
    ELSIF (r.d - v_owner_last) >= _protection_days THEN
      v_owner := r.staff; v_owner_last := r.d; v_transfers := v_transfers + 1;
    ELSE
      v_grabs := v_grabs + 1;
    END IF;
  END LOOP;

  IF cur_key IS NOT NULL THEN
    country := v_country; match_key := v_match; owner_bd := v_owner;
    first_date := v_first; owner_last_date := v_owner_last;
    transfer_count := v_transfers; grab_count := v_grabs;
    RETURN NEXT;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.attribution_protection_owner_90d(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_protection_owner_90d(text, integer) TO service_role;
