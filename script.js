/* ═══════════════════════════════════════════════════
   Hotel Feedback Collector — script.js
   ═══════════════════════════════════════════════════ */

// ── Config ──────────────────────────────────────────
const WEBHOOK_URL = "https://hook.make.com/REPLACE_WITH_YOUR_WEBHOOK";
const GOOGLE_REVIEW_URL = "https://g.page/r/REPLACE_WITH_YOUR_GOOGLE_PLACE_ID/review"; // replace

// ── Hotel ID from URL ────────────────────────────────
const hotelID = new URLSearchParams(window.location.search).get("hotel") || "unknown";

// ── State ────────────────────────────────────────────
let currentLang = "he";
let selectedRating = 0;

// ── Translations ─────────────────────────────────────
const T = {
  he: {
    dir: "rtl",
    htmlLang: "he",
    ratingQuestion: "איך הייתה החוויה שלך במלון?",
    ratingHint: "בחר דירוג",
    ratingHintFilled: (n) => ["", "גרוע 😟", "לא טוב 😕", "בינוני 😐", "טוב 🙂", "מצוין! 🤩"][n],
    highTitle: "שמחים שנהניתם 🙌",
    highTextarea: "הוסף הערה (אופציונלי)",
    highGoogle: "שתפו ביקורת בגוגל ⭐",
    highSend: "שלח משוב למלון",
    lowTitle: "נרצה להשתפר 🙏",
    lowTextarea: "ספר לנו מה השתבש",
    lowSend: "שלח משוב למלון",
    lowGoogle: "שתפו בגוגל",
    thanksTitle: "תודה על המשוב שלך 🙌",
    thanksSub: "זה עוזר לנו להשתפר",
    sending: "שולח...",
  },
  ar: {
    dir: "rtl",
    htmlLang: "ar",
    ratingQuestion: "كيف كانت تجربتك في الفندق؟",
    ratingHint: "اختر تقييمًا",
    ratingHintFilled: (n) => ["", "سيء 😟", "ليس جيدًا 😕", "مقبول 😐", "جيد 🙂", "ممتاز! 🤩"][n],
    highTitle: "يسعدنا أنك استمتعت 🙌",
    highTextarea: "أضف ملاحظة (اختياري)",
    highGoogle: "شارك تقييمك على Google ⭐",
    highSend: "أرسل ملاحظاتك للفندق",
    lowTitle: "نريد التحسّن 🙏",
    lowTextarea: "أخبرنا بما حدث",
    lowSend: "أرسل ملاحظاتك للفندق",
    lowGoogle: "شارك على Google",
    thanksTitle: "شكرًا على ملاحظاتك 🙌",
    thanksSub: "هذا يساعدنا على التحسّن",
    sending: "جارٍ الإرسال...",
  },
  en: {
    dir: "ltr",
    htmlLang: "en",
    ratingQuestion: "How was your stay at the hotel?",
    ratingHint: "Select a rating",
    ratingHintFilled: (n) => ["", "Poor 😟", "Not good 😕", "Average 😐", "Good 🙂", "Excellent! 🤩"][n],
    highTitle: "We're happy you enjoyed your stay 🙌",
    highTextarea: "Add a note (optional)",
    highGoogle: "Share your review on Google ⭐",
    highSend: "Send feedback to hotel",
    lowTitle: "We want to improve 🙏",
    lowTextarea: "Tell us what went wrong",
    lowSend: "Send feedback to hotel",
    lowGoogle: "Share on Google",
    thanksTitle: "Thank you for your feedback 🙌",
    thanksSub: "This helps us improve",
    sending: "Sending...",
  },
};

// ── DOM refs ─────────────────────────────────────────
const stars         = document.querySelectorAll(".star");
const starsWrapper  = document.getElementById("starsWrapper");
const ratingHint    = document.getElementById("ratingHint");
const ratingQ       = document.getElementById("ratingQuestion");
const feedbackMsg   = document.getElementById("feedbackMessage");
const commentBox    = document.getElementById("commentBox");
const btnGroup      = document.getElementById("btnGroup");
const loadingState  = document.getElementById("loadingState");
const loadingText   = document.getElementById("loadingText");
const thanksTitle   = document.getElementById("thanksMessage");
const thanksSub     = document.getElementById("thanksSub");
const langBtns      = document.querySelectorAll(".lang-btn");

