import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit"; // ← NEW
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Trust proxy headers (needed for accurate IP behind Render/Railway/etc.)
app.set("trust proxy", 1); // ← NEW

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ====================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// ====================================================

// ── ① Supabase config (for server-side token verification) ──────────── NEW ──
const SUPABASE_URL     = process.env.SUPABASE_URL     || "https://jkibvkgnalbxfsxwhkmq.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// ── ② In-memory abuse stores (resets on restart — use Redis for scale) ─ NEW ──
const cooldowns           = new Map(); // userId → last request timestamp
const fingerprintAccounts = new Map(); // fingerprint → Set of userIds

const COOLDOWN_MS      = 10_000; // 10 s between generates per user
const DAILY_USER_LIMIT = 5;      // matches CONFIG.FREE_LIMIT in app.js
const FP_REDUCED_LIMIT = 2;      // reduced limit when fingerprint spans >1 account

// ── ③ IP rate limiter: 20 requests/IP/day ──────────────────────────── NEW ──
const ipLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { error: "Too many requests from this IP. Try again tomorrow." },
});

// ── ④ Verify Supabase JWT and return the user object ──────────────── NEW ──
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

// ── ⑤ Anti-abuse middleware ────────────────────────────────────────── NEW ──
async function antiAbuse(req, res, next) {
  const { token, fingerprint } = req.body;

  // — Validate inputs ——————————————————————————————————————————
  if (!token)       return res.status(401).json({ error: "Authentication required." });
  if (!fingerprint || fingerprint.length < 6)
                    return res.status(400).json({ error: "Invalid request signature." });

  // — Verify identity via Supabase ——————————————————————————————
  const user = await verifyToken(token);
  if (!user)        return res.status(401).json({ error: "Session expired. Please sign in again." });

  const userId = user.id;
  const now    = Date.now();

  // — Cooldown: 10 s between requests per user ——————————————————
  const lastReq = cooldowns.get(userId) || 0;
  const elapsed = now - lastReq;
  if (elapsed < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    return res.status(429).json({ error: `Please wait ${wait}s before generating again.` });
  }

  // — Fingerprint cross-account detection ———————————————————————
  // Track which userIds share the same device fingerprint
  const accounts = fingerprintAccounts.get(fingerprint) ?? new Set();
  accounts.add(userId);
  fingerprintAccounts.set(fingerprint, accounts);

  // If the fingerprint is linked to >1 account, cut their daily limit in half
  const effectiveLimit = accounts.size > 1 ? FP_REDUCED_LIMIT : DAILY_USER_LIMIT;

  // — Server-side usage check via Supabase ——————————————————————
  // Mirrors the client check — prevents direct API abuse
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
    } catch { /* non-fatal — fall through */ }
  }

  if (serverUsage >= effectiveLimit) {
    const msg = accounts.size > 1
      ? "Multiple accounts detected on this device. Daily limit reduced."
      : "Daily generation limit reached. Resets in 24 hours.";
    return res.status(429).json({ error: msg });
  }

  // — All checks passed — update cooldown and attach userId for route ─
  cooldowns.set(userId, now);
  req.verifiedUserId = userId; // available downstream if needed

  next();
}

const GEMINI_MODEL = "gemini-2.5-flash";

// ── Helper: extract JSON from any text ───────────────────────────────────────
function extractJSON(raw) {
  if (!raw) return null;

  let text = raw.trim();

  text = text
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

  const arrStart = text.indexOf("[");
  if (arrStart !== -1) {
    const arrEnd = text.lastIndexOf("]");
    if (arrEnd > arrStart) {
      try {
        const arr = JSON.parse(text.slice(arrStart, arrEnd + 1));
        if (Array.isArray(arr)) return { hooks: arr, script: "", caption: "" };
      } catch {}
    }
  }

  return null;
}

// ── Helper: call Gemini with retry ───────────────────────────────────────────
async function callGemini(prompt, retries = 2) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: attempt === 0 ? 0.85 : 0.5,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 2048,
            responseMimeType: "application/json",
          },
        }),
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error?.message || `Gemini API error ${response.status}`);
      }

      const data = await response.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

      if (!rawText) {
        if (attempt < retries) { console.log(`Attempt ${attempt + 1}: empty response, retrying...`); continue; }
        throw new Error("Gemini returned empty response.");
      }

      const parsed = extractJSON(rawText);

      if (!parsed || !Array.isArray(parsed.hooks) || parsed.hooks.length === 0) {
        console.error(`Attempt ${attempt + 1}: bad JSON →`, rawText.substring(0, 300));
        if (attempt < retries) { console.log("Retrying..."); continue; }
        throw new Error("AI response was not valid JSON. Please try again.");
      }

      return parsed;

    } catch (err) {
      clearTimeout(timeout);
      if (err.name === "AbortError") throw new Error("Request timed out. Try again.");
      if (attempt < retries && !err.message.includes("API error")) {
        console.log(`Attempt ${attempt + 1} failed (${err.message}), retrying...`);
        continue;
      }
      throw err;
    }
  }
}

// ── Route: /generate — now protected by IP limiter + anti-abuse ──────────────
//   CHANGED: added ipLimiter and antiAbuse middleware ← only change to this route
app.post("/generate", ipLimiter, antiAbuse, async (req, res) => {
  const { topic, language, style, platform } = req.body;

  // Validate required inputs
  if (!topic || typeof topic !== "string" || topic.trim().length < 2)
    return res.status(400).json({ error: "Topic is required (min 2 characters)." });
  if (topic.length > 500)
    return res.status(400).json({ error: "Topic is too long (max 500 characters)." });

  if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE") {
    return res.status(500).json({ error: "❌ Gemini API key not set in .env file" });
  }

  const prompt = `You are an expert short-form video content creator for ${platform}.

Topic: "${topic}"
Language: ${language}
Style: ${style}
Platform: ${platform}

Return ONLY a raw JSON object. No markdown. No explanation. No extra text. Just the JSON.

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
- Output: ONLY the JSON object above, nothing else`;

  try {
    const parsed = await callGemini(prompt);
    res.json(parsed);
  } catch (err) {
    console.error("❌ Generate error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ HookLab running → http://localhost:${PORT}`);
  console.log(`🔑 Gemini API key: ${GEMINI_API_KEY ? "configured ✓" : "⚠️  NOT SET - add to .env file"}`);
  console.log(`🛡️  Anti-abuse: IP limit 20/day | Cooldown ${COOLDOWN_MS/1000}s | Fingerprint tracking active`);
});
