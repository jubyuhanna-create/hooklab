# ⚡ HookLab — تعليمات التشغيل

## 🔑 الخطوة 1: احصل على Gemini API Key (مجاني)

1. افتح: https://aistudio.google.com/app/apikey
2. سجّل دخول بـ Google Account
3. اضغط **"Create API Key"**
4. انسخ المفتاح

## ✏️ الخطوة 2: ضع المفتاح في server.js

افتح ملف `server.js` وابحث عن هذا السطر:

```javascript
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY_HERE";
```

واستبدله بمفتاحك:

```javascript
const GEMINI_API_KEY = "AIzaSy...مفتاحك هنا...";
```

## 🚀 الخطوة 3: شغّل المشروع

افتح Terminal في مجلد المشروع:

```bash
npm install
npm start
```

افتح المتصفح على: **http://localhost:3000**

## ✅ انتهى! المشروع يعمل

---

## 🔧 ملاحظات

- **Supabase** (اختياري): للـ Authentication وتتبع الاستخدام.
  ضع بيانات Supabase في `app.js` في متغير `CONFIG`
  
- **بدون Supabase**: المشروع يعمل عادي بدون تسجيل دخول، والاستخدام يُحفظ في localStorage

- **وضع Demo**: إذا لم يكن المفتاح صالحاً، الموقع يعمل ببيانات تجريبية تلقائياً
