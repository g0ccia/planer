// Kurzbefehle vom iPhone: meldet eine Aktion an, die die Web-App beim nächsten Öffnen ausführt.
// webapp:// öffnet die Web-App nur, ohne Adresse oder #, deshalb dieser Umweg.
// Darf nur config/pending schreiben, mit einer festen Liste von Aktionen. Zugang über einen eigenen Schlüssel
// (SHA-256 in private.shortcut_tokens), als ?k=… oder Kopfzeile x-kurzbefehl.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const ACTS = new Set(["aufgabe", "termin", "notiz", "habit", "handschrift"]);

function text(s: string, status = 200) {
  return new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  const k = u.searchParams.get("k") || req.headers.get("x-kurzbefehl");
  if (!k || k.length < 32) return text("forbidden", 403);
  const ok = await sb.rpc("shortcut_token_ok", { t: k });
  if (ok.error || ok.data !== true) return text("forbidden", 403);
  const act = (u.searchParams.get("a") || "").toLowerCase();
  if (!ACTS.has(act)) return text("unbekannte Aktion", 400);
  const r = await sb.from("docs").upsert({ path: "config/pending", data: { act, at: new Date().toISOString() } });
  if (r.error) return text("Fehler: " + r.error.message, 500);
  return text("ok");
});
