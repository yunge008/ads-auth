export type AuthAccount = {
  id: string;
  country: string;
  advertiser_name: string;
  advertiser_id: string;
};

export type StaffSheet = {
  id: string;
  name: string;
  /**
   * 该同事的飞书 sheet 名，**可以留空**。
   * 留空 = 用「设置 → 飞书表名称」里的模板按姓名生成（建联-{同事姓名} → 建联-阿南）；
   * 填了值 = 该人单独指定，模板管不着（名字不规范的人走这条）。
   * 这里存的始终是「原样」，实际会去飞书匹配的名字看 resolved_sheet_name。
   */
  sheet_name: string;
  /** 后端算好的、实际去飞书匹配的 sheet 名（只读，保存时不回传） */
  resolved_sheet_name?: string;
  /** override = 单独填的 / template = 模板生成的 / none = 定不出来 */
  sheet_name_source?: "override" | "template" | "none";
  active: boolean;
  role?: "BD" | "EDITOR";
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
  | "视频不可见"
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
  "视频不可见",
  "API错误",
  "授权中",
];
