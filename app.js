/* ═══════════════════════════════════════════════════════════════
   HOOKLAB — app.js v3
   ✅ لازم تسجيل دخول قبل الـ generate
   ✅ يحفظ الـ topic بعد Sign In ويكمل تلقائياً
   ✅ حماية من الـ abuse
═══════════════════════════════════════════════════════════════ */

const CONFIG = {
  SUPABASE_URL: "https://jkibvkgnalbxfsxwhkmq.supabase.co",
  SUPABASE_KEY: "sb_publishable_xO4ovopvXq_AEFbSB-au1A_CKRmfGAN",
  BACKEND_URL:  "https://hooklab-3gzt.onrender.com",
  FREE_LIMIT:   5,
};

let supabaseClient = null;
let currentUser    = null;
let authMode       = "signin";
let pendingGenerate = false; // عشان نكمل الـ generate بعد الـ sign in

// ═══════════════ SUPABASE INIT ═══════════════
function initSupabase() {
  try {
    supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_IN" && session?.user) {
        await setUser(session.user);
        // لو كان عم يحاول يعمل generate قبل ما يسجل → كمّل تلقائياً
        if (pendingGenerate) {
          pendingGenerate = false;
          closeModal("auth-modal");
          setTimeout(() => handleGenerate(), 300);
        }
      } else if (event === "SIGNED_OUT") {
        clearUser();
      }
    });
    checkSession();
  } catch (e) {
    console.error("Supabase error:", e);
  }
}

async function checkSession() {
  if (!supabaseClient) return;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session?.user) await setUser(session.user);
    else refreshUsageBadge();
  } catch (e) { refreshUsageBadge(); }
}

// ═══════════════ GOOGLE SIGN IN ═══════════════
async function signInWithGoogle() {
  if (!supabaseClient) { showToast("❌ Auth not ready."); return; }
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) showToast("❌ " + error.message);
  } catch (e) { showToast("❌ " + e.message); }
}

// ═══════════════ USER STATE ═══════════════
async function setUser(user) {
  currentUser = user;
  const btn = document.getElementById("auth-btn");
  if (btn) {
    const name = user.user_metadata?.name || user.email?.split("@")[0] || "User";
    btn.textContent = `👤 ${name}`;
    btn.onclick = showUserMenu;
  }
  await ensureUserRecord(user);
  await refreshUsageBadge();
}

function clearUser() {
  currentUser = null;
  const btn = document.getElementById("auth-btn");
  if (btn) { btn.textContent = "Sign In"; btn.onclick = () => openAuthModal("signin"); }
  refreshUsageBadge();
}

async function signOut() {
  if (supabaseClient) await supabaseClient.auth.signOut();
  clearUser();
  showToast("👋 Signed out");
}

function showUserMenu() {
  let existing = document.getElementById("user-dropdown");
  if (existing) { existing.remove(); return; }
  const name  = currentUser?.user_metadata?.name || currentUser?.email?.split("@")[0] || "User";
  const email = currentUser?.email || "";
  const menu  = document.createElement("div");
  menu.id = "user-dropdown";
  menu.style.cssText = "position:fixed;top:62px;right:20px;background:#18181f;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:16px;z-index:500;min-width:200px;box-shadow:0 8px 40px rgba(0,0,0,0.5)";
  menu.innerHTML = `
    <div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.07)">
      <div style="font-weight:700;color:#f0f0f5">👤 ${name}</div>
      <div style="font-size:12px;color:#7a7a94;margin-top:2px">${email}</div>
    </div>
    <button onclick="window.open('https://jubyanna.gumroad.com/l/HOOKLAB','_blank');document.getElementById('user-dropdown')?.remove()" style="width:100%;text-align:left;background:none;border:none;color:#f5c842;padding:8px 0;cursor:pointer;font-size:14px">✦ Upgrade to Pro</button>
    <button onclick="signOut();document.getElementById('user-dropdown')?.remove()" style="width:100%;text-align:left;background:none;border:none;color:#7a7a94;padding:8px 0;cursor:pointer;font-size:14px">↩ Sign Out</button>
  `;
  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener("click", function close(e) {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("click", close); }
    });
  }, 100);
}

// ═══════════════ AUTH MODAL ═══════════════
function openAuthModal(mode = "signin") {
  authMode = mode;
  updateAuthModalUI();
  openModal("auth-modal");
}

function toggleAuth() { openAuthModal("signin"); }

