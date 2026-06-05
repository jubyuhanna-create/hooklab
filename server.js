/**
 * HookLab — Backend Server
 * Node.js + Express + OpenRouter + Supabase
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── تقديم الفرونتند ──
app.use(express.static(path.join(__dirname)));

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FREE_LIMIT = 5;

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

async function getUserFromToken(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch { return null; }
}

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

app.get("/health", (req, res) => {
  res.json({ status: "HookLab API running", version: "2.0.0" });
});

app.post("/generate", async (req, res) => {
  const { topic, language, style, platform } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: "Topic is required." });

  const user = await getUserFromToken(req);

  if (user) {
    try {
      const { data: userRow } = await supabase.from("users").select("is_pro").eq("id", user.id).single();
      const isPro = userRow?.is_pro === true;
      if (!isPro) {
        const usage = await getOrCreateUsage(user.id);
        if (usage.count >= FREE_LIMIT) {
          return res.status(429).json({
            error: "Daily limit reached. Upgrade to Pro for unlimited generations.",
            limit: FREE_LIMIT, used: usage.count,
          });
        }
      }
    } catch (e) { console.error("Usage check error:", e.message); }
  }

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
        model: "google/gemini-flash-1.5",
        messages: [{ role: "user", content: buildPrompt(topic.trim(), language, style, platform) }],
        temperature: 0.9,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenRouter error ${response.status}`);
    }

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content;
    if (!rawText) throw new Error("Empty response from AI.");
    const parsed = parseResponse(rawText);

    if (user) {
      try {
        await supabase.rpc("increment_usage", { p_user_id: user.id, p_date: todayStr() });
      } catch (e) { console.error("Usage increment error:", e.message); }
    }

    return res.json(parsed);

  } catch (err) {
    console.error("OpenRouter error:", err.message);
    return res.status(500).json({ error: err.message || "Generation failed. Try again." });
  }
});

app.post("/auth/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) return res.status(400).json({ error: error.message });
  const signIn = await supabase.auth.signInWithPassword({ email, password });
  if (signIn.error) return res.status(400).json({ error: signIn.error.message });
  await supabase.from("users").upsert({ id: data.user.id, email }, { onConflict: "id" });
  return res.json({ user: signIn.data.user, access_token: signIn.data.session.access_token, message: "Account created and signed in." });
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  return res.json({ user: data.user, access_token: data.session.access_token });
});

app.post("/auth/logout", async (req, res) => {
  const user = await getUserFromToken(req);
  if (user) await supabase.auth.admin.signOut(req.headers.authorization.slice(7));
  return res.json({ message: "Logged out." });
});

app.post("/webhook/gumroad", async (req, res) => {
  const email = req.body?.email || req.body?.buyer?.email;
  if (!email) return res.status(400).json({ error: "No email in webhook payload." });
  const { error } = await supabase.from("users").update({ is_pro: true }).eq("email", email);
  if (error) return res.status(500).json({ error: "DB update failed." });
  return res.json({ success: true });
});

app.get("/usage/device", async (req, res) => {
  const device_id = req.query.device_id;
  if (!device_id) return res.status(400).json({ error: "device_id required" });
  const { data } = await supabase.from("device_usage").select("count").eq("device_id", device_id).eq("date", todayStr()).maybeSingle();
  return res.json({ count: data?.count ?? 0 });
});

app.post("/usage/device", async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: "device_id required" });
  const today = todayStr();
  const { data } = await supabase.from("device_usage").select("id, count").eq("device_id", device_id).eq("date", today).maybeSingle();
  if (data) {
    await supabase.from("device_usage").update({ count: data.count + 1 }).eq("id", data.id);
  } else {
    await supabase.from("device_usage").insert({ device_id, count: 1, date: today });
  }
  return res.json({ ok: true });
});

app.get("/usage", async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: "Not authenticated." });
  try {
    const usage = await getOrCreateUsage(user.id);
    return res.json({ count: usage.count, limit: FREE_LIMIT, remaining: Math.max(0, FREE_LIMIT - usage.count), date: usage.date });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── أي رابط ثاني يرجع الـ index.html ──
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n⚡ HookLab running on http://localhost:${PORT}\n`);
});