// ── Language ─────────────────────────────────────────
function setLang(lang) {
  currentLang = lang;
  const t = T[lang];
  document.documentElement.lang = t.htmlLang;
  document.documentElement.dir  = t.dir;

  langBtns.forEach(b => b.classList.toggle("active", b.dataset.lang === lang));

  ratingQ.textContent = t.ratingQuestion;
  ratingHint.textContent = selectedRating ? t.ratingHintFilled(selectedRating) : t.ratingHint;
  thanksTitle.textContent = t.thanksTitle;
  thanksSub.textContent   = t.thanksSub;
  loadingText.textContent = t.sending;

  // Update feedback screen if visible
  if (selectedRating) {
    buildFeedbackScreen(selectedRating);
  }

  // Update star hint
  if (selectedRating) {
    ratingHint.textContent = t.ratingHintFilled(selectedRating);
  }
}

langBtns.forEach(btn => {
  btn.addEventListener("click", () => setLang(btn.dataset.lang));
});

// ── Stars interaction ─────────────────────────────────
function paintStars(value) {
  stars.forEach(s => {
    const v = parseInt(s.dataset.value);
    s.classList.toggle("lit", v <= value);
    s.classList.remove("selected");
  });
}

function resetStarHover() {
  stars.forEach(s => s.classList.remove("lit"));
  if (selectedRating) paintStars(selectedRating);
}

stars.forEach(star => {
  const val = parseInt(star.dataset.value);

  star.addEventListener("mouseenter", () => {
    if (!starsWrapper.classList.contains("locked")) paintStars(val);
  });

  star.addEventListener("mouseleave", resetStarHover);

  star.addEventListener("click", () => {
    selectedRating = val;
    starsWrapper.classList.add("locked");

    // Animate all lit stars
    stars.forEach(s => {
      if (parseInt(s.dataset.value) <= val) {
        s.classList.add("bouncing");
        setTimeout(() => s.classList.remove("bouncing"), 500);
      }
    });

    paintStars(val);
    ratingHint.textContent = T[currentLang].ratingHintFilled(val);

    // Transition after brief pause
    setTimeout(() => goTo("feedback"), 600);
  });

  // Touch support
  star.addEventListener("touchstart", (e) => {
    e.preventDefault();
    paintStars(val);
  }, { passive: false });

  star.addEventListener("touchend", (e) => {
    e.preventDefault();
    star.click();
  }, { passive: false });
});

// ── Build Feedback Screen ────────────────────────────
function buildFeedbackScreen(rating) {
  const t = T[currentLang];
  const isHigh = rating >= 4;

  feedbackMsg.textContent = isHigh ? t.highTitle : t.lowTitle;
  commentBox.placeholder  = isHigh ? t.highTextarea : t.lowTextarea;

  btnGroup.innerHTML = "";

  if (isHigh) {
    // Hero Google button
    const gBtn = makeBtn(t.highGoogle, "btn-google-hero", () => openGoogle());
    // Secondary: send to hotel
    const sBtn = makeBtn(t.highSend, "btn-secondary", handleSend);
    btnGroup.appendChild(gBtn);
    btnGroup.appendChild(sBtn);
  } else {
    // Primary: send to hotel
    const sBtn = makeBtn(t.lowSend, "btn-primary", handleSend);
    // Secondary: Google
    const gBtn = makeBtn(t.lowGoogle, "btn-google", () => openGoogle());
    btnGroup.appendChild(sBtn);
    btnGroup.appendChild(gBtn);
  }
}

function makeBtn(text, classes, onClick) {
  const b = document.createElement("button");
  b.className = "btn " + classes;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function openGoogle() {
  window.open(GOOGLE_REVIEW_URL, "_blank", "noopener");
}

// ── Send Data ────────────────────────────────────────
async function handleSend() {
  // Disable all buttons
  btnGroup.querySelectorAll(".btn").forEach(b => b.disabled = true);

  // Show loading
  btnGroup.style.display = "none";
  loadingState.style.display = "flex";
  loadingText.textContent = T[currentLang].sending;

  const payload = {
    hotel_id:  hotelID,
    rating:    selectedRating,
    comment:   commentBox.value.trim(),
    timestamp: new Date().toISOString(),
    language:  currentLang,
  };

  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      mode: "no-cors", // Make.com webhooks require this
    });
  } catch (err) {
    // Silently proceed — no-cors means we can't read the response anyway
    console.warn("Webhook error (may be fine with no-cors):", err);
  }

  // Always go to thank you
  setTimeout(() => goTo("thanks"), 400);
}

// ── Screen Transitions ───────────────────────────────
function goTo(screenName) {
  const current = document.querySelector(".screen.active");
  const next    = document.getElementById("screen-" + screenName);

  if (!next || current === next) return;

  if (screenName === "feedback") {
    buildFeedbackScreen(selectedRating);
    loadingState.style.display = "none";
    btnGroup.style.display = "flex";
  }

  current.classList.add("exit");
  setTimeout(() => {
    current.classList.remove("active", "exit");
    next.classList.add("active");
  }, 280);
}

// ── Init ─────────────────────────────────────────────
setLang("he");
