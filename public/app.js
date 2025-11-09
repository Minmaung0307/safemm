// app.js

import {
  db,
  auth,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  addDoc,
  setDoc,
  orderBy,
  limit,
  serverTimestamp,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "./firebase.js";

const ENTITIES = collection(db, "entities");
const REPORTS  = collection(db, "reports");
const ALERTS   = collection(db, "alerts");

// ========== HTML escape helper ==========
// Prevent HTML injection when rendering alert messages, titles, etc.
function escapeHTML(str = "") {
  return str
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* -------------------------------------------------
   PHONE NORMALIZER (MM + US)
------------------------------------------------- */

function normalizePhone(raw) {
  const orig = (raw || "").toString().trim();
  if (!orig) return { ok: false, reason: "empty", raw: orig };

  let s = orig.replace(/[^\d+]/g, "");

  if (/^\+\d{7,15}$/.test(s)) {
    return { ok: true, raw: orig, normalized: s, e164: s };
  }

  if (/^\d{7,15}$/.test(s)) {
    // Myanmar
    if (/^(09|9)\d{6,12}$/.test(s)) {
      const e164 = s.startsWith("09")
        ? "+95" + s.slice(1)
        : "+95" + s;
      return { ok: true, raw: orig, normalized: s, e164 };
    }
    // US
    if (s.length === 10) {
      return { ok: true, raw: orig, normalized: s, e164: "+1" + s };
    }
    if (s.length === 11 && s.startsWith("1")) {
      return { ok: true, raw: orig, normalized: s, e164: "+" + s };
    }
  }

  return { ok: false, reason: "invalid format", raw: orig };
}

/* -------------------------------------------------
   TYPE DETECT & NORMALIZE
------------------------------------------------- */

function detectType(input) {
  const v = (input || "").trim();
  if (!v) return "other";

  if (v.startsWith("http://") || v.startsWith("https://")) return "link";
  if (v.includes("facebook.com") || v.startsWith("@")) return "page";

  const digits = v.replace(/\D/g, "");
  if (digits.length >= 9 && digits.length <= 15) return "phone";

  if (v.toLowerCase().includes("kbz") || v.toLowerCase().includes("wave")) return "wallet";

  return "other";
}

function normalize(type, value) {
  let v = (value || "").trim();

  if (type === "phone") {
    const n = normalizePhone(v);
    return n.ok ? (n.e164 || n.normalized) : "";
  }

  if (type === "link") {
    try {
      v = new URL(v).href;
    } catch (e) {
      // ignore
    }
    return v;
  }

  return v;
}

/* -------------------------------------------------
   RISK BADGE HELPER
------------------------------------------------- */

function riskToBadge(score, isConfirmed, reportCount) {
  if (isConfirmed) {
    return `<span class="badge danger">⚠ Confirmed scam (${reportCount} reports)</span>`;
  }
  if (score >= 70) return `<span class="badge danger">⚠ High risk (${reportCount} reports)</span>`;
  if (score >= 30) return `<span class="badge warn">⚠ Some reports (${reportCount})</span>`;
  if (reportCount > 0) return `<span class="badge warn">⚠ Mixed reports (${reportCount})</span>`;
  return `<span class="badge safe">✔ No reports found (yet)</span>`;
}

/* -------------------------------------------------
   MAIN CHECK (ID / LINK / PHONE / PAGE)
------------------------------------------------- */

async function checkEntity(type, value) {
  const resBox = document.getElementById("checkResult");
  if (!resBox) return;

  resBox.textContent = "Checking…";

  const selType = type === "auto" ? detectType(value) : type;
  const normVal = normalize(selType, value);

  if (!normVal) {
    resBox.textContent = "Invalid input (not a valid link or phone).";
    return;
  }

  const qRef = query(
    ENTITIES,
    where("type", "==", selType),
    where("value", "==", normVal)
  );
  const snap = await getDocs(qRef);

  if (snap.empty) {
    resBox.innerHTML = `
      ${riskToBadge(0, false, 0)}
      <div class="muted small">
        No community reports found for
        <strong>${normVal}</strong>.
        You can help others by reporting if you experienced anything suspicious.
      </div>`;
    return;
  }

  const e = snap.docs[0].data();
  const reportsCount = e.reportsCount || e.reportCount || 0;
  const isConfirmed =
    e.confirmedScam === true ||
    e.status === "confirmed" ||
    reportsCount > 0;

  const badge = riskToBadge(e.riskScore || 0, isConfirmed, reportsCount);

  resBox.innerHTML = `
    ${badge}
    <div class="muted small">
      Type: <strong>${e.type}</strong> —
      Value: <strong>${e.value}</strong><br/>
      Reports: ${reportsCount},
      Last update: ${
        e.lastReportedAt?.toDate
          ? e.lastReportedAt.toDate().toLocaleString()
          : e.lastReportAt?.toDate
          ? e.lastReportAt.toDate().toLocaleString()
          : "N/A"
      }
    </div>`;
}

/* -------------------------------------------------
   SIMPLE RISK SCORE (for future use)
------------------------------------------------- */

function calcRiskScore(current, reportType) {
  let base = current || 0;
  if (reportType === "scam") base += 15;
  if (reportType === "spam") base += 5;
  if (reportType === "safe") base -= 10;
  if (base < 0) base = 0;
  if (base > 100) base = 100;
  return base;
}

/* -------------------------------------------------
   CONFIRMED LIST (Public) - from approved reports
------------------------------------------------- */

async function loadConfirmedList() {
  const host = document.getElementById("confirmedList");
  if (!host) return;

  host.innerHTML = `<div class="hint">Loading confirmed scam records…</div>`;

  try {
    // approved + scam reports တွေယူမယ်
    const qRef = query(
      REPORTS,
      where("status", "==", "approved"),
      where("reportType", "==", "scam"),
      orderBy("createdAt", "desc"),
      limit(200)
    );
    const snap = await getDocs(qRef);

    if (snap.empty) {
      host.innerHTML =
        `<div class="hint">No confirmed scam records yet. Submit if you find one.</div>`;
      return;
    }

    // entity နဲ့ စုပေးမယ် (phone / wallet / link တူရင် group)
    const map = new Map();

    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const key =
        d.entityKey ||
        `${d.entityType || d.type || "other"}_${d.entityValue || d.value || d.rawInput || ""}`;

      if (!key) return;

      if (!map.has(key)) {
        map.set(key, {
          type: d.entityType || d.type || "other",
          value: d.entityValue || d.value || d.rawInput || "",
          count: 0,
          regions: new Set(),
          categories: new Set(),
          last: d.createdAt || d.approvedAt || null
        });
      }

      const e = map.get(key);
      e.count++;

      if (d.region) e.regions.add(d.region);
      if (d.category) e.categories.add(d.category);

      if (d.createdAt && e.last && d.createdAt.toMillis) {
        if (d.createdAt.toMillis() > e.last.toMillis()) e.last = d.createdAt;
      } else if (d.createdAt && !e.last) {
        e.last = d.createdAt;
      }
    });

    // UI ထုတ်ပေးမယ်
    const rows = [];
    for (const [, e] of map) {
      const regions = e.regions.size
        ? Array.from(e.regions).join(", ")
        : "—";
      const cats = e.categories.size
        ? Array.from(e.categories).join(", ")
        : "—";
      const last = e.last && e.last.toDate
        ? e.last.toDate().toLocaleString()
        : "—";

      rows.push(`
        <div class="scam-card">
          <div class="scam-main">
            <div class="scam-type">${e.type.toUpperCase()}</div>
            <div class="scam-value">${e.value}</div>
          </div>
          <div class="scam-meta">
            <span class="badge danger">⚠ Confirmed by community</span>
            <span>${e.count} reports</span>
            <span>Category: ${cats}</span>
            <span>Region: ${regions}</span>
            <span class="small">Last update: ${last}</span>
          </div>
        </div>
      `);
    }

    host.innerHTML = rows.join("");
  } catch (err) {
    console.error("loadConfirmedList error", err);
    host.innerHTML =
      `<div class='error'>Failed to load confirmed scams. Please try again later.</div>`;
  }
}

