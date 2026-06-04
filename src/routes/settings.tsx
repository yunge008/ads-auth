import { createFileRoute } from "@tanstack/react-router";
import { AccountsTable } from "@/components/settings/AccountsTable";
import { StaffTable } from "@/components/settings/StaffTable";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "设置 - TikTok授权工具" },
      { name: "description", content: "配置授权账户和人员表" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">设置</h2>
        <p className="text-sm text-muted-foreground mt-1">
          管理授权账户与飞书人员配置，保存后将同步至 Supabase。
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3">
          <AccountsTable />
        </div>
        <div className="lg:col-span-2">
          <StaffTable />
        </div>
      </div>
    </div>
  );
}
