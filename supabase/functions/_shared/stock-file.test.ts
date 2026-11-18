// 跑法：deno test --allow-env supabase/functions/_shared/stock-file.test.ts
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { parseStockTable, parseStockWorkbook } from "./stock-file.ts";
import { folderIdOf, pemToDer, pickLatest, signJwt, type DriveFile } from "./gdrive.ts";

function eq(a: unknown, b: unknown, msg = "") {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} expected ${sb} got ${sa}`);
}

Deno.test("库存表：自动识别表头（表头不在第一行）、千分位、负数、空行", () => {
  const t = [
    ["库存导出 2026-11-18"],
    [],
    ["商品SKU", "商品名称", "可用库存", "在库"],
    ["AR245", "耳环", "1,031", "1,100"],
    ["AR245-B4", "耳环 4 只装", "-2", "0"],
    ["", "", "", ""],
    ["AR999", "坏行", "abc", ""],
  ];
  const r = parseStockTable(t);
  eq(r.header_row, 3);
  eq(r.rows, [
    { wh_sku: "AR245", available: 1031, on_hand: 1100, product_name: "耳环" },
    { wh_sku: "AR245-B4", available: 0, on_hand: 0, product_name: "耳环 4 只装" },
  ]);
  eq(r.notes.length, 3, "表头位置 / 坏行 / 负数");
});

Deno.test("库存表：按配置列名 + 只取指定仓库（BigSeller 多仓导出）；同 SKU 多行合计", () => {
  const t = [
    ["Warehouse", "SKU", "Available Stock", "Total"],
    ["VN-HCM", "AR1", "5", "6"],
    ["CN-SZ", "AR1", "100", "100"],
    ["VN-HCM", "AR1", "3", "3"],
    ["VN-HCM", "AR2", "0", "0"],
  ];
  const r = parseStockTable(t, { sku_col: "sku", avail_col: "available stock", onhand_col: "Total", warehouse_col: "Warehouse", warehouse_value: "VN-HCM" });
  eq(r.rows.map((x) => [x.wh_sku, x.available, x.on_hand]), [["AR1", 8, 9], ["AR2", 0, 0]]);
  eq(r.notes.some((n) => n.includes("其他仓库")), true);
  eq(r.notes.some((n) => n.includes("重复")), true);
});

Deno.test("库存表：找不到表头给出明确原因", () => {
  const r = parseStockTable([["a", "b"], ["1", "2"]], { sku_col: "货号" });
  eq(r.rows.length, 0);
  eq(r.notes[0].includes("货号"), true);
});

Deno.test("xlsx 文件：多 sheet 时选第一个能识别表头的", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["说明"], ["这是封面"]]), "封面");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["SKU", "可用"], ["AR1", 7], ["AR2", 0]]), "库存");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  const r = parseStockWorkbook(bytes);
  eq([r.sheet, r.rows.length, r.rows[0].available], ["库存", 2, 7]);
  const r2 = parseStockWorkbook(bytes, { sheet: "不存在" });
  eq(r2.rows.length, 0);
});

Deno.test("云盘：文件夹链接解析、按文件名过滤取最新表格", () => {
  eq(folderIdOf("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing"), "1AbCdEfGhIjKlMnOp");
  eq(folderIdOf("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp"), "1AbCdEfGhIjKlMnOp");
  eq(folderIdOf(" 1AbCdEfGhIjKlMnOp "), "1AbCdEfGhIjKlMnOp");
  const f = (name: string, t: string, mimeType = "application/octet-stream"): DriveFile => ({ id: name, name, mimeType, modifiedTime: t });
  const files = [f("VN库存_1117.xlsx", "2026-11-17T01:00:00Z"), f("VN库存_1118.xlsx", "2026-11-18T01:00:00Z"), f("readme.txt", "2026-11-18T05:00:00Z"), f("TH库存_1118.csv", "2026-11-18T02:00:00Z")];
  eq(pickLatest(files, "vn库存")?.name, "VN库存_1118.xlsx");
  eq(pickLatest(files, "")?.name, "TH库存_1118.csv");
  eq(pickLatest(files, "不存在"), null);
});

Deno.test("云盘：服务账号 JWT（RS256）签名可被公钥验证、声明正确", async () => {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const b64 = btoa(String.fromCharCode(...der));
  // 服务账号 JSON 里的 private_key 是带 \n 的 PEM
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  eq(pemToDer(pem).length, der.length);
  const jwt = await signJwt({ client_email: "sea@proj.iam.gserviceaccount.com", private_key: pem }, 1_763_400_000);
  const [h, c, s] = jwt.split(".");
  const dec = (x: string) => JSON.parse(atob(x.replace(/-/g, "+").replace(/_/g, "/")));
  eq(dec(h), { alg: "RS256", typ: "JWT" });
  eq(dec(c), { iss: "sea@proj.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/drive.readonly", aud: "https://oauth2.googleapis.com/token", iat: 1_763_400_000, exp: 1_763_403_600 });
  const sb = s.replace(/-/g, "+").replace(/_/g, "/");
  const sig = Uint8Array.from(atob(sb + "=".repeat((4 - (sb.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, sig, new TextEncoder().encode(`${h}.${c}`));
  eq(ok, true);
});

Deno.test("BigSeller 导出：单个SKU + 组合SKU 两个 sheet，组合默认跳过；整仓可用列；按仓库过滤", () => {
  const head = ["SKU编号", "仓库", "现有库存", "订单已锁", "整仓可用", "活动预留", "SKU类型"];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ["AR108", "artphro -vn", 365, 2, 363, 0, "Single SKU"], ["B4", "artphro -vn", 269, 0, 269, 0, "Single SKU"]]), "单个SKU");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ["AR108+ B4", "artphro -vn", 269, 0, 269, 0, "Combination SKU"]]), "组合SKU");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  const r = parseStockWorkbook(bytes, { warehouse_value: "artphro -vn" });
  eq(r.rows.map((x) => [x.wh_sku, x.available, x.on_hand]), [["AR108", 363, 365], ["B4", 269, 269]]);
  eq(r.notes.some((n) => n.includes("跳过 1 个组合")), true);
  const r2 = parseStockWorkbook(bytes, { warehouse_value: "artphro -vn", include_combo: true });
  eq(r2.rows.length, 3);
});