/* -------------------------------------------------
   PHONE VALIDATION (ENHANCED)
------------------------------------------------- */

async function checkPhoneEnhanced(raw) {
  const val = (raw || "").toString().trim();
  if (!val) return { ok: false, reason: "empty", normalized: "" };

  try {
    const lib = window.libphonenumber || window.libphonenumberJs || {};
    const { parsePhoneNumberFromString } = lib;
    if (typeof parsePhoneNumberFromString === "function") {
      let pn = parsePhoneNumberFromString(val);

      if (!pn) {
        const digits = val.replace(/\D/g, "");
        if (/^0?9\d{7,9}$/.test(digits)) {
          pn = parsePhoneNumberFromString(digits.replace(/^0/, "+95"));
        } else if (/^\d{10}$/.test(digits)) {
          pn = parsePhoneNumberFromString("+1" + digits);
        }
      }

      if (pn && pn.isValid && pn.isValid()) {
        return {
          ok: true,
          country: pn.country || null,
          normalized: pn.number,
          national: pn.formatNational ? pn.formatNational() : (pn.nationalNumber || ""),
          type: pn.getType ? pn.getType() : null
        };
      } else {
        return {
          ok: false,
          reason: "invalid_format",
          normalized: pn ? (pn.number || "") : ""
        };
      }
    }
  } catch (e) {
    console.warn("[checkPhoneEnhanced] libphonenumber error", e);
  }

  const digits = val.replace(/\D/g, "");

  // Myanmar
  if (/^(09|959)\d{7,9}$/.test(digits) || /^9\d{7,9}$/.test(digits)) {
    let norm = digits;
    if (norm.startsWith("09")) norm = "+95" + norm.slice(1);
    else if (norm.startsWith("959")) norm = "+" + norm;
    else if (norm.startsWith("9")) norm = "+95" + norm;
    return { ok: true, country: "MM", normalized: norm, national: digits, type: "MOBILE" };
  }

  // US
  if (/^\d{10}$/.test(digits)) {
    const e164 = "+1" + digits;
    const nat = digits.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3");
    return { ok: true, country: "US", normalized: e164, national: nat, type: "MOBILE" };
  }

  const compact = val.replace(/\s|-/g, "");
  if (/^\+\d{7,15}$/.test(compact)) {
    return { ok: true, normalized: compact, country: null };
  }

  return { ok: false, reason: "unknown_format", normalized: "" };
}

