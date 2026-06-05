import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/material-performance")({
  head: () => ({ meta: [{ title: "素材成效 - TikTok授权工具" }] }),
  component: MaterialPerformancePage,
});

function MaterialPerformancePage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">素材成效</h2>
        <p className="text-sm text-muted-foreground mt-1">
          GMV Max 素材成效数据（开发中）
        </p>
      </div>
      <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
        即将上线：同步剪辑飞书表 / SKU 匹配表 / GMV Max 数据
      </div>
    </div>
  );
}
