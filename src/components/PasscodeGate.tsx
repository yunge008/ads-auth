import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getPasscode, onPasscodeNeeded, setPasscode } from "@/lib/api";

export function PasscodeGate() {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");

  useEffect(() => {
    if (!getPasscode()) setOpen(true);
    const off = onPasscodeNeeded(() => setOpen(true));
    return () => { off(); };
  }, []);

  const submit = () => {
    const v = val.trim();
    if (!v) return;
    setPasscode(v);
    setVal("");
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && getPasscode()) setOpen(false); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>请输入管理员密码</DialogTitle>
          <DialogDescription>
            本工具的所有后端操作需要管理员密码验证。密码会保存在此浏览器，可在控制台清除。
          </DialogDescription>
        </DialogHeader>
        <Input
          type="password"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="ADMIN_PASSCODE"
          autoFocus
        />
        <DialogFooter>
          <Button onClick={submit}>确定</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
