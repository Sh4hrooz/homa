import express from "express";
import Database from "better-sqlite3";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === "production";
const ACCESS_PASSWORD = String(process.env.HOMA_ACCESS_PASSWORD || "").trim();
const OWNER = String(process.env.HOMA_OWNER_NAME || "مدیر پروژه").trim().slice(0, 80);
if (isProd && ACCESS_PASSWORD.length < 16) throw new Error("HOMA_ACCESS_PASSWORD must be at least 16 characters in production.");

app.disable("x-powered-by");
if (isProd) app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb", strict: true }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", req.path.startsWith("/api/") ? "no-store" : "public, max-age=3600");
  res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; upgrade-insecure-requests");
  if (isProd) res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  next();
});

const dbPath = process.env.HOMA_DB_PATH || path.join(__dirname, "../data/homa.sqlite");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.exec(`
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, detail TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
const log = (type, detail = "") => db.prepare("INSERT INTO events(type,detail) VALUES(?,?)").run(type, String(detail).slice(0, 500));

const providers = [];
function addProvider(name, kind, key, model, base = "") {
  if (!key || !model) return;
  providers.push({ name, kind, key, model, base });
}
addProvider("OpenAI", "openai", process.env.OPENAI_API_KEY || process.env.HOMA_API_KEY, process.env.OPENAI_MODEL || process.env.HOMA_MODEL || "gpt-5.6-luna", process.env.OPENAI_BASE_URL || process.env.HOMA_API_BASE || "https://api.openai.com/v1");
addProvider("Anthropic", "anthropic", process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5", "https://api.anthropic.com");
addProvider("Gemini", "gemini", process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL || "gemini-2.5-flash", "https://generativelanguage.googleapis.com/v1beta");
addProvider("AI-2", "openai", process.env.HOMA_API_KEY_2, process.env.HOMA_MODEL_2, process.env.HOMA_API_BASE_2);

const SESSION_TTL = 12 * 60 * 60 * 1000;
const RATE_WINDOW = 15 * 60 * 1000;
const LOGIN_RATE_MAX = 8;
const CHAT_RATE_MAX = 30;
const attempts = new Map();
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
function clientKey(req) { return String(req.ip || req.socket.remoteAddress || "unknown"); }
function rateLimit(req, bucket, max) {
  const key = `${bucket}:${clientKey(req)}`; const now = Date.now();
  const old = attempts.get(key) || [];
  const recent = old.filter(t => now - t < RATE_WINDOW); recent.push(now); attempts.set(key, recent);
  return recent.length <= max;
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}
function setCookie(res, name, value, maxAge) {
  const secure = isProd ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; SameSite=Strict${secure}`);
}
function getSession(req) {
  const raw = parseCookies(req).homa_session;
  if (!raw) return null;
  const row = db.prepare("SELECT token_hash, csrf_hash, expires_at FROM sessions WHERE token_hash=?").get(sha256(raw));
  if (!row || row.expires_at < Date.now()) { if (row) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(row.token_hash); return null; }
  return { raw, ...row };
}
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!ACCESS_PASSWORD || !s) return res.status(401).json({ error: "نیاز به ورود داری." });
  req.homaSession = s; next();
}
function requireCsrf(req, res, next) {
  const supplied = String(req.get("X-HOMA-CSRF") || "");
  if (!supplied || !req.homaSession || sha256(supplied) !== req.homaSession.csrf_hash) return res.status(403).json({ error: "درخواست امن نیست؛ صفحه را تازه کن." });
  next();
}
function timingSafeEqualText(a, b) {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function systemPrompt() {
  return `تو یکی از اعضای تیم HOMA هستی. ${OWNER} مدیر کامل پروژه است و تصمیم نهایی با اوست.
نقش تیمی: کمک عملی، صادقانه و هماهنگ با سایر AIها؛ اگر پاسخ هم‌تیمی بهتر است، از آن یاد بگیر و دلیل کوتاه بیاور.
سبک: فارسی، خیلی خلاصه، فوق‌العاده مفید، صمیمی و کمی شوخ‌طبع. اول نتیجه و اقدام بعدی.
ادعای انجام کار ممنوع مگر واقعاً انجام شده باشد. رمزها، کلیدهای API و داده محرمانه را افشا نکن.
یادگیری HOMA فقط از گفتگو، بازخورد مدیر و منابعی است که مدیر/سیستم مجاز به آن دسترسی داده؛ خودسرانه به حساب‌ها یا سرویس‌های دیگر وصل نشو.`;
}

async function fetchJson(url, options, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = {}; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

async function ask(provider, messages) {
  if (provider.kind === "anthropic") {
    const system = messages.find(m => m.role === "system")?.content || "";
    const bodyMessages = messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content }));
    const j = await fetchJson(`${provider.base}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": provider.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: provider.model, max_tokens: 1400, system, messages: bodyMessages })
    });
    return j.content?.map(x => x.text || "").join("").trim() || "پاسخی دریافت نشد.";
  }
  if (provider.kind === "gemini") {
    const contents = messages.filter(m => m.role !== "system").map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const system = messages.find(m => m.role === "system")?.content;
    const j = await fetchJson(`${provider.base}/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.key)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents, generationConfig: { temperature: 0.55, maxOutputTokens: 1400 } })
    });
    return j.candidates?.[0]?.content?.parts?.map(x => x.text || "").join("").trim() || "پاسخی دریافت نشد.";
  }
  const base = provider.base.replace(/\/$/, "");
  const j = await fetchJson(`${base}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${provider.key}` },
    body: JSON.stringify({ model: provider.model, messages, temperature: 0.55, max_tokens: 1400 })
  });
  return j.choices?.[0]?.message?.content?.trim() || "پاسخی دریافت نشد.";
}