function updateAuthModalUI() {
  const isSignup = authMode === "signup";
  const titleEl  = document.getElementById("auth-title");
  const subEl    = document.getElementById("auth-sub");
  if (titleEl) titleEl.textContent = isSignup ? "🚀 Join HookLab Free" : "👋 Welcome Back";
  if (subEl)   subEl.textContent   = isSignup
    ? "Create your free account — 5 generations/day included."
    : "Sign in to generate content.";

  let nameField   = document.getElementById("auth-name-field");
  const emailField = document.getElementById("auth-email")?.parentElement;
  if (isSignup && !nameField && emailField) {
    nameField = document.createElement("div");
    nameField.id = "auth-name-field";
    nameField.className = "field-group";
    nameField.innerHTML = '<label>Your Name</label><input type="text" id="auth-name" placeholder="e.g. Ahmad" />';
    emailField.parentElement.insertBefore(nameField, emailField);
  } else if (!isSignup && nameField) {
    nameField.remove();
  }

  const btn = document.querySelector("#auth-modal .btn-generate");
  if (btn) btn.textContent = isSignup ? "🚀 Create Free Account" : "→ Sign In";

  const switchEl = document.querySelector(".modal-switch");
  if (switchEl) {
    switchEl.innerHTML = isSignup
      ? `Already have an account? <a href="#" onclick="switchAuthMode()">Sign in</a>`
      : `No account? <a href="#" onclick="switchAuthMode()">Create one free →</a>`;
  }
  const errEl = document.getElementById("auth-error");
  if (errEl) errEl.classList.add("hidden");
}

function switchAuthMode() {
  authMode = authMode === "signin" ? "signup" : "signin";
  updateAuthModalUI();
}

async function submitAuth() {
  const email    = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  const name     = document.getElementById("auth-name")?.value?.trim() || "";

  const errEl = document.getElementById("auth-error");
  if (errEl) errEl.classList.add("hidden");

  if (!email || !password)                  { showAuthError("Please fill all fields."); return; }
  if (authMode === "signup" && !name)       { showAuthError("Please enter your name."); return; }
  if (password.length < 6)                  { showAuthError("Password must be at least 6 characters."); return; }
  if (!supabaseClient)                      { showAuthError("Auth service not configured."); return; }

  const btn = document.querySelector("#auth-modal .btn-generate");
  if (btn) { btn.disabled = true; btn.textContent = "Please wait..."; }

  try {
    let result;
    if (authMode === "signin") {
      result = await supabaseClient.auth.signInWithPassword({ email, password });
    } else {
      result = await supabaseClient.auth.signUp({ email, password, options: { data: { name } } });
    }
    if (result.error) throw result.error;

    const user = result.data?.user;
    if (!user || !result.data?.session) {
      closeModal("auth-modal");
      pendingGenerate = false;
      showConfirmEmailModal(name || email.split("@")[0]);
      return;
    }

    if (authMode === "signup") await ensureUserRecord(user, name);
    await setUser(user);

    // لو كان pending generate → onAuthStateChange بيكمله
    if (!pendingGenerate) {
      closeModal("auth-modal");
      showWelcomeModal(name || user.user_metadata?.name || user.email?.split("@")[0]);
    }

  } catch (e) {
    showAuthError(e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = authMode === "signin" ? "→ Sign In" : "🚀 Create Free Account";
    }
  }
}

function showAuthError(msg) {
  const el = document.getElementById("auth-error");
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}

// ═══════════════ WELCOME / CONFIRM MODALS ═══════════════
function showWelcomeModal(name) {
  let modal = document.getElementById("welcome-modal");
  if (!modal) { modal = document.createElement("div"); modal.id = "welcome-modal"; modal.className = "modal-overlay"; document.body.appendChild(modal); }
  modal.classList.remove("hidden");
  modal.innerHTML = `
    <div class="modal" style="text-align:center;max-width:440px">
      <div style="font-size:52px;margin-bottom:8px">🎉</div>
      <h2 style="font-family:'Syne',sans-serif;font-size:28px;margin-bottom:8px">Welcome, ${name}!</h2>
      <p style="color:#7a7a94;margin-bottom:24px;font-size:15px">You're all set. Start creating viral content! 🔥</p>
      <button class="btn-generate" style="width:100%;margin-bottom:10px"
        onclick="document.getElementById('welcome-modal').remove();document.body.style.overflow='';document.getElementById('topic').focus()">
        ⚡ Start Generating Now
      </button>
      <button onclick="document.getElementById('welcome-modal').remove();document.body.style.overflow='';window.open('https://jubyanna.gumroad.com/l/HOOKLAB','_blank')"
        style="background:none;border:1px solid rgba(255,255,255,0.1);color:#7a7a94;width:100%;padding:12px;border-radius:12px;cursor:pointer;font-size:14px">
        ✦ Upgrade to Pro
      </button>
    </div>
  `;
  document.body.style.overflow = "hidden";
  modal.addEventListener("click", (e) => { if (e.target === modal) { modal.remove(); document.body.style.overflow = ""; } });
}

