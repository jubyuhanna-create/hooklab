import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ====================================================
// ✅ المفاتيح تُقرأ من .env فقط — لا تحط أي مفتاح هنا
// ====================================================
const OPENROUTER_API_KEY = process.env.GEMINI_API_KEY; // نفس المتغير — بس حطّ فيه مفتاح OpenRouter
const SUPABASE_URL       = process.env.SUPABASE_URL    || "";
const SUPABASE_ANON_KEY  = process.env.SUPABASE_ANON_KEY || "";

const COOLDOWN_MS      = 10_000;
const DAILY_USER_LIMIT = 5;
const FP_REDUCED_LIMIT = 2;

const cooldowns           = new Map();
const fingerprintAccounts = new Map();

// ── IP Rate Limiter ──────────────────────────────────────────────────────────
const ipLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { error: "Too many requests from this IP. Try again tomorrow." },
});

// ── Verify Supabase JWT ──────────────────────────────────────────────────────
async function verifyToken(token) {
  if (!token || !SUPABASE_ANON_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

// ── Anti-Abuse Middleware ────────────────────────────────────────────────────
async function antiAbuse(req, res, next) {
  const { token, fingerprint } = req.body;

  if (!token)
    return res.status(401).json({ error: "Authentication required." });
  if (!fingerprint || fingerprint.length < 6)
    return res.status(400).json({ error: "Invalid request signature." });

  const user = await verifyToken(token);
  if (!user)
    return res.status(401).json({ error: "Session expired. Please sign in again." });

  const userId = user.id;
  const now    = Date.now();

  const lastReq = cooldowns.get(userId) || 0;
  const elapsed = now - lastReq;
  if (elapsed < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    return res.status(429).json({ error: `Please wait ${wait}s before generating again.` });
  }

  const accounts = fingerprintAccounts.get(fingerprint) ?? new Set();
  accounts.add(userId);
  fingerprintAccounts.set(fingerprint, accounts);
  const effectiveLimit = accounts.size > 1 ? FP_REDUCED_LIMIT : DAILY_USER_LIMIT;

  let serverUsage = 0;
  if (SUPABASE_ANON_KEY) {
    try {
      const today = new Date().toISOString().split("T")[0];
      const usageRes = await fetch(
        `${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}&date=eq.${today}&select=count`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } }
      );
      const usageData = await usageRes.json();
      serverUsage = usageData?.[0]?.count ?? 0;
    } catch { /* non-fatal */ }
  }

  if (serverUsage >= effectiveLimit) {
    const msg = accounts.size > 1
      ? "Multiple accounts detected on this device. Daily limit reduced."
      : "Daily generation limit reached. Resets in 24 hours.";
    return res.status(429).json({ error: msg });
  }

  cooldowns.set(userId, now);
  req.verifiedUserId = userId;
  next();
}

// ── Extract JSON ─────────────────────────────────────────────────────────────
function extractJSON(raw) {
  if (!raw) return null;
  let text = raw.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  if (text.startsWith("{")) {
    try { return JSON.parse(text); } catch {}
  }

  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }

  return null;
}

// ── Call OpenRouter ───────────────────────────────────────────────────────────
async function callGemini(prompt, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 2048,
          temperature: attempt === 0 ? 0.85 : 0.5,
        }),
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error?.message || `API error ${response.status}`);
      }

      const data    = await response.json();
      const rawText = data?.choices?.[0]?.message?.content || "";

      if (!rawText) {
        if (attempt < retries) continue;
        throw new Error("Empty response from AI. Please try again.");
      }

      const parsed = extractJSON(rawText);
      if (!parsed || !Array.isArray(parsed.hooks) || parsed.hooks.length === 0) {
        if (attempt < retries) continue;
        throw new Error("AI response was not valid JSON. Please try again.");
      }

      return parsed;

    } catch (err) {
      clearTimeout(timeout);
      if (err.name === "AbortError") throw new Error("Request timed out. Try again.");
      if (attempt < retries) continue;
      throw err;
    }
  }
}

// ── POST /generate ───────────────────────────────────────────────────────────
app.post("/generate", ipLimiter, antiAbuse, async (req, res) => {
  const { topic, language, style, platform } = req.body;

  if (!topic || typeof topic !== "string" || topic.trim().length < 2)
    return res.status(400).json({ error: "Topic is required (min 2 characters)." });
  if (topic.length > 500)
    return res.status(400).json({ error: "Topic is too long (max 500 characters)." });
  if (!OPENROUTER_API_KEY)
    return res.status(500).json({ error: "❌ API key not configured on server." });

  const prompt = `You are an expert short-form video content creator for ${platform}.

Topic: "${topic}"
Language: ${language}
Style: ${style}
Platform: ${platform}

Return ONLY a raw JSON object. No markdown. No explanation. No extra text.

Required format:
{
  "hooks": ["hook1","hook2","hook3","hook4","hook5","hook6","hook7","hook8","hook9","hook10"],
  "script": "full script text here",
  "caption": "caption text with #hashtags here"
}

Rules:
- Write everything in ${language}
- Exactly 10 hooks, each unique and scroll-stopping
- Script: under 90 seconds when read aloud
- Caption: include exactly 15 hashtags
- Output: ONLY the JSON object, nothing else`;

  try {
    const parsed = await callGemini(prompt);
    res.json(parsed);
  } catch (err) {
    console.error("❌ Generate error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ HookLab running → http://localhost:${PORT}`);
  console.log(`🔑 OpenRouter key: ${OPENROUTER_API_KEY ? "✓ configured" : "⚠️  NOT SET"}`);
  console.log(`🗄️  Supabase:      ${SUPABASE_URL       ? "✓ configured" : "⚠️  NOT SET"}`);
});