async function orchestrate(userText) {
  const history = db.prepare("SELECT role,content FROM messages ORDER BY id DESC LIMIT 20").all().reverse();
  const messages = [{ role: "system", content: systemPrompt() }, ...history];
  if (!providers.length) return { reply: "هما آماده است؛ هنوز کلید هیچ مدل AI روی سرور تنظیم نشده.", agents: [], connected: false };
  const results = await Promise.allSettled(providers.map(p => ask(p, messages)));
  const usable = results.map((x, i) => x.status === "fulfilled" ? { provider: providers[i].name, text: x.value } : null).filter(Boolean);
  const failed = results.map((x, i) => x.status === "rejected" ? providers[i].name : null).filter(Boolean);
  if (!usable.length) throw new Error(`all providers failed: ${failed.join(",")}`);
  if (usable.length === 1) return { reply: usable[0].text, agents: usable.map(x => x.provider), connected: true };
  const packet = usable.map(x => `[${x.provider}]\n${x.text}`).join("\n\n");
  const judge = providers[0];
  const final = await ask(judge, [
    { role: "system", content: systemPrompt() + "\nتو هما هستی؛ پاسخ‌های تیم را مقایسه کن، خطاها را حذف کن و یک پاسخ واحد، کوتاه و عملی بده. اسم AIها را فقط اگر مفید بود ذکر کن." },
    { role: "user", content: `درخواست مدیر:\n${userText}\n\nگزارش اعضای تیم:\n${packet}` }
  ]);
  log("multi_agent", `providers=${usable.map(x => x.provider).join(",")}`);
  return { reply: final, agents: usable.map(x => x.provider), connected: true, unavailable: failed };
}

app.get("/api/health", (req, res) => res.json({ ok: true, app: "HOMA", version: "5.3.0", providers: providers.map(p => ({ name: p.name, model: p.model })), secured: Boolean(ACCESS_PASSWORD) }));
app.get("/api/me", (req, res) => {
  const s = getSession(req); res.setHeader("Cache-Control", "no-store");
  if (!s) return res.json({ authenticated: false });
  const csrf = crypto.randomBytes(24).toString("base64url");
  db.prepare("UPDATE sessions SET csrf_hash=? WHERE token_hash=?").run(sha256(csrf), s.token_hash);
  res.json({ authenticated: true, csrf, owner: OWNER });
});
app.post("/api/login", (req, res) => {
  if (!rateLimit(req, "login", LOGIN_RATE_MAX)) return res.status(429).json({ error: "تلاش‌ها زیاد شده؛ کمی بعد دوباره امتحان کن." });
  const password = String(req.body?.password || "");
  if (!ACCESS_PASSWORD || !timingSafeEqualText(password, ACCESS_PASSWORD)) return res.status(401).json({ error: "رمز ورود نادرست است." });
  const token = crypto.randomBytes(32).toString("base64url"); const csrf = crypto.randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO sessions(token_hash,csrf_hash,expires_at) VALUES(?,?,?)").run(sha256(token), sha256(csrf), Date.now() + SESSION_TTL);
  setCookie(res, "homa_session", token, SESSION_TTL / 1000); log("login", "admin session created"); res.json({ ok: true, csrf });
});
app.post("/api/logout", requireAuth, requireCsrf, (req, res) => { db.prepare("DELETE FROM sessions WHERE token_hash=?").run(req.homaSession.token_hash); setCookie(res, "homa_session", "", 0); res.json({ ok: true }); });
app.get("/api/history", requireAuth, (req, res) => res.json(db.prepare("SELECT role,content,created_at FROM messages ORDER BY id").all()));
app.post("/api/chat", requireAuth, requireCsrf, async (req, res) => {
  if (!rateLimit(req, "chat", CHAT_RATE_MAX)) return res.status(429).json({ error: "پیام‌ها خیلی سریع ارسال شدند؛ چند لحظه صبر کن." });
  const text = String(req.body?.message || "").trim();
  if (!text || text.length > 12000) return res.status(400).json({ error: "پیام باید بین ۱ تا ۱۲۰۰۰ کاراکتر باشد." });
  db.prepare("INSERT INTO messages(role,content) VALUES(?,?)").run("user", text);
  try { const out = await orchestrate(text); db.prepare("INSERT INTO messages(role,content) VALUES(?,?)").run("assistant", out.reply); res.json(out); }
  catch (e) { log("error", e.message); res.status(502).json({ error: "هسته HOMA فعلاً نتونست از تیم AI پاسخ بگیره." }); }
});
app.post("/api/clear", requireAuth, requireCsrf, (req, res) => { db.exec("DELETE FROM messages"); log("memory_clear", "conversation cleared"); res.json({ ok: true }); });
app.use(express.static(path.join(__dirname, "../public"), { index: false, maxAge: isProd ? "1h" : 0 }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../public/index.html")));
setInterval(() => {
  const now = Date.now(); db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  for (const [key, ts] of attempts) if (!ts.some(x => now - x < RATE_WINDOW)) attempts.delete(key);
}, 10 * 60 * 1000).unref();
app.listen(PORT, () => console.log(`HOMA v5.3 running on :${PORT}`));
