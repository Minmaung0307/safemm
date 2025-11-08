// public/app.js
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

// Auto-detect type (very simple)
function detectType(input) {
  const v = input.trim();
  if (v.startsWith("http://") || v.startsWith("https://")) return "link";
  if (v.includes("facebook.com") || v.startsWith("@")) return "page";
  if (/^\d{10,15}$/.test(v.replace(/\D/g, ""))) return "phone";
  if (v.toLowerCase().includes("kbz") || v.toLowerCase().includes("wave")) return "wallet";
  return "other";
}

function normalize(type, value) {
  let v = value.trim();
  if (type === "phone") {
    v = v.replace(/\D/g, "");
    if (v.startsWith("09")) v = "+95" + v.slice(1);
  }
  if (type === "link") {
    try { v = new URL(v).href; } catch {}
  }
  return v;
}

function riskToBadge(score, confirmedScam, reportCount) {
  if (confirmedScam) {
    return `<span class="badge danger">⚠ Confirmed scam (${reportCount} reports)</span>`;
  }
  if (score >= 70) return `<span class="badge danger">⚠ High risk (${reportCount} reports)</span>`;
  if (score >= 30) return `<span class="badge warn">⚠ Some reports (${reportCount})</span>`;
  if (reportCount > 0) return `<span class="badge warn">⚠ Mixed reports (${reportCount})</span>`;
  return `<span class="badge safe">✔ No reports found (yet)</span>`;
}

async function checkEntity(type, value) {
  const resBox = document.getElementById("checkResult");
  resBox.textContent = "Checking…";
  const normType = type === "auto" ? detectType(value) : type;
  const normVal = normalize(normType, value);
  if (!normVal) {
    resBox.textContent = "Invalid input.";
    return;
  }

  const qRef = query(
    ENTITIES,
    where("type", "==", normType),
    where("value", "==", normVal)
  );
  const snap = await getDocs(qRef);

  if (snap.empty) {
    resBox.innerHTML = `
      ${riskToBadge(0, false, 0)}
      <div class="muted small">
        No community reports found for <strong>${normVal}</strong>.
        You can help others by reporting if you experienced anything suspicious.
      </div>`;
    return;
  }

  const e = snap.docs[0].data();
  const badge = riskToBadge(e.riskScore || 0, e.confirmedScam, e.reportCount || 0);
  resBox.innerHTML = `
    ${badge}
    <div class="muted small">
      Type: <strong>${e.type}</strong> —
      Value: <strong>${e.value}</strong><br/>
      Reports: ${e.reportCount || 0},
      Last update: ${e.lastReportAt ? e.lastReportAt.toDate().toLocaleString() : "N/A"}
    </div>`;
}

// Simple scoring
function calcRiskScore(current, reportType) {
  let base = current || 0;
  if (reportType === "scam") base += 15;
  if (reportType === "spam") base += 5;
  if (reportType === "safe") base -= 10;
  if (base < 0) base = 0;
  if (base > 100) base = 100;
  return base;
}

async function submitReport(ev) {
  ev.preventDefault();
  const msg = document.getElementById("reportMsg");
  msg.textContent = "";

  const type = document.getElementById("rType").value;
  const rawValue = document.getElementById("rValue").value.trim();
  const category = document.getElementById("rCategory").value;
  const region = document.getElementById("rRegion").value.trim() || null;
  const desc = document.getElementById("rDesc").value.trim();
  const amount = parseInt(document.getElementById("rAmount").value || "0", 10) || 0;

  if (!rawValue) {
    msg.textContent = "Please enter a value to report.";
    return;
  }

  const normVal = normalize(type, rawValue);

  // 1) Upsert entity
  // key: type + value
  const key = `${type}_${normVal}`.replace(/[.#$/[\]]/g, "_");
  const eRef = doc(ENTITIES, key);
  const eSnap = await getDoc(eRef);
  const exists = eSnap.exists();
  const eData = exists ? eSnap.data() : {
    type,
    value: normVal,
    reportCount: 0,
    riskScore: 0,
    confirmedScam: false,
    safeFlag: false,
    createdAt: serverTimestamp()
  };

  const reportType = "scam"; // MVP: treat as scam; later add dropdown
  const newRisk = calcRiskScore(eData.riskScore || 0, reportType);

  await setDoc(eRef, {
    ...eData,
    reportCount: (eData.reportCount || 0) + 1,
    riskScore: newRisk,
    lastReportAt: serverTimestamp()
  }, { merge: true });

  // 2) Create report
  await addDoc(REPORTS, {
    entityId: key,
    entityType: type,
    entityValue: normVal,
    reportType,
    category,
    region,
    description: desc || null,
    amount: amount || null,
    status: "pending", // moderator can approve
    createdAt: serverTimestamp()
  });

  msg.textContent = "✅ Report submitted. Thank you for helping others.";
  (ev.target).reset();
}

async function loadAlerts() {
  const box = document.getElementById("alertsList");
  if (!box) return;
  try {
    const qRef = query(ALERTS, orderBy("createdAt", "desc"), limit(8));
    const snap = await getDocs(qRef);
    if (snap.empty) {
      box.innerHTML = `<div class="muted small">No alerts yet.</div>`;
      return;
    }
    box.innerHTML = "";
    snap.forEach(docSnap => {
      const a = docSnap.data();
      const sev = a.severity || "info";
      const badge =
        sev === "critical" ? "🚨 Critical" :
        sev === "warning" ? "⚠ Warning" : "ℹ Info";
      box.innerHTML += `
        <div class="alert-item">
          <div><strong>${a.title || "Alert"}</strong> <span class="small">${badge}</span></div>
          <div class="small muted">${a.body || ""}</div>
        </div>`;
    });
  } catch (err) {
    console.error(err);
    box.innerHTML = `<div class="muted small">Failed to load alerts.</div>`;
  }
}

function setupAuthUI() {
  const dlg = document.getElementById("authDialog");
  const form = document.getElementById("authForm");
  const btnLogin = document.getElementById("btnLogin");
  const btnLogout = document.getElementById("btnLogout");
  const btnCancel = document.getElementById("authCancel");
  const errBox = document.getElementById("authError");

  if (!btnLogin || !btnLogout || !dlg || !form) return;

  btnLogin.addEventListener("click", () => {
    errBox.textContent = "";
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
    btnCancel.addEventListener("click", () => {
      dlg.close();
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.textContent = "";
    const email = document.getElementById("authEmail").value.trim();
    const pw = document.getElementById("authPassword").value;
    if (!email || !pw) {
      errBox.textContent = "Email / password required.";
      return;
    }
    try {
      await signInWithEmailAndPassword(auth, email, pw);
      dlg.close();
    } catch (err) {
      console.error(err);
      errBox.textContent = "Login failed. Check credentials.";
    }
  });

  // auth state
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

/* -------- BOOTSTRAP ---------- */
window.addEventListener("DOMContentLoaded", () => {
  // wire check form
  const checkForm = document.getElementById("checkForm");
  if (checkForm) {
    checkForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const type = document.getElementById("checkType").value;
      const value = document.getElementById("checkValue").value;
      checkEntity(type, value).catch((err) => {
        console.error(err);
        document.getElementById("checkResult").textContent =
          "Error checking. Try again.";
      });
    });
  }

  // wire report
  const reportForm = document.getElementById("reportForm");
  if (reportForm) {
    reportForm.addEventListener("submit", (e) => {
      submitReport(e).catch((err) => {
        console.error(err);
        document.getElementById("reportMsg").textContent =
          "❌ Failed to submit. Please try again.";
      });
    });
  }

  setupAuthUI();
  loadAlerts();
});