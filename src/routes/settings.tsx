import { createFileRoute } from "@tanstack/react-router";
import { AccountsTable } from "@/components/settings/AccountsTable";
import { StaffTable } from "@/components/settings/StaffTable";
import { AccountsManager } from "@/components/settings/AccountsManager";
import { DataSyncCard } from "@/components/settings/DataSyncCard";
import { useCurrentAccount } from "@/lib/account";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  const account = useCurrentAccount();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">设置</h2>
        <p className="text-sm text-muted-foreground mt-1">管理授权、人员表、账号与数据获取。</p>
      </div>

      <Tabs defaultValue="auth" className="space-y-4">
        <TabsList>
          <TabsTrigger value="auth">授权</TabsTrigger>
          <TabsTrigger value="staff">人员表及账号</TabsTrigger>
          <TabsTrigger value="sync">数据获取</TabsTrigger>
        </TabsList>
        <TabsContent value="auth">
          <AccountsTable />
        </TabsContent>
        <TabsContent value="staff" className="space-y-4">
          <StaffTable />
          {account?.isAdmin && <AccountsManager />}
        </TabsContent>
        <TabsContent value="sync">
          <DataSyncCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}

