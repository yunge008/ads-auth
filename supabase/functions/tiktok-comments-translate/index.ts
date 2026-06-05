// Translate untranslated tiktok_comments.text to Chinese via Lovable AI Gateway.
// Body: { limit?: number }  default 200 per invocation.
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

async function translateBatch(texts: string[]): Promise<string[]> {
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) throw new Error("LOVABLE_API_KEY 未配置");
  const numbered = texts.map((t, i) => `${i + 1}. ${t.replace(/\n/g, " ")}`).join("\n");
  const res = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-lite",
      messages: [
        {
          role: "system",
          content:
            "你是翻译助手。把用户给的每一行评论翻译成简体中文（保留 emoji，禁止额外解释）。严格按相同编号格式返回，每行一条：'1. ...'。如果原文已经是中文，原样返回。",
        },
        { role: "user", content: numbered },
      ],
    }),
  });
  if (!res.ok) {
    if (res.status === 429) throw new Error("AI 翻译速率超限，请稍后再试");
    if (res.status === 402) throw new Error("AI 额度不足，请在 Lovable Cloud 设置中充值");
    throw new Error(`AI 翻译失败 HTTP ${res.status}: ${await res.text()}`);
  }
  const j = await res.json();
  const content: string = j.choices?.[0]?.message?.content ?? "";
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const out: string[] = new Array(texts.length).fill("");
  for (const ln of lines) {
    const m = ln.match(/^\s*(\d+)\.\s*(.*)$/);
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < texts.length) out[idx] = m[2].trim();
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "comments");
    const { limit = 200 } = (await req.json().catch(() => ({}))) as { limit?: number };
    const db = admin();
    const { data, error } = await db
      .from("tiktok_comments")
      .select("comment_id, text")
      .is("text_zh", null)
      .not("text", "is", null)
      .limit(limit);
    if (error) throw new Error(error.message);
    const rows = (data ?? []).filter((r) => (r.text ?? "").trim().length > 0);
    if (rows.length === 0) {
      return new Response(JSON.stringify({ translated: 0, remaining: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const BATCH = 20;
    let translated = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const translations = await translateBatch(slice.map((r) => r.text as string));
      const updates = slice
        .map((r, j) => ({ comment_id: r.comment_id, text_zh: translations[j] || null }))
        .filter((u) => u.text_zh);
      for (const u of updates) {
        await db.from("tiktok_comments").update({ text_zh: u.text_zh }).eq("comment_id", u.comment_id);
        translated += 1;
      }
    }
    const { count } = await db
      .from("tiktok_comments")
      .select("comment_id", { head: true, count: "exact" })
      .is("text_zh", null)
      .not("text", "is", null);
    return new Response(JSON.stringify({ translated, remaining: count ?? 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("tiktok-comments-translate", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
