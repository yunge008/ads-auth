-- GMV 归因汇率：预置 USD / THB。
-- usd_rate 语义 = 1 美元兑多少本币；折美元 = 本币金额 / usd_rate。
-- 目前 GMV MAX 导出只出现这两种结算币种（USD 为主，THB 少量）。
-- ON CONFLICT DO NOTHING：已在设置页手工维护过的值不被覆盖，需要改就去
-- 「设置 → GMV 归因汇率」改，改完对下一次 finalize 生效。
INSERT INTO public.gmv_exchange_rates (currency, usd_rate, enabled, updated_by)
VALUES
  ('USD', 1, true, 'migration'),
  ('THB', 32.5, true, 'migration')
ON CONFLICT (currency) DO NOTHING;
