# GMV 归因排查 SQL（直接在 Supabase SQL Editor 跑）

入口：`Supabase Dashboard → SQL Editor`（Lovable 里是 `Cloud → Database → SQL Editor`）。
下面每一段都可以单独复制执行。月份一律写成 `YYYY-MM`，示例用 `2026-07`。

判定链路一共四层，出问题只可能出在其中一层，按 A→B→C→D 顺序查就能定位：

```
ad_uploads（批次） → ad_upload_agg（归并层，归因真正读的表）
        → attribution_run_keys（判定键） → attribution_run_rows（快照明细，页面读的表）
```

---

## A. 数据到底还在不在（回答「上传历史空了，7 月却有数」）

```sql
-- A1 批次表：页面「上传历史」读的就是这张表
select month, status, count(*) as uploads, sum(row_count) as raw_rows,
       min(created_at) as first_at, max(created_at) as last_at
from public.ad_uploads
group by 1, 2
order by 1 desc, 2;

-- A2 归并层：归因真正读的表（批次删了会级联删掉这里）
select month, count(*) as agg_rows, sum(rows_count) as raw_rows,
       round(sum(gross_revenue)) as gmv_native, round(sum(gmv_usd)) as gmv_usd,
       count(*) filter (where usd_rate is null) as no_rate_rows
from public.ad_upload_agg
group by 1
order by 1 desc;

-- A3 快照层：页面「月度进度」上那些数字来自这里，和 A1/A2 是**互相独立**的
select id, month, source, status, upload_count, agg_rows, raw_rows,
       round(total_gmv) as total_gmv, started_at, finished_at
from public.attribution_runs
where month = '2026-07'
order by finished_at desc nulls last
limit 5;
```

**怎么读：**

- A1 里 `2026-07` 没有行、A3 有行 → 批次已经被删掉（「全部删除」或级联），页面上 7 月的数字是**那次快照留下的历史结果**，不是当前数据。这时候点「重新计算」会变成 0，必须重新上传 Excel。
- A1 有行但 A2 对应月份没有行 → 归并没跑（批次卡在 `UPLOADING`/`FAILED`），归因当然是空的。
- A1、A2 都有行但页面「上传历史」是 0 → 才是前端/接口问题，把 A1 的行数发我。

---

## B. 这一次快照到底把钱判到哪去了

先从 A3 拿到 `id`，填进下面的 `:run_id`。

```sql
select country,
       bucket,
       coalesce(role, '-')       as role,
       coalesce(match_type, '-') as match_type,
       count(*)                  as keys,
       sum(rows_count)           as raw_rows,
       round(sum(gmv_usd))       as gmv_usd
from public.attribution_run_rows
where run_id = '把 A3 的 id 贴这里'
group by 1, 2, 3, 4
order by gmv_usd desc;
```

**怎么读：** `bucket = UNMATCHED` 的那几行就是「无建联达人」。看它们集中在哪几个 `country` —— 哪个站点全在 UNMATCHED，就直接去 C/D 查那个站点。

---

## C. 站点写法对不对（最常见的断点）

```sql
-- C1 广告表用的站点 vs 登记表用的站点，两边写法必须一模一样才可能匹配
select 'AD  广告表' as src, country, count(*) as n
from public.ad_upload_agg where month = '2026-07' group by 2
union all
select 'REG 登记表', country, count(*)
from public.creator_registry group by 2
union all
select 'OWN 归属表', country, count(*)
from public.creator_ownership group by 2
order by 1, 3 desc;

-- C2 归属表是不是空的（昵称路径全靠它；它是「同步达人登记」生成的）
select key_type, count(*) as rows, count(distinct country) as countries
from public.creator_ownership group by 1;
```

**怎么读：** `OWN 归属表` 整个没有行，或某个站点在 `AD` 有几万行、在 `OWN` 是 0 → 昵称路径在那个站点必然全军覆没，先重跑「同步达人登记」。

---

## D. 逐层看命中率（VID 强匹配 / 昵称路径）

```sql
-- D1 VID 强匹配：广告表里的 VID，登记表里到底有没有
with ad as (
  select distinct country, vid
  from public.ad_upload_agg
  where month = '2026-07' and vid <> ''
)
select ad.country,
       count(*)                                        as ad_vids,
       count(*) filter (where same.hit)                as 同站点命中,
       count(*) filter (where not same.hit and any_.hit) as 只在别的站点登记过,
       count(*) filter (where not any_.hit)            as 登记表里根本没有
from ad
left join lateral (select true as hit from public.creator_registry g
                   where g.vid = ad.vid and g.country = ad.country limit 1) same on true
left join lateral (select true as hit from public.creator_registry g
                   where g.vid = ad.vid limit 1) any_ on true
group by 1
order by ad_vids desc;

-- D2 昵称路径：广告表里的达人昵称，归属表里到底有没有
with ad as (
  select distinct country,
         lower(btrim(regexp_replace(account_name, '\s+', ' ', 'g'))) as nm
  from public.ad_upload_agg
  where month = '2026-07' and account_name <> ''
)
select ad.country,
       count(*)                                        as ad_names,
       count(*) filter (where same.hit)                as 同站点命中,
       count(*) filter (where not same.hit and any_.hit) as 只在别的站点登记过,
       count(*) filter (where not any_.hit)            as 归属表里根本没有
from ad
left join lateral (select true as hit from public.creator_ownership c
                   where c.country = ad.country and c.match_key = ad.nm limit 1) same on true
left join lateral (select true as hit from public.creator_ownership c
                   where c.match_key = ad.nm limit 1) any_ on true
group by 1
order by ad_names desc;
```

**怎么读：**

- `只在别的站点登记过` 很大 → 两边站点写法不一致（比如广告表写 `PH`、登记表写 `PHL`），这是数据问题，去飞书统一。
- `登记表里根本没有 / 归属表里根本没有` 很大 → 确实没建联，或「同步达人登记」没同步到那批人。
- 两边都很小、`同站点命中` 很大，但快照里仍是 UNMATCHED → 才是判定逻辑的 bug，把这张表发我。

---

## E. 汇率与金额（回答「商品卡数据偏低」这类）

```sql
select currency,
       count(*)                                   as agg_rows,
       count(*) filter (where usd_rate is null)   as 缺汇率,
       round(sum(gross_revenue))                  as 原币 GMV,
       round(sum(gmv_usd))                        as 折美元 GMV
from public.ad_upload_agg
where month = '2026-07'
group by 1
order by 3 desc;

-- 按内容类型看金额分布（商品卡是不是真的少）
select creative_type, count(*) as agg_rows, sum(rows_count) as raw_rows,
       round(sum(gmv_usd)) as gmv_usd
from public.ad_upload_agg
where month = '2026-07'
group by 1
order by gmv_usd desc;
```

**怎么读：** `缺汇率 > 0` 的币种，它的钱在 `gmv_usd` 里全是 0 —— 去「设置 → 汇率」补上该币种，然后重新计算。

---

## F. 肉眼看几行原始归并数据（确认字符串长什么样）

```sql
select country, vid, account_name, creative_type, currency,
       rows_count, gross_revenue, gmv_usd, usd_rate, posted_at
from public.ad_upload_agg
where month = '2026-07'
order by gross_revenue desc
limit 30;
```

站点、昵称里有没有多余空格、全角字符、汉字站点，这一眼就能看出来。

---

## G. 广告数据已经没了、但想先判断归因逻辑对不对（用旧快照回测）

批次被删之后，`attribution_run_rows` 里仍然保留着当时每一条判定键的 `country / vid / account_name / bucket`。
可以拿**当前的登记表和归属表**去回测这些旧键，判断「归不上」到底是数据没建联，还是判定逻辑接错了 ——
不用先把 10 个 Excel 重传一遍。

先从 A3 拿到 `run_id`。

```sql
-- G1 旧快照的判定分布：哪个站点整站掉进了无建联
select country, bucket,
       coalesce(role, '-') as role, coalesce(match_type, '-') as match_type,
       count(*) as keys, round(sum(gmv_usd)) as gmv_usd
from public.attribution_run_rows
where run_id = '把 A3 的 id 贴这里'
group by 1, 2, 3, 4
order by gmv_usd desc;

-- G2 回测：旧快照里判为 UNMATCHED 的键，按现在的登记表/归属表还能不能匹配上
with u as (
  select distinct r.country,
         r.vid,
         lower(btrim(regexp_replace(r.account_name, '\s+', ' ', 'g'))) as nm
  from public.attribution_run_rows r
  where r.run_id = '把 A3 的 id 贴这里'
    and r.bucket = 'UNMATCHED'
)
select u.country,
       count(*)                                             as 无建联键数,
       count(*) filter (where vsame.hit)                    as VID同站点能命中,
       count(*) filter (where vsame.hit is null and vany.hit) as VID只在别站点登记过,
       count(*) filter (where nsame.hit)                    as 昵称同站点能命中,
       count(*) filter (where nsame.hit is null and nany.hit) as 昵称只在别站点登记过
from u
left join lateral (select true as hit from public.creator_registry g
                   where u.vid <> '' and g.vid = u.vid and g.country = u.country limit 1) vsame on true
left join lateral (select true as hit from public.creator_registry g
                   where u.vid <> '' and g.vid = u.vid limit 1) vany on true
left join lateral (select true as hit from public.creator_ownership c
                   where u.nm <> '' and c.match_key = u.nm and c.country = u.country limit 1) nsame on true
left join lateral (select true as hit from public.creator_ownership c
                   where u.nm <> '' and c.match_key = u.nm limit 1) nany on true
group by 1
order by 无建联键数 desc;
```

**怎么读 G2：**

- `VID同站点能命中` / `昵称同站点能命中` 很大 → **判定逻辑有问题**：数据明明能匹配上，引擎却判成了无建联。把这张表发我，这是代码要改的。
- `只在别站点登记过` 很大 → 广告表站点和登记表站点写法对不上，是数据问题。
- 两类都接近 0 → 这些达人确实没建联过，归因结果是对的，问题在建联覆盖率而不是工具。
