export type AuthAccount = {
  id: string;
  country: string;
  advertiser_name: string;
  advertiser_id: string;
};

export type StaffSheet = {
  id: string;
  name: string;
  sheet_name: string;
  active: boolean;
};

export type BCAdvertiser = {
  advertiser_id: string;
  advertiser_name: string;
  status?: string;
};

export type MaterialStatus =
  | "待授权"
  | "已授权"
  | "无授权账号"
  | "代码过期"
  | "代码删除"
  | "代码有误"
  | "代码涉及多素材"
  | "API错误"
  | "授权中";

export type Material = {
  id: string;
  row_number: number;
  staff_name: string;
  sheet_name: string;
  register_date: string;
  country: string;
  creator_name: string;
  vid: string;
  auth_code: string;
  product: string;
  advertiser_id?: string;
  advertiser_name?: string;
  status: MaterialStatus;
  error_message?: string;
};

export const ALL_STATUSES: MaterialStatus[] = [
  "待授权",
  "已授权",
  "无授权账号",
  "代码过期",
  "代码删除",
  "代码有误",
  "代码涉及多素材",
  "API错误",
  "授权中",
];
