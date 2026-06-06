/**
 * HookLab — Backend Server v3
 * حماية كاملة: لازم تسجيل دخول للـ generate + rate limiting + anti-abuse
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = process.env.PORT || 3001;

app.set("trust proxy", 1);
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Supabase ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FREE_LIMIT = 5;

// ── في الذاكرة: cooldown + IP tracking ──
const cooldowns   = new Map(); // userId → timestamp
const ipRequests  = new Map(); // IP → { count, date }
const COOLDOWN_MS = 8000;      // 8 ثوانٍ بين كل generate
const IP_MAX      = 30;        // أقصى عدد generate لكل IP باليوم

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

// ── تحقق من الـ token وأرجع المستخدم ──
async function getUserFromToken(req) {
  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch { return null; }
}

// ── usage helpers ──
async function getOrCreateUsage(userId) {
  const today = todayStr();
  let { data, error } = await supabase
    .from("usage").select("*").eq("user_id", userId).eq("date", today).single();
  if (error && error.code === "PGRST116") {
    const ins = await supabase
      .from("usage").insert({ user_id: userId, count: 0, date: today }).select().single();
    data = ins.data; error = ins.error;
  }
  if (error) throw new Error("Usage DB error: " + error.message);
  return data;
}

async function incrementUsageDB(userId) {
  try {
    await supabase.rpc("increment_usage", { p_user_id: userId, p_date: todayStr() });
  } catch (e) { console.error("increment_usage error:", e.message); }
}

// ── IP rate limiter (بدون مكتبة خارجية) ──
function checkIPLimit(req) {
  const ip    = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const today = todayStr();
  const entry = ipRequests.get(ip);

  if (!entry || entry.date !== today) {
    ipRequests.set(ip, { count: 1, date: today });
    return true;
  }
  if (entry.count >= IP_MAX) return false;
  entry.count++;
  return true;
}

// ── Prompt builder ──
function buildPrompt(topic, language, style, platform) {
  return `You are an expert viral content creator for ${platform || "TikTok"}.

Generate content for the following:
Topic: ${topic}
Language: ${language || "English"}
Style: ${style || "Funny"}
Platform: ${platform || "TikTok"}

STRICT RULES:
- Write EVERYTHING in ${language || "English"} language
- Hooks must be 1-2 sentences, punchy, scroll-stopping, high curiosity
- Script must be conversational, natural, max 90 seconds when spoken aloud
- Caption must include 15-20 relevant hashtags
- Match the "${style}" tone throughout ALL content
- Output ONLY raw valid JSON — no markdown fences, no commentary

OUTPUT FORMAT (valid JSON only):
{
  "hooks": ["Hook 1","Hook 2","Hook 3","Hook 4","Hook 5","Hook 6","Hook 7","Hook 8","Hook 9","Hook 10"],
  "script": "Full script text here...",
  "caption": "Caption text with emojis and hashtags here..."
}`;
}

function parseResponse(raw) {
  let text = raw.trim()
    .replace(/^```json\s*/im, "").replace(/```\s*$/im, "").trim()
    .replace(/^```\s*/im, "").replace(/```\s*$/im, "").trim();
  try { return validate(JSON.parse(text)); } catch (_) {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { return validate(JSON.parse(match[0])); } catch (_) {} }
  throw new Error("AI returned unparseable content. Please try again.");
}

function validate(obj) {
  if (!Array.isArray(obj.hooks) || obj.hooks.length === 0) throw new Error("Missing hooks");
  if (typeof obj.script  !== "string" || !obj.script.trim())  throw new Error("Missing script");
  if (typeof obj.caption !== "string" || !obj.caption.trim()) throw new Error("Missing caption");
  return {
    hooks:   obj.hooks.map(h => String(h).trim()).filter(Boolean),
    script:  obj.script.trim(),
    caption: obj.caption.trim(),
  };
}

// ════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════

app.get("/health", (_, res) => res.json({ status: "ok", version: "3.0.0" }));

// ── POST /generate ── محمي بالكامل ──
app.post("/generate", async (req, res) => {
  const { topic, language, style, platform } = req.body;

  // 1. تحقق من الـ topic
  if (!topic || !topic.trim() || topic.trim().length < 2)
    return res.status(400).json({ error: "Topic is required (min 2 chars)." });
  if (topic.length > 500)
    return res.status(400).json({ error: "Topic too long (max 500 chars)." });

  // 2. لازم يكون مسجل دخول
  const user = await getUserFromToken(req);
  if (!user) {
    return res.status(401).json({
      error: "Please sign in to generate content.",
      code: "AUTH_REQUIRED"
    });
  }

  // 3. IP rate limit
  if (!checkIPLimit(req)) {
    return res.status(429).json({ error: "Too many requests from your network. Try again tomorrow." });
  }

  // 4. Cooldown بين الـ generates
  const now     = Date.now();
  const lastReq = cooldowns.get(user.id) || 0;
  const elapsed = now - lastReq;
  if (elapsed < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    return res.status(429).json({ error: `Please wait ${wait}s before generating again.` });
  }

  // 5. تحقق إذا Pro أو Free limit
  try {
    const { data: userRow } = await supabase
      .from("users").select("is_pro, pro_expires_at").eq("id", user.id).single();

    const isPro = userRow?.is_pro === true &&
      userRow?.pro_expires_at &&
      new Date(userRow.pro_expires_at) > new Date();

    if (!isPro) {
      const usage = await getOrCreateUsage(user.id);
      if (usage.count >= FREE_LIMIT) {
        return res.status(429).json({
          error: "Daily limit reached. Upgrade to Pro for unlimited generations.",
          code: "LIMIT_REACHED",
          limit: FREE_LIMIT,
          used: usage.count,
        });
      }
    }
  } catch (e) {
    console.error("Usage check error:", e.message);
    // لا توقف الـ generation بسبب DB error
  }

  // 6. سجّل الـ cooldown
  cooldowns.set(user.id, now);

  // 7. استدعِ OpenRouter
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://hooklab-3gzt.onrender.com",
        "X-Title": "HookLab",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: buildPrompt(topic.trim(), language, style, platform) }],
        temperature: 0.9,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenRouter error ${response.status}`);
    }

    const data    = await response.json();
    const rawText = data.choices?.[0]?.message?.content;
    if (!rawText) throw new Error("Empty response from AI.");
    const parsed = parseResponse(rawText);

    // زد الـ usage بعد نجاح الـ generate
    await incrementUsageDB(user.id);

    return res.json(parsed);

  } catch (err) {
    console.error("Generate error:", err.message);
    return res.status(500).json({ error: err.message || "Generation failed. Try again." });
  }
});

// ── GET /usage ──
app.get("/usage", async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: "Not authenticated." });
  try {
    const usage = await getOrCreateUsage(user.id);
    return res.json({
      count: usage.count,
      limit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - usage.count),
      date: usage.date,
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── POST /webhook/gumroad ── لما حدا يدفع يصير Pro ──
app.post("/webhook/gumroad", express.urlencoded({ extended: true }), async (req, res) => {
  const email = req.body?.email;
  if (!email) return res.status(400).json({ error: "No email." });

  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 1);

  const { error } = await supabase
    .from("users")
    .update({ is_pro: true, pro_expires_at: expiresAt.toISOString() })
    .eq("email", email);

  if (error) return res.status(500).json({ error: "DB update failed." });
  console.log(`✅ Pro activated: ${email}`);
  return res.json({ success: true });
});

// ── Fallback ──
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n⚡ HookLab running on http://localhost:${PORT}`);
  console.log(`🔑 OpenRouter: ${process.env.OPENROUTER_API_KEY ? "✓" : "⚠️ NOT SET"}`);
  console.log(`🗄️  Supabase:  ${process.env.SUPABASE_URL ? "✓" : "⚠️ NOT SET"}\n`);
});