function showConfirmEmailModal() {
  let modal = document.getElementById("welcome-modal");
  if (!modal) { modal = document.createElement("div"); modal.id = "welcome-modal"; modal.className = "modal-overlay"; document.body.appendChild(modal); }
  modal.classList.remove("hidden");
  modal.innerHTML = `
    <div class="modal" style="text-align:center;max-width:400px">
      <div style="font-size:48px;margin-bottom:16px">📧</div>
      <h2 style="font-family:'Syne',sans-serif;margin-bottom:10px">Check Your Email</h2>
      <p style="color:#7a7a94;margin-bottom:20px">We sent a confirmation link. Click it, then come back and sign in.</p>
      <button class="btn-generate" style="width:100%"
        onclick="document.getElementById('welcome-modal').remove();document.body.style.overflow='';openAuthModal('signin')">
        → Go to Sign In
      </button>
    </div>
  `;
  document.body.style.overflow = "hidden";
}

// ═══════════════ SUPABASE DB ═══════════════
async function ensureUserRecord(user, name = "") {
  if (!supabaseClient) return;
  try {
    const { data } = await supabaseClient.from("users").select("id").eq("id", user.id).maybeSingle();
    if (!data) {
      await supabaseClient.from("users").insert({
        id: user.id, email: user.email,
        name: name || user.user_metadata?.name || "",
        created_at: new Date().toISOString(),
      });
    }
  } catch (e) { console.warn("ensureUserRecord:", e.message); }
}

async function getUsageCount() {
  if (!supabaseClient || !currentUser) return 0;
  try {
    const today = new Date().toISOString().split("T")[0];
    const { data } = await supabaseClient.from("usage").select("count")
      .eq("user_id", currentUser.id).eq("date", today).maybeSingle();
    return data?.count ?? 0;
  } catch { return 0; }
}

async function refreshUsageBadge() {
  const badge     = document.getElementById("usage-badge");
  const usesLeftEl = document.getElementById("uses-left");

  if (!currentUser) {
    if (badge) badge.classList.add("hidden");
    if (usesLeftEl) usesLeftEl.textContent = CONFIG.FREE_LIMIT;
    return;
  }

  const count = await getUsageCount();
  const left  = Math.max(0, CONFIG.FREE_LIMIT - count);
  if (badge) { badge.textContent = `${left} generations left today`; badge.classList.remove("hidden"); }
  if (usesLeftEl) usesLeftEl.textContent = left;
}