window.checkPhoneEnhanced = checkPhoneEnhanced;

/* -------------------------------------------------
   SUBMIT REPORT
------------------------------------------------- */

async function submitReport(ev) {
  ev.preventDefault();
  const msg = document.getElementById("reportMsg");
  if (msg) msg.textContent = "";

  const typeSel  = document.getElementById("rType");
  const rawInput = document.getElementById("rValue");
  const category = document.getElementById("rCategory")?.value || null;
  const region   = (document.getElementById("rRegion")?.value || "").trim() || null;
  const desc     = (document.getElementById("rDesc")?.value || "").trim();

  const amountRaw = document.getElementById("rAmount")?.value ?? "";
  let amount = null;
  if (amountRaw.trim() !== "") {
    const n = Number(amountRaw);
    if (!Number.isFinite(n) || n < 0) {
      if (msg) msg.textContent = "Please enter a valid loss amount (number ≥ 0).";
      return;
    }
    amount = n;
  }

  if (!rawInput || !rawInput.value.trim()) {
    if (msg) msg.textContent = "Please enter a value to report (phone, link, account, etc.).";
    return;
  }

  let type   = typeSel ? typeSel.value : "auto";
  let rawVal = rawInput.value.trim();

  if (type === "auto") {
    type = detectType(rawVal);
  }

  let normVal = normalize(type, rawVal);

  if (type === "phone") {
    const n = normalizePhone(rawVal);
    if (!n.ok) {
      if (msg) {
        msg.textContent =
          "Invalid phone number. Use formats like 09..., +95..., US 10-digit or +1...";
      }
      return;
    }
    normVal = n.e164 || n.normalized;
  }

  if (!normVal) {
    if (msg) msg.textContent = "Invalid or unsupported value. Please check and try again.";
    return;
  }

  const safeKeyVal = normVal.replace(/[.#$/[\]]/g, "_");
  const entityKey  = `${type}_${safeKeyVal}`;

  try {
    await addDoc(REPORTS, {
      entityKey,
      entityType: type,
      entityValue: normVal,
      rawInput: rawVal,
      reportType: "scam",
      category,
      region,
      description: desc || null,
      amount,
      status: "pending",
      createdAt: serverTimestamp()
    });

    if (msg) {
      msg.textContent = "✅ Report submitted. Thank you for helping protect others.";
    }

    ev.target.reset();
  } catch (err) {
    console.error("submitReport error", err);
    if (msg) msg.textContent = "❌ Failed to submit. Please try again.";
  }
}

/* -------------------------------------------------
   LOAD ALERTS
------------------------------------------------- */

async function loadAlerts() {
  const host = document.getElementById("alerts");
  if (!host) return;

  host.innerHTML = `<div class="hint">Loading alerts…</div>`;

  try {
    const ref = collection(db, "alerts");
    const qRef = query(
      ref,
      where("active", "==", true),
      orderBy("createdAt", "desc"),
      limit(10)
    );
    const snap = await getDocs(qRef);

    if (snap.empty) {
      host.innerHTML = `<div class="hint">No alerts yet.</div>`;
      return;
    }

    const out = [];
    snap.forEach((d) => {
      const a = d.data();
      const sev = (a.severity || "info").toLowerCase();

      const rawUrl = (a.url || "").trim();
      const isExternal =
        rawUrl.startsWith("http://") || rawUrl.startsWith("https://");

      const linkHtml = isExternal
        ? `<a href="${rawUrl}"
              target="_blank"
              rel="noopener noreferrer"
              class="alert-link">View details</a>`
        : "";

      out.push(`
        <div class="alert-item alert-${sev}">
          <div class="alert-title">
            <span class="alert-label warning">Warning</span>
            ${escapeHTML(a.title || "Alert")}
            <span class="alert-label info">ℹ Info</span>
          </div>
          <div class="alert-body">
            ${escapeHTML(a.message || "")}
          </div>
          ${linkHtml}
        </div>
      `);
    });

    host.innerHTML = out.join("");
  } catch (err) {
    console.error("Alerts load error", err);
    host.innerHTML = `<div class="error">Failed to load alerts.</div>`;
  }
}

/* -------------------------------------------------
   AUTH UI
------------------------------------------------- */

function setupAuthUI() {
  const dlg       = document.getElementById("authDialog");
  const form      = document.getElementById("authForm");
  const btnLogin  = document.getElementById("btnLogin");
  const btnLogout = document.getElementById("btnLogout");
  const btnCancel = document.getElementById("authCancel");
  const errBox    = document.getElementById("authError");

  if (!btnLogin || !btnLogout || !dlg || !form) return;

  btnLogin.addEventListener("click", () => {
    if (errBox) errBox.textContent = "";
    if (typeof dlg.showModal === "function") dlg.showModal();
  });

  btnLogout.addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch (e) {
      console.error(e);
    }
  });

  if (btnCancel) {
    btnCancel.addEventListener("click", () => dlg.close());
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (errBox) errBox.textContent = "";
    const email = document.getElementById("authEmail").value.trim();
    const pw    = document.getElementById("authPassword").value;
    if (!email || !pw) {
      if (errBox) errBox.textContent = "Email / password required.";
      return;
    }
    try {
      await signInWithEmailAndPassword(auth, email, pw);
      dlg.close();
    } catch (err) {
      console.error(err);
      if (errBox) errBox.textContent = "Login failed. Check credentials.";
    }
  });

  onAuthStateChanged(auth, (user) => {
    if (user) {
      btnLogin.classList.add("hidden");
      btnLogout.classList.remove("hidden");
    } else {
      btnLogin.classList.remove("hidden");
      btnLogout.classList.add("hidden");
    }
  });
}

