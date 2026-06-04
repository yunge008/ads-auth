import { cn } from "@/lib/utils";
import type { MaterialStatus } from "@/lib/types";

const styles: Record<MaterialStatus, string> = {
  待授权: "bg-gray-100 text-gray-700 border-gray-200",
  已授权: "bg-emerald-100 text-emerald-700 border-emerald-200",
  无授权账号: "bg-neutral-900 text-white border-neutral-900",
  代码过期: "bg-red-100 text-red-700 border-red-200",
  代码删除: "bg-red-100 text-red-700 border-red-200",
  代码有误: "bg-red-100 text-red-700 border-red-200",
  代码涉及多素材: "bg-red-100 text-red-700 border-red-200",
  视频不可见: "bg-red-100 text-red-700 border-red-200",
  API错误: "bg-red-100 text-red-700 border-red-200",
  授权中: "bg-blue-100 text-blue-700 border-blue-200",
};

export function StatusBadge({ status }: { status: MaterialStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border whitespace-nowrap",
        styles[status],
      )}
    >
      {status}
    </span>
  );
}

export const STATUS_RANK: Record<MaterialStatus, number> = {
  无授权账号: 0,
  API错误: 1,
  代码过期: 1,
  代码删除: 1,
  代码有误: 1,
  代码涉及多素材: 1,
  视频不可见: 1,
  待授权: 2,
  授权中: 3,
  已授权: 4,
};
