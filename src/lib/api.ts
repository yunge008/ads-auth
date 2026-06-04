import { supabase } from "@/integrations/supabase/client";

export async function invokeFn<T = unknown>(
  name: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, {
    body: body ?? {},
  });
  if (error) {
    const err = error as unknown as { context?: Response };
    let msg = error.message;
    if (err.context && typeof err.context.json === "function") {
      try {
        const j = await err.context.json();
        if (j?.error) msg = j.error;
      } catch { /* ignore */ }
    }
    throw new Error(msg);
  }
  return data as T;
}
