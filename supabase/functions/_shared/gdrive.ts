// Google 云盘只读客户端（服务账号 JWT → access token → Drive v3）。SEA库存监控用：RPA 每天把海外仓库存 Excel 导到云盘文件夹，这里取最新一份。
//
// 配置：Supabase secret `GDRIVE_SERVICE_ACCOUNT_JSON` = Google Cloud 服务账号密钥 JSON 原文（含 client_email / private_key）。
// 云盘文件夹需「共享」给该服务账号邮箱（查看者即可）；共享盘同样适用（supportsAllDrives）。
// 官方依据：OAuth2 服务账号 JWT（RS256，aud=https://oauth2.googleapis.com/token，grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer）；
//          Drive v3 files.list（q="'<folder>' in parents and trashed=false"）、files.get?alt=media、files.export（Google 表格导出 xlsx）。

export type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };
export type DriveFile = { id: string; name: string; mimeType: string; modifiedTime: string; size?: string };

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const GSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const OK_MIME = new Set([XLSX_MIME, "application/vnd.ms-excel", "text/csv", GSHEET_MIME]);

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (s: string) => b64url(new TextEncoder().encode(s));

export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

export function parseServiceAccount(raw: string): ServiceAccount {
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw); } catch { throw new Error("GDRIVE_SERVICE_ACCOUNT_JSON 不是合法 JSON（请粘贴服务账号密钥文件全文）"); }
  if (!j.client_email || !j.private_key) throw new Error("GDRIVE_SERVICE_ACCOUNT_JSON 缺 client_email / private_key");
  return { client_email: String(j.client_email), private_key: String(j.private_key).replace(/\\n/g, "\n"), token_uri: j.token_uri ? String(j.token_uri) : undefined };
}

export async function signJwt(sa: ServiceAccount, nowSec: number, scope = SCOPE): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlStr(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)));
  return `${header}.${claims}.${b64url(sig)}`;
}

let cached: { token: string; exp: number } | null = null;

export async function driveToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const raw = Deno.env.get("GDRIVE_SERVICE_ACCOUNT_JSON") ?? "";
  if (!raw) throw new Error("未配置 Supabase secret GDRIVE_SERVICE_ACCOUNT_JSON（Google 服务账号密钥），无法读取云盘");
  const sa = parseServiceAccount(raw);
  const jwt = await signJwt(sa, Math.floor(Date.now() / 1000));
  const r = await fetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!j.access_token) throw new Error(`Google 换 token 失败：${j.error ?? r.status} ${j.error_description ?? ""}`.trim());
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}

/** 文件夹链接或 ID → ID */
export function folderIdOf(input: string): string {
  const s = String(input ?? "").trim();
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) ?? s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : s;
}

async function gfetch(url: string): Promise<Response> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${await driveToken()}` }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) {
    const t = await r.text();
    const hint = r.status === 404 ? "（文件夹不存在或没共享给服务账号邮箱）" : r.status === 403 ? "（服务账号无权限，或 Google Cloud 项目未启用 Drive API）" : "";
    throw new Error(`Google 云盘请求失败 http=${r.status}${hint}：${t.slice(0, 200)}`);
  }
  return r;
}

export async function listFolder(folder: string): Promise<DriveFile[]> {
  const id = folderIdOf(folder);
  const out: DriveFile[] = [];
  let pageToken = "";
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({
      q: `'${id}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
      orderBy: "modifiedTime desc",
      pageSize: "100",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) q.set("pageToken", pageToken);
    const j = (await (await gfetch(`https://www.googleapis.com/drive/v3/files?${q}`)).json()) as { files?: DriveFile[]; nextPageToken?: string };
    out.push(...(j.files ?? []));
    pageToken = j.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return out;
}

/** 选最新一份：表格类文件 + 文件名包含 namePattern（不区分大小写；空 = 不限） */
export function pickLatest(files: DriveFile[], namePattern?: string | null): DriveFile | null {
  const p = (namePattern ?? "").trim().toLowerCase();
  const ok = files.filter((f) => OK_MIME.has(f.mimeType) || /\.(xlsx|xls|csv)$/i.test(f.name))
    .filter((f) => !p || f.name.toLowerCase().includes(p));
  ok.sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime));
  return ok[0] ?? null;
}

export async function downloadFile(f: DriveFile): Promise<Uint8Array> {
  const url = f.mimeType === GSHEET_MIME
    ? `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
    : `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`;
  return new Uint8Array(await (await gfetch(url)).arrayBuffer());
}