/* -------------------------------------------------
   BOOTSTRAP
------------------------------------------------- */

window.addEventListener("DOMContentLoaded", () => {
  const checkForm = document.getElementById("checkForm");
  if (checkForm) {
    checkForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const type  = document.getElementById("checkType").value;
      const value = document.getElementById("checkValue").value;
      checkEntity(type, value).catch((err) => {
        console.error(err);
        const box = document.getElementById("checkResult");
        if (box) box.textContent = "Error checking. Try again.";
      });
    });
  }

  // 🔍 Live phone validation (only if type=phone / auto+digits)
  const checkValueEl  = document.getElementById("checkValue");
  const checkTypeEl   = document.getElementById("checkType");
  const checkResultEl = document.getElementById("checkResult");

  if (checkValueEl && checkResultEl && checkTypeEl) {
    checkValueEl.addEventListener("input", async (e) => {
      const v = e.target.value || "";
      const t = checkTypeEl.value;

      if (!v) {
        checkValueEl.classList.remove("valid","invalid");
        checkResultEl.textContent = "";
        return;
      }

      const looksLikePhone = /^\+?\d[\d\s\-]{5,}$/.test(v);

      if (t === "phone" || (t === "auto" && looksLikePhone)) {
        const res = await checkPhoneEnhanced(v);
        if (res.ok) {
          checkValueEl.classList.add("valid");
          checkValueEl.classList.remove("invalid");
          checkResultEl.innerHTML =
            `<span class="badge safe">
               Valid • ${res.normalized}${res.country ? " • " + res.country : ""}
             </span>`;
        } else {
          checkValueEl.classList.add("invalid");
          checkValueEl.classList.remove("valid");
          checkResultEl.innerHTML =
            `<span class="badge danger">Invalid phone</span>`;
        }
      } else {
        // other types → no strict validation here
        checkValueEl.classList.remove("valid","invalid");
        checkResultEl.textContent = "";
      }
    });
  }

  const reportForm = document.getElementById("reportForm");
  if (reportForm) {
    reportForm.addEventListener("submit", (e) => {
      submitReport(e).catch((err) => {
        console.error(err);
        const msg = document.getElementById("reportMsg");
        if (msg) msg.textContent = "❌ Failed to submit. Please try again.";
      });
    });
  }

  setupAuthUI();
  loadAlerts();
  loadConfirmedList().catch(console.error);
});