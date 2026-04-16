import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ====================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// ====================================================

const GEMINI_MODEL = "gemini-2.5-flash";

// ── Helper: استخرج JSON من أي نص ──────────────────
function extractJSON(raw) {
  if (!raw) return null;

  let text = raw.trim();

  // شيل markdown fences بكل أشكالها
  text = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // لو بيبدأ بـ { مباشرة — زبط
  if (text.startsWith("{")) {
    try { return JSON.parse(text); } catch {}
  }

  // دور على أول { وآخر } واستخرج بينهم
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }

  // محاولة أخيرة: دور على JSON array داخل النص
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

// ── Helper: Call Gemini مع retry ──────────────────
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

// ── Route: /generate ──────────────────────────────
app.post("/generate", async (req, res) => {
  const { topic, language, style, platform } = req.body;

  if (!topic) return res.status(400).json({ error: "Topic is required" });

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
});