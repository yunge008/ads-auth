-- 授权码表改版：sheet 改名为「建联-姓名」，同步更新 staff_sheets.sheet_name。
-- 若某人 name 与下列姓名不一致，该行不会更新——可在设置页人员表手动修正。

UPDATE public.staff_sheets SET sheet_name = '建联-阿南'   WHERE name = '阿南';
UPDATE public.staff_sheets SET sheet_name = '建联-林丽洪' WHERE name = '林丽洪';
UPDATE public.staff_sheets SET sheet_name = '建联-林乐欣' WHERE name = '林乐欣';
UPDATE public.staff_sheets SET sheet_name = '建联-湘红'   WHERE name = '湘红';
UPDATE public.staff_sheets SET sheet_name = '建联-李汝华' WHERE name = '李汝华';
