// ECO 代理商后台二次验证：服务器首次登录 ECO 会被要求短信/邮箱验证码，
// 这里让管理员手工完成一次（选方式 → 发码 → 填码），成功后服务端保存信任设备 ID，之后自动登录免验证。
import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { invokeFn } from "@/lib/api";

type Status = { configured: boolean; device_saved: boolean; device_at: string | null };
type SendResult =
  | { needs2fa: false }
  | { needs2fa: true; method: number; methods: number[]; recipient: string };

const METHOD_LABEL: Record<number, string> = { 1: "短信", 2: "邮箱" };

export function EcoVerifyButton({ onVerified }: { onVerified?: () => void }) {
  const [status, setStatus] = React.useState<Status | null>(null);
  const [open, setOpen] = React.useState(false);
  const [method, setMethod] = React.useState(1);
  const [methods, setMethods] = React.useState<number[]>([1, 2]);
  const [recipient, setRecipient] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const loadStatus = React.useCallback(async () => {
    try {
      setStatus(await invokeFn<Status>("balance-alert", { action: "eco_status" }));
    } catch {
      setStatus(null);
    }
  }, []);
  React.useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const send = async (m: number) => {
    setBusy(true);
    try {
      const r = await invokeFn<SendResult>("balance-alert", { action: "eco_2fa_send", method: m });
      if (!r.needs2fa) {
        toast.success("ECO 当前无需验证，已可自动登录");
        setOpen(false);
        await loadStatus();
        onVerified?.();
        return;
      }
      setMethod(r.method);
      setMethods(r.methods?.length ? r.methods : [1, 2]);
      setRecipient(r.recipient);
      toast.success(`验证码已发送到 ${r.recipient}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    try {
      await invokeFn("balance-alert", { action: "eco_2fa_verify", method, code });
      toast.success("ECO 验证成功，已记住设备，之后自动登录");
      setOpen(false);
      setCode("");
      setRecipient("");
      await loadStatus();
      onVerified?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const label = !status
    ? "ECO：状态未知"
    : !status.configured
      ? "ECO：未配置账号"
      : status.device_saved
        ? `ECO：已验证设备（${status.device_at ? new Date(status.device_at).toLocaleDateString() : ""}）`
        : "ECO：未验证";

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={!status?.configured}
        onClick={() => {
          setOpen(true);
          setRecipient("");
          setCode("");
        }}
      >
        <ShieldCheck className="h-4 w-4 mr-1.5" />
        ECO 验证
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>ECO 后台二次验证</DialogTitle>
            <DialogDescription>
              服务器登录 ECO
              时被要求验证。完成一次后会记住该设备，之后每日自动刷新不再需要验证码；若 ECO
              让设备失效，自动刷新会在飞书里提示「需要二次验证」，再来这里做一次即可。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm w-16">验证方式</span>
              {methods.map((m) => (
                <Button
                  key={m}
                  size="sm"
                  variant={method === m ? "default" : "outline"}
                  onClick={() => setMethod(m)}
                  disabled={busy}
                >
                  {METHOD_LABEL[m] ?? `方式${m}`}
                </Button>
              ))}
              <Button size="sm" variant="secondary" onClick={() => send(method)} disabled={busy}>
                {recipient ? "重新发送" : "发送验证码"}
              </Button>
            </div>
            {recipient && <div className="text-xs text-muted-foreground">已发送到 {recipient}</div>}
            <div className="flex items-center gap-2">
              <span className="text-sm w-16">验证码</span>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="输入收到的验证码"
                className="h-8"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && code.trim()) verify();
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={verify} disabled={busy || !code.trim()}>
              验证并记住设备
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
