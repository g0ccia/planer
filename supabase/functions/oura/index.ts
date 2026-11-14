// Oura: holt Schlaf, Tagesform, Aktivität und Stress selbst und schreibt sie in days/<Datum>.oura.
// Bestätigte Spaziergänge (Workout "walking") werden als Aktivität "Gassi" angelegt, jeder nur einmal (private.oura_seen).
// Einmal freigeben (OAuth2, ?a=start&k=<Einmal-Schlüssel>), danach ruft ein Zeitplan in der Datenbank ?a=sync auf.
// Client-ID und Secret der Oura-App stehen als Secrets OURA_CLIENT_ID / OURA_CLIENT_SECRET in Supabase,
// die Oura-Tokens in private.oura_tokens (nur über Funktionen für service_role erreichbar).
import { createClient } from "npm:@supabase/supabase-js@2";

const BASE = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const SELF = BASE + "/functions/v1/oura";
const CID = Deno.env.get("OURA_CLIENT_ID") || "";
const SEC = Deno.env.get("OURA_CLIENT_SECRET") || "";
const API = "https://api.ouraring.com";
const UA = "planer-oura/1.0";
const DAYS_BACK = 4;

function text(s: string, status = 200) {
  return new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
async function keyOk(k: string | null, kind: string) {
  if (!k || k.length < 32) return false;
  const r = await sb.rpc("oura_key_ok", { t: k, k: kind });
  return !r.error && r.data === true;
}
type Tok = { access_token: string; refresh_token: string; expires_at: string };

async function tokenCall(params: Record<string, string>) {
  const body = new URLSearchParams({ ...params, client_id: CID, client_secret: SEC });
  const r = await fetch(API + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Oura-Anmeldung: " + (j.error_description || j.error || r.status));
  const exp = new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString();
  const s = await sb.rpc("oura_tokens_set", { a: j.access_token, r: j.refresh_token || params.refresh_token || "", e: exp });
  if (s.error) throw new Error("Speichern: " + s.error.message);
  return j.access_token as string;
}
async function accessToken() {
  const r = await sb.rpc("oura_tokens_get");
  if (r.error) throw new Error(r.error.message);
  const t = (Array.isArray(r.data) ? r.data[0] : r.data) as Tok | null;
  if (!t || !t.access_token) return null;
  if (new Date(t.expires_at).getTime() - Date.now() > 5 * 60 * 1000) return t.access_token;
  if (!t.refresh_token) return null;
  return await tokenCall({ grant_type: "refresh_token", refresh_token: t.refresh_token });
}

const berlin = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" });
function ymd(d: Date) { return berlin.format(d); }
function addDays(ds: string, n: number) {
  const d = new Date(ds + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const num = (x: unknown) => typeof x === "number" && isFinite(x);
const min = (sec: unknown) => num(sec) ? Math.round((sec as number) / 60) : undefined;

async function coll(tok: string, name: string, start: string, end: string) {
  const out: Record<string, unknown>[] = [];
  let next: string | null = null;
  for (let i = 0; i < 5; i++) {
    const u = new URL(API + "/v2/usercollection/" + name);
    u.searchParams.set("start_date", start);
    u.searchParams.set("end_date", end);
    if (next) u.searchParams.set("next_token", next);
    const r = await fetch(u, { headers: { authorization: "Bearer " + tok, "user-agent": UA } });
    if (!r.ok) throw new Error(name + " " + r.status);
    const j = await r.json();
    (j.data || []).forEach((x: Record<string, unknown>) => out.push(x));
    next = j.next_token || null;
    if (!next) break;
  }
  return out;
}

const STRESS: Record<string, string> = { restored: "erholt", normal: "normal", stressful: "stressig" };

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const WALK = /gassi|spazier|runde|walk/i;

async function gassi(tok: string, start: string, end: string) {
  const ws = (await coll(tok, "workout", start, end)).filter((w) =>
    w.activity === "walking" && (w.source === "confirmed" || w.source === "manual") && typeof w.id === "string" &&
    typeof w.start_datetime === "string" && typeof w.end_datetime === "string"
  );
  if (!ws.length) return [];
  const seen = await sb.rpc("oura_seen_list", { ids: ws.map((w) => w.id) });
  if (seen.error) throw new Error(seen.error.message);
  const known = new Set((seen.data || []) as string[]);
  const fresh = ws.filter((w) => !known.has(w.id as string));
  if (!fresh.length) return [];
  const dates = Array.from(new Set(fresh.map((w) => (w.start_datetime as string).slice(0, 10))));
  const ex = await sb.from("docs").select("path,data").eq("coll", "items").in("data->>date", dates);
  if (ex.error) throw new Error(ex.error.message);
  const acts = ((ex.data || []) as { path: string; data: Record<string, unknown> }[]).filter((r) =>
    r.data && r.data.kind === "aktivitaet" && typeof r.data.start === "string"
  );
  const made: string[] = [];
  for (const w of fresh) {
    const sd = w.start_datetime as string, ed = w.end_datetime as string;
    const date = sd.slice(0, 10), s = sd.slice(11, 16), e = ed.slice(0, 10) === date ? ed.slice(11, 16) : "23:59";
    const a = toMin(s), b = Math.max(toMin(e), a + 1);
    const hit = acts.find((r) => {
      if (r.data.date !== date) return false;
      const x = toMin(r.data.start as string), y = typeof r.data.end === "string" && r.data.end ? toMin(r.data.end as string) : x + 1;
      if (!(a < y && b > x)) return false;
      return WALK.test(String(r.data.title || "")) || String(r.data.emoji || "").indexOf("\u{1F415}") >= 0;
    });
    if (hit) {
      await sb.rpc("oura_seen_add", { i: w.id, p: hit.path });
      continue;
    }
    const now = new Date().toISOString(), bits: string[] = [];
    if (num(w.distance) && (w.distance as number) > 0) bits.push(((w.distance as number) / 1000).toFixed(2).replace(".", ",") + " km");
    if (num(w.calories) && (w.calories as number) > 0) bits.push(Math.round(w.calories as number) + " kcal");
    const path = "items/" + date + "-gassi-" + Math.random().toString(36).slice(2, 6);
    const data = {
      kind: "aktivitaet", title: "Gassi", emoji: "\u{1F415}\u200D\u{1F9BA}", date, start: s, end: e, est: null, until: null, done: false,
      tags: ["Viechs"], note: bits.join(" · "), order: 0, attachments: [], source: "oura", ouraId: w.id, createdAt: now, updatedAt: now,
    };
    const ins = await sb.from("docs").insert({ path, data });
    if (ins.error) throw new Error(ins.error.message);
    acts.push({ path, data });
    await sb.rpc("oura_seen_add", { i: w.id, p: path });
    made.push(date + " " + s);
  }
  return made;
}

async function sync() {
  const tok = await accessToken();
  if (!tok) return { ok: false, reason: "nicht verbunden" };
  const today = ymd(new Date()), start = addDays(today, -DAYS_BACK), end = addDays(today, 1);
  const r = await syncDays(tok, today, start, end);
  let walks: string[] = [], walkErr: string | null = null;
  try {
    walks = await gassi(tok, start, end);
  } catch (e) {
    walkErr = (e as Error).message;
  }
  return { ...r, gassi: walks, gassiError: walkErr };
}

async function syncDays(tok: string, today: string, start: string, end: string) {
  const names = ["sleep", "daily_sleep", "daily_readiness", "daily_activity", "daily_stress"];
  const res = await Promise.allSettled(names.map((n) => coll(tok, n, start, end)));
  const got = (i: number) => res[i].status === "fulfilled" ? (res[i] as PromiseFulfilledResult<Record<string, unknown>[]>).value : [];
  const failed = names.filter((_, i) => res[i].status === "rejected");
  if (failed.length === names.length) throw new Error("Oura antwortet nicht: " + String((res[0] as PromiseRejectedResult).reason));

  const oura: Record<string, Record<string, unknown>> = {};
  const top: Record<string, Record<string, unknown>> = {};
  const o = (d: string) => (oura[d] = oura[d] || {});
  const t = (d: string) => (top[d] = top[d] || {});
  const put = (obj: Record<string, unknown>, k: string, v: unknown) => { if (v !== undefined && v !== null) obj[k] = v; };

  // Hauptschlaf je Tag: längste long_sleep-Phase
  const main: Record<string, Record<string, unknown>> = {};
  got(0).forEach((s) => {
    if (s.type !== "long_sleep" || typeof s.day !== "string") return;
    const cur = main[s.day];
    if (!cur || Number(s.total_sleep_duration) > Number(cur.total_sleep_duration)) main[s.day] = s;
  });
  Object.keys(main).forEach((d) => {
    const s = main[d], x = o(d);
    put(x, "sleepMin", min(s.total_sleep_duration));
    put(x, "inBedMin", min(s.time_in_bed));
    put(x, "deepMin", min(s.deep_sleep_duration));
    put(x, "remMin", min(s.rem_sleep_duration));
    put(x, "lightMin", min(s.light_sleep_duration));
    put(x, "awakeMin", min(s.awake_time));
    put(x, "latencyMin", min(s.latency));
    put(x, "effPct", num(s.efficiency) ? s.efficiency : undefined);
    put(x, "hrAvg", num(s.average_heart_rate) ? Math.round((s.average_heart_rate as number) * 10) / 10 : undefined);
    put(x, "hrLow", num(s.lowest_heart_rate) ? s.lowest_heart_rate : undefined);
    put(x, "hrv", num(s.average_hrv) ? Math.round(s.average_hrv as number) : undefined);
    put(x, "breath", num(s.average_breath) ? Math.round((s.average_breath as number) * 10) / 10 : undefined);
    if (num(s.restless_periods)) {
      x.restless = s.restless_periods;
      if (num(s.time_in_bed) && (s.time_in_bed as number) > 0) x.restlessPerH = Math.round((s.restless_periods as number) / ((s.time_in_bed as number) / 3600) * 10) / 10;
    }
    if (typeof s.bedtime_end === "string" && s.bedtime_end.length >= 16) t(d).wake = s.bedtime_end.slice(11, 16);
    if (typeof s.bedtime_start === "string" && s.bedtime_start.length >= 16) {
      const p = t(addDays(d, -1));
      p.bed = s.bedtime_start.slice(11, 16);
      p.bedNextDay = s.bedtime_start.slice(0, 10) === d;
    }
  });
  got(1).forEach((x) => { if (typeof x.day === "string") put(o(x.day), "sleepScore", num(x.score) ? x.score : undefined); });
  got(2).forEach((x) => {
    if (typeof x.day !== "string") return;
    const y = o(x.day), c = (x.contributors || {}) as Record<string, unknown>;
    put(y, "readiness", num(x.score) ? x.score : undefined);
    put(y, "tempDev", num(x.temperature_deviation) ? Math.round((x.temperature_deviation as number) * 100) / 100 : undefined);
    put(y, "recoveryIndex", num(c.recovery_index) ? c.recovery_index : undefined);
  });
  got(3).forEach((x) => {
    if (typeof x.day !== "string") return;
    const y = o(x.day);
    put(y, "steps", num(x.steps) ? x.steps : undefined);
    put(y, "activeKcal", num(x.active_calories) ? x.active_calories : undefined);
    put(y, "activityScore", num(x.score) ? x.score : undefined);
  });
  got(4).forEach((x) => {
    if (typeof x.day !== "string") return;
    const y = o(x.day);
    put(y, "stressMin", min(x.stress_high));
    put(y, "recoveryMin", min(x.recovery_high));
    if (typeof x.day_summary === "string" && STRESS[x.day_summary]) y.stressDay = STRESS[x.day_summary];
  });

  const days = Array.from(new Set(Object.keys(oura).concat(Object.keys(top)))).filter((d) => d >= addDays(start, -1) && d <= today).sort();
  if (!days.length) return { ok: true, written: [], failed };
  const cur = await sb.from("docs").select("path,data").in("path", days.map((d) => "days/" + d));
  if (cur.error) throw new Error(cur.error.message);
  const have: Record<string, Record<string, unknown>> = {};
  (cur.data || []).forEach((r: { path: string; data: Record<string, unknown> }) => { have[r.path] = r.data || {}; });
  const now = new Date().toISOString(), written: string[] = [];
  for (const d of days) {
    const path = "days/" + d, old = have[path], oldO = ((old && old.oura) || {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    const tp = top[d] || {};
    Object.keys(tp).forEach((k) => { if (!old || old[k] !== tp[k]) patch[k] = tp[k]; });
    const op = oura[d];
    if (op) {
      op.final = d <= addDays(today, -2);
      const diff: Record<string, unknown> = {};
      Object.keys(op).forEach((k) => { if (oldO[k] !== op[k]) diff[k] = op[k]; });
      if (Object.keys(diff).length) { diff.at = now; diff.by = "planer"; patch.oura = diff; }
    }
    if (!Object.keys(patch).length) continue;
    patch.updatedAt = now;
    if (patch.oura || patch.wake) patch.source = "oura";
    if (old) {
      const u = await sb.rpc("doc_update", { p_path: path, p_patch: patch });
      if (u.error) throw new Error(u.error.message);
    } else {
      const ins = await sb.from("docs").insert({ path, data: { date: d, ...patch } });
      if (ins.error) throw new Error(ins.error.message);
    }
    written.push(d);
  }
  return { ok: true, written, failed };
}

Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  const a = u.searchParams.get("a") || "";
  try {
    if (u.searchParams.get("error")) return text("Oura hat die Freigabe nicht erteilt: " + u.searchParams.get("error"), 400);
    if (u.searchParams.get("code")) {
      const st = u.searchParams.get("state");
      if (!(await keyOk(st, "connect"))) return text("Der Freigabe-Link ist abgelaufen. Bitte einen neuen anfordern.", 403);
      if (!CID || !SEC) return text("Client-ID oder Secret fehlen in Supabase.", 500);
      await tokenCall({ grant_type: "authorization_code", code: u.searchParams.get("code")!, redirect_uri: SELF });
      await sb.rpc("oura_key_used", { t: st });
      let msg = "";
      try {
        const r = await sync();
        msg = r.ok ? " Abruf: " + ((r.written || []).length ? (r.written || []).join(", ") : "nichts Neues") + ". Gassi-Runden angelegt: " + (r.gassi || []).length + (r.gassiError ? " (Fehler: " + r.gassiError + ")" : "") + "." : "";
      } catch (e) {
        msg = " Der erste Abruf hat nicht geklappt (" + (e as Error).message + "), der Zeitplan versucht es wieder.";
      }
      return text("Oura ist mit dem Planer verbunden." + msg + " Du kannst dieses Fenster schließen.");
    }
    if (a === "start") {
      const k = u.searchParams.get("k");
      if (!(await keyOk(k, "connect"))) return text("Der Freigabe-Link ist abgelaufen. Bitte einen neuen anfordern.", 403);
      if (!CID || !SEC) return text("Client-ID oder Secret fehlen noch in Supabase (OURA_CLIENT_ID, OURA_CLIENT_SECRET).", 500);
      const to = new URL("https://cloud.ouraring.com/oauth/authorize");
      to.searchParams.set("response_type", "code");
      to.searchParams.set("client_id", CID);
      to.searchParams.set("redirect_uri", SELF);
      to.searchParams.set("scope", "daily workout");
      to.searchParams.set("state", k!);
      return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
    }
    if (a === "sync" || a === "status") {
      if (!(await keyOk(req.headers.get("x-oura-key"), "cron"))) return text("forbidden", 403);
      if (a === "status") {
        const r = await sb.rpc("oura_tokens_get");
        const tk = (Array.isArray(r.data) ? r.data[0] : r.data) as Tok | null;
        return json({ connected: !!(tk && tk.access_token), expires_at: tk ? tk.expires_at : null, secrets: !!(CID && SEC) });
      }
      return json(await sync());
    }
    return text("forbidden", 403);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