// ═══════════════ GENERATE ═══════════════
async function handleGenerate() {
  const topic    = document.getElementById("topic").value.trim();
  const language = document.getElementById("language").value;
  const style    = document.getElementById("style").value;
  const platform = document.getElementById("platform").value;

  if (!topic) {
    showToast("⚠️ Please enter a topic first!");
    document.getElementById("topic").focus();
    return;
  }

  // لو مش مسجل دخول → فتح modal وحفظ الـ topic
  if (!currentUser) {
    pendingGenerate = true;
    showToast("👋 Please sign in first to generate content.");
    openAuthModal("signin");
    return;
  }

  // تحقق من الـ limit قبل الإرسال
  const usageCount = await getUsageCount();
  if (usageCount >= CONFIG.FREE_LIMIT) {
    showToast("🚫 Daily limit reached — Upgrade to Pro!");
    window.open("https://jubyanna.gumroad.com/l/HOOKLAB", "_blank");
    return;
  }

  setLoading(true);
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error("Session expired. Please sign in again.");

    const res = await fetch(`${CONFIG.BACKEND_URL}/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ topic, language, style, platform }),
    });

    const data = await res.json();

    if (!res.ok) {
      // لو الـ server رجع AUTH_REQUIRED
      if (data.code === "AUTH_REQUIRED") {
        pendingGenerate = true;
        openAuthModal("signin");
        return;
      }
      // لو وصل الـ limit
      if (data.code === "LIMIT_REACHED") {
        showToast("🚫 Daily limit reached — Upgrade to Pro!");
        window.open("https://jubyanna.gumroad.com/l/HOOKLAB", "_blank");
        return;
      }
      throw new Error(data.error || `Server error ${res.status}`);
    }

    if (!Array.isArray(data.hooks)) throw new Error("Invalid AI response. Please try again.");

    await refreshUsageBadge();
    renderOutput(data);
    scrollToOutput();

  } catch (err) {
    console.error(err);
    showToast("❌ " + err.message);
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  const btn = document.getElementById("generate-btn");
  if (!btn) return;
  btn.disabled = on;
  btn.querySelector(".btn-text").classList.toggle("hidden", on);
  btn.querySelector(".btn-loader").classList.toggle("hidden", !on);
}

// ═══════════════ RENDER ═══════════════
function renderOutput({ hooks, script, caption }) {
  document.getElementById("hooks-list").innerHTML = hooks.map((h, i) =>
    `<li><span class="hook-num">${i + 1}</span><span>${escapeHtml(h)}</span></li>`
  ).join("");
  document.getElementById("script-text").textContent = script;
  const captionEl = document.getElementById("caption-text");
  captionEl.innerHTML = escapeHtml(caption).replace(/#([\w\u0600-\u06FF]+)/g, '<span class="hashtag">#$1</span>');
  document.getElementById("output-section").classList.remove("hidden");
}

function scrollToOutput() {
  setTimeout(() => document.getElementById("output-section").scrollIntoView({ behavior: "smooth", block: "start" }), 100);
}

// ═══════════════ COPY ═══════════════
function copyHooks() {
  const items = [...document.querySelectorAll("#hooks-list li")];
  copyToClipboard(items.map((li, i) => `${i + 1}. ${li.querySelector("span:last-child").textContent}`).join("\n"), "Hooks copied! ✓");
}
function copyScript()  { copyToClipboard(document.getElementById("script-text").textContent, "Script copied! ✓"); }
function copyCaption() { copyToClipboard(document.getElementById("caption-text").textContent, "Caption copied! ✓"); }
function copyAll() {
  const hooks = [...document.querySelectorAll("#hooks-list li")].map((li, i) => `${i + 1}. ${li.querySelector("span:last-child").textContent}`).join("\n");
  copyToClipboard(`🎣 HOOKS:\n${hooks}\n\n📜 SCRIPT:\n${document.getElementById("script-text").textContent}\n\n📲 CAPTION:\n${document.getElementById("caption-text").textContent}`, "Everything copied! ✓");
}
function copyToClipboard(text, msg) {
  navigator.clipboard?.writeText(text).then(() => showToast(msg)).catch(() => fallbackCopy(text, msg)) ?? fallbackCopy(text, msg);
}
function fallbackCopy(text, msg) {
  const ta = Object.assign(document.createElement("textarea"), { value: text });
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  showToast(msg);
}

// ═══════════════ MODALS ═══════════════
function openModal(id)  { document.getElementById(id)?.classList.remove("hidden"); document.body.style.overflow = "hidden"; }
function closeModal(id) { document.getElementById(id)?.classList.add("hidden");    document.body.style.overflow = ""; }
function showUpgradeModal() { window.open("https://jubyanna.gumroad.com/l/HOOKLAB", "_blank"); }

document.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal-overlay")) {
    pendingGenerate = false;
    closeModal(e.target.id);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { pendingGenerate = false; closeModal("auth-modal"); }
  if (e.key === "Enter" && !document.getElementById("auth-modal")?.classList.contains("hidden")) submitAuth();
});

// ═══════════════ TOAST ═══════════════
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg; toast.classList.remove("hidden");
  void toast.offsetWidth; toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.classList.remove("show"); setTimeout(() => toast.classList.add("hidden"), 400); }, 3500);
}

// ═══════════════ HELPERS ═══════════════
function escapeHtml(str) {
  const d = document.createElement("div");
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}
function scrollToPricing() {
  document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" });
}

// ═══════════════ INIT ═══════════════
document.addEventListener("DOMContentLoaded", () => {
  const authBtn = document.getElementById("auth-btn");
  if (authBtn) authBtn.onclick = () => openAuthModal("signin");
  initSupabase();
  document.getElementById("topic")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleGenerate(); }
  });
});
