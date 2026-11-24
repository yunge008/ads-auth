import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { invokeFn, callGmvMaxWrite } from "@/lib/api";

export const Route = createFileRoute("/oauth/tiktok/callback")({
  head: () => ({
    meta: [{ title: "TikTok 授权回调" }],
  }),
  component: CallbackPage,
});

type Advertiser = { advertiser_id: string; advertiser_name: string; status?: string };
type ExchangeResp = {
  label: string;
  access_token: string;
  bc_id: string | null;
  bc_name: string | null;
  expires_at: string | null;
  advertisers: Advertiser[];
};

function CallbackPage() {
  const navigate = useNavigate();
  const [stage, setStage] = useState<"loading" | "choose" | "saving" | "ok" | "err">("loading");
  const [msg, setMsg] = useState("正在交换 access_token …");
  const [resp, setResp] = useState<ExchangeResp | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  // BC 必填：授权返回了就带入；没返回就用新 token 查可访问 BC（一个自动填，多个下拉选）
  const [bcId, setBcId] = useState("");
  const [bcName, setBcName] = useState("");
  const [bcOptions, setBcOptions] = useState<{ bc_id: string; bc_name: string }[]>([]);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const code = sp.get("auth_code") ?? sp.get("code");
    const st = sp.get("state") ?? "";
    if (!code) {
      setStage("err");
      setMsg("URL 缺少 auth_code 参数");
      return;
    }
    (async () => {
      try {
        const data = await invokeFn<ExchangeResp>("tiktok-oauth-exchange", {
          auth_code: code,
          state: st,
        });
        setResp(data);
        setSelected(new Set(data.advertisers.map((a) => a.advertiser_id)));
        setBcId(data.bc_id ?? "");
        setBcName(data.bc_name ?? "");
        if (!data.bc_id) {
          callGmvMaxWrite<{ bcs: { bc_id: string; bc_name: string }[] }>({ action: "bc_list", access_token: data.access_token })
            .then((r) => {
              setBcOptions(r.bcs);
              if (r.bcs.length === 1) { setBcId(r.bcs[0].bc_id); setBcName(r.bcs[0].bc_name); }
            })
            .catch(() => setBcOptions([]));
        }
        setStage("choose");
        setMsg(`授权成功，共 ${data.advertisers.length} 个广告户，请勾选要保存的`);
      } catch (e) {
        setStage("err");
        setMsg((e as Error).message);
      }
    })();
  }, []);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    if (!resp || selected.size === 0 || !/^\d+$/.test(bcId.trim())) return;
    setStage("saving");
    setMsg("正在保存所选广告户 …");
    try {
      await invokeFn("tiktok-connection-save", {
        label: resp.label,
        access_token: resp.access_token,
        bc_id: bcId.trim(),
        bc_name: bcName.trim() || null,
        expires_at: resp.expires_at,
        advertiser_ids: Array.from(selected),
      });
      sessionStorage.setItem("tt_connect_done", `${resp.label}（${selected.size} 个广告户）`);
      setStage("ok");
      setMsg(`「${resp.label}」连接成功，已保存 ${selected.size} 个广告户`);
      setTimeout(() => navigate({ to: "/settings" }), 1200);
    } catch (e) {
      setStage("err");
      setMsg((e as Error).message);
    }
  };

  const visible = (resp?.advertisers ?? []).filter(
    (a) =>
      !filter ||
      a.advertiser_name.toLowerCase().includes(filter.toLowerCase()) ||
      a.advertiser_id.includes(filter),
  );

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 px-4 py-6">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {(stage === "loading" || stage === "saving") && <Loader2 className="h-5 w-5 animate-spin" />}
            {stage === "ok" && <CheckCircle2 className="h-5 w-5 text-emerald-600" />}
            {stage === "err" && <XCircle className="h-5 w-5 text-destructive" />}
            TikTok 授权回调
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{msg}</p>

          {stage === "choose" && resp && (
            <>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="搜索广告户名 / ID"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelected(new Set(resp.advertisers.map((a) => a.advertiser_id)))}
                >
                  全选
                </Button>
                <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>
                  清空
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {bcOptions.length > 1 ? (
                  <select
                    aria-label="BC（必填）"
                    value={bcId}
                    onChange={(e) => {
                      const b = bcOptions.find((x) => x.bc_id === e.target.value);
                      setBcId(e.target.value);
                      setBcName(b?.bc_name ?? "");
                    }}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                  >
                    <option value="">选择 BC（必填）</option>
                    {bcOptions.map((b) => <option key={b.bc_id} value={b.bc_id}>{b.bc_name}（{b.bc_id}）</option>)}
                  </select>
                ) : (
                  <input
                    aria-label="BC ID（必填）"
                    value={bcId}
                    onChange={(e) => setBcId(e.target.value.replace(/\s/g, ""))}
                    placeholder="BC ID（必填）"
                    inputMode="numeric"
                    className={`flex h-9 w-full rounded-md border bg-background px-3 py-1 text-sm ${bcId && !/^\d+$/.test(bcId) ? "border-destructive" : "border-input"}`}
                  />
                )}
                <input
                  aria-label="BC 名称"
                  value={bcName}
                  onChange={(e) => setBcName(e.target.value)}
                  placeholder="BC 名称"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                />
              </div>
              <div className="max-h-[50vh] overflow-y-auto rounded-md border divide-y">
                {visible.map((a) => (
                  <label
                    key={a.advertiser_id}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                  >
                    <Checkbox
                      checked={selected.has(a.advertiser_id)}
                      onCheckedChange={() => toggle(a.advertiser_id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{a.advertiser_name}</div>
                      <div className="text-xs text-muted-foreground">
                        ID: {a.advertiser_id}
                        {a.status ? ` · ${a.status}` : ""}
                      </div>
                    </div>
                  </label>
                ))}
                {visible.length === 0 && (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    无匹配结果
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  已选 {selected.size} / {resp.advertisers.length}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => navigate({ to: "/settings" })}>
                    取消
                  </Button>
                  <Button size="sm" disabled={selected.size === 0 || !/^\d+$/.test(bcId.trim())} onClick={handleSave}>
                    保存所选
                  </Button>
                </div>
              </div>
            </>
          )}

          {(stage === "err" || stage === "ok") && (
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/settings" })}>
              返回设置
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
