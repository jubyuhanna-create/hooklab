/**
 * HookLab — Backend Server
 * Node.js + Express + Gemini API + Supabase
 * 
 * Endpoints:
 *   POST /generate        → call Gemini, return hooks/script/caption
 *   POST /auth/signup     → Supabase sign up
 *   POST /auth/login      → Supabase login
 *   POST /auth/logout     → Supabase logout
 *   GET  /usage           → get today's usage count for user
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient }       = require("@supabase/supabase-js");

/* ─────────────────────────────────────────────
   INIT
───────────────────────────────────────────── */
const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));          // tighten in production
app.use(express.json());

// Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Supabase (service role key — never exposed to frontend)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY   // service role gives full DB access server-side
);

const FREE_LIMIT = 5;

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */

/** Today's date as YYYY-MM-DD */
function todayStr() {
  return new Date().toISOString().split("T")[0];
}

/** Verify Supabase JWT and return user or null */
async function getUserFromToken(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch {
    return null;
  }
}

/** Get today's usage row for user_id, creating it if missing */
async function getOrCreateUsage(userId) {
  const today = todayStr();

  // Try to find existing row
  let { data, error } = await supabase
    .from("usage")
    .select("*")
    .eq("user_id", userId)
    .eq("date", today)
    .single();

  if (error && error.code === "PGRST116") {
    // Row does not exist — create it
    const ins = await supabase
      .from("usage")
      .insert({ user_id: userId, count: 0, date: today })
      .select()
      .single();
    data  = ins.data;
    error = ins.error;
  }

  if (error) throw new Error("Usage DB error: " + error.message);
  return data;
}

/** Build the Gemini prompt */
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
  "hooks": [
    "Hook 1 text here",
    "Hook 2 text here",
    "Hook 3 text here",
    "Hook 4 text here",
    "Hook 5 text here",
    "Hook 6 text here",
    "Hook 7 text here",
    "Hook 8 text here",
    "Hook 9 text here",
    "Hook 10 text here"
  ],
  "script": "Full script text here — written as if being spoken to camera...",
  "caption": "Caption text with emojis and hashtags here..."
}`;
}

/** Parse raw Gemini text into { hooks, script, caption } */
function parseResponse(raw) {
  let text = raw.trim();

  // Strip markdown fences if present
  text = text.replace(/^```json\s*/im, "").replace(/```\s*$/im, "").trim();
  text = text.replace(/^```\s*/im,     "").replace(/```\s*$/im, "").trim();

  // First attempt: direct parse
  try {
    const obj = JSON.parse(text);
    return validate(obj);
  } catch (_) {}

  // Second attempt: extract first {...} block
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      return validate(obj);
    } catch (_) {}
  }

  throw new Error("Gemini returned unparseable content. Please try again.");
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

/* ─────────────────────────────────────────────
   ROUTES
───────────────────────────────────────────── */

/** Health check */
app.get("/", (req, res) => {
  res.json({ status: "HookLab API running", version: "1.0.0" });
});

/* ── POST /generate ── */
app.post("/generate", async (req, res) => {
  const { topic, language, style, platform } = req.body;

  if (!topic || !topic.trim()) {
    return res.status(400).json({ error: "Topic is required." });
  }

  /* ── Usage check (authenticated users) ── */
  const user = await getUserFromToken(req);

  if (user) {
    try {
      // Check if user is Pro → skip limit
      const { data: userRow } = await supabase
        .from("users")
        .select("is_pro")
        .eq("id", user.id)
        .single();

      const isPro = userRow?.is_pro === true;

      if (!isPro) {
        const usage = await getOrCreateUsage(user.id);
        if (usage.count >= FREE_LIMIT) {
          return res.status(429).json({
            error: "Daily limit reached. Upgrade to Pro for unlimited generations.",
            limit: FREE_LIMIT,
            used:  usage.count,
          });
        }
      }
    } catch (e) {
      console.error("Usage check error:", e.message);
    }
  }

  /* ── Call Gemini ── */
  try {
    const model  = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = buildPrompt(topic.trim(), language, style, platform);

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:     0.9,
        topK:            40,
        topP:            0.95,
        maxOutputTokens: 2048,
      },
    });

    const rawText = result.response.text();
    const parsed  = parseResponse(rawText);

    /* ── Increment usage (authenticated users) ── */
    if (user) {
      try {
        const today = todayStr();
        // Upsert with increment
        await supabase.rpc("increment_usage", { p_user_id: user.id, p_date: today });
      } catch (e) {
        console.error("Usage increment error:", e.message);
      }
    }

    return res.json(parsed);

  } catch (err) {
    console.error("Gemini error:", err.message);
    const msg = err.message.includes("API_KEY")
      ? "Invalid Gemini API key. Check your .env file."
      : err.message || "Generation failed. Try again.";
    return res.status(500).json({ error: msg });
  }
});

/* ── POST /auth/signup ── */
app.post("/auth/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,   // auto-confirm (no email needed for local dev)
  });

  if (error) return res.status(400).json({ error: error.message });

  // Also sign them in immediately
  const signIn = await supabase.auth.signInWithPassword({ email, password });
  if (signIn.error) return res.status(400).json({ error: signIn.error.message });

  // Ensure users table row
  await supabase.from("users").upsert({ id: data.user.id, email }, { onConflict: "id" });

  return res.json({
    user:         signIn.data.user,
    access_token: signIn.data.session.access_token,
    message:      "Account created and signed in.",
  });
});

/* ── POST /auth/login ── */
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });

  return res.json({
    user:         data.user,
    access_token: data.session.access_token,
  });
});

/* ── POST /auth/logout ── (client just drops the token, but we can invalidate server-side) */
app.post("/auth/logout", async (req, res) => {
  const user = await getUserFromToken(req);
  if (user) {
    await supabase.auth.admin.signOut(req.headers.authorization.slice(7));
  }
  return res.json({ message: "Logged out." });
});

/* ── POST /webhook/gumroad ── */
app.post("/webhook/gumroad", async (req, res) => {
  // Gumroad sends form-encoded data — parse it
  const email = req.body?.email || req.body?.buyer?.email;
  const permalink = req.body?.product?.permalink || req.body?.product_permalink;

  console.log("Gumroad webhook received:", { email, permalink });

  if (!email) {
    return res.status(400).json({ error: "No email in webhook payload." });
  }

  // Update user to Pro in Supabase
  const { error } = await supabase
    .from("users")
    .update({ is_pro: true })
    .eq("email", email);

  if (error) {
    console.error("Webhook DB error:", error.message);
    return res.status(500).json({ error: "DB update failed." });
  }

  console.log(`✅ Upgraded to Pro: ${email}`);
  return res.json({ success: true });
});


app.get("/usage", async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: "Not authenticated." });

  try {
    const usage = await getOrCreateUsage(user.id);
    return res.json({
      count:     usage.count,
      limit:     FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - usage.count),
      date:      usage.date,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n⚡ HookLab backend running on http://localhost:${PORT}`);
  console.log(`   POST /generate  — AI content generation`);
  console.log(`   POST /auth/signup  /auth/login  /auth/logout`);
  console.log(`   GET  /usage\n`);
});
