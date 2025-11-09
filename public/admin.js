// admin.js

import {
  db,
  auth,
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  query,
  where,
  updateDoc,
  serverTimestamp,
  limit,
  onAuthStateChanged
} from "./firebase.js";

const REPORTS  = collection(db, "reports");
const ENTITIES = collection(db, "entities");
const ALERTS   = collection(db, "alerts");

const ADMIN_UIDS = [
  "EPczQcfAIQQB0SAvhKbZu6qmLP92",
  "S47vddL1CIfWkc6X2U25jxJWlzJ3",
];

function isAdminUser(user) {
  return !!(user && ADMIN_UIDS.includes(user.uid));
}

/* ---------- Phone helper (for display only) ---------- */

function normalizePhoneAdmin(raw) {
  const orig = (raw || "").toString().trim();
  if (!orig) return { ok: false };

  const only = orig.replace(/[^\d+]/g, "");

  if (/^\+\d{7,15}$/.test(only)) {
    return { ok: true, e164: only };
  }

  if (/^0?9\d{7,9}$/.test(only)) {
    const digits = only.replace(/^0/, "9");
    return { ok: true, e164: "+95" + digits };
  }

  if (/^\d{10}$/.test(only)) {
    return { ok: true, e164: "+1" + only };
  }

  return { ok: false };
}

function checkPhoneEnhanced(raw) {
  const n = normalizePhoneAdmin(raw);
  if (!n.ok) return { ok: false, normalized: "" };
  return {
    ok: true,
    normalized: n.e164,
    country:
      n.e164.startsWith("+95") ? "MM" :
      n.e164.startsWith("+1")  ? "US" : null
  };
}
window.checkPhoneEnhanced = checkPhoneEnhanced;

/* ---------- Helper: create / update entity from report ---------- */

async function upsertEntityFromReport(r) {
  if (!r) return;

  const eKey  = r.entityKey ||
                `${r.entityType || r.type || "other"}_${(r.entityValue || r.value || r.rawInput || "").replace(/[^\w@.+]/g,"")}`;
  const eType = r.entityType || r.type || "other";
  const eVal  = r.entityValue || r.value || r.rawInput || "";

  if (!eKey || !eVal) return;

  const eRef  = doc(ENTITIES, eKey);
  const eSnap = await getDoc(eRef);
  const prev  = eSnap.exists() ? eSnap.data() : {};

  const reportsCount =
    (prev.reportsCount || prev.reportCount || 0) + 1;

  const payload = {
    type: eType,
    value: eVal,
    displayValue: eVal,
    country: r.country || prev.country || null,
    firstReportedAt: prev.firstReportedAt || r.createdAt || serverTimestamp(),
    lastReportedAt: r.createdAt || serverTimestamp(),
    status: "confirmed",
    confirmedScam: true,
    reportsCount,
  };

  await setDoc(eRef, payload, { merge: true });

  // ✅ AUTO ALERT: threshold (e.g. >= 3 reports)
  const threshold = 3;
  if (reportsCount >= threshold) {
    const aRef = doc(ALERTS, eKey);
    await setDoc(
      aRef,
      {
        title: `Warning: Suspicious ${eType.toUpperCase()} detected`,
        message: `This ${eType} (${eVal}) has ${reportsCount} verified community reports. 
Please double-check before sending money or sharing personal information.`,
        severity: "danger",
        active: true,
        updatedAt: serverTimestamp(),
        createdAt: prev.createdAt || serverTimestamp()
      },
      { merge: true }
    );
  }
}

/* ---------- Load pending ---------- */

async function loadPending() {
  const tbody = document.querySelector("#pendingTable tbody");
  if (!tbody) return;

  tbody.innerHTML = "<tr><td colspan='7'>Loading…</td></tr>";

  const qRef = query(REPORTS, where("status", "==", "pending"), limit(200));
  const snap = await getDocs(qRef);

  if (snap.empty) {
    tbody.innerHTML = "<tr><td colspan='7'>No pending reports.</td></tr>";
    return;
  }

  tbody.innerHTML = "";
  snap.forEach((s) => {
    const r = s.data();
    const created = r.createdAt?.toDate
      ? r.createdAt.toDate().toLocaleString()
      : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${created}</td>
      <td>${r.entityType || ""}</td>
      <td>${r.entityValue || ""}</td>
      <td>${r.category || ""}</td>
      <td>${r.region || ""}</td>
      <td>${(r.description || "").slice(0, 100)}</td>
      <td>
        <button class="btn-xs btn-approve" data-id="${s.id}">Approve</button>
        <button class="btn-xs btn-reject" data-id="${s.id}">Reject</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

/* ---------- Approve / Reject ---------- */

async function handleAction(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  if (!id) return;

  const rRef = doc(REPORTS, id);

  if (btn.classList.contains("btn-approve")) {
    const snap = await getDoc(rRef);
    if (!snap.exists()) return;
    const r = snap.data();

    // 1) mark report approved
    await updateDoc(rRef, {
      status: "approved",
      approvedAt: serverTimestamp()
    });

    // 2) ensure entities/{entityKey} updated
    await upsertEntityFromReport(r);

  } else if (btn.classList.contains("btn-reject")) {
    await updateDoc(rRef, {
      status: "rejected",
      reviewedAt: serverTimestamp()
    });
  }

  loadPending().catch(console.error);
}

/* ---------- Backfill (older approved → entities) ---------- */

async function backfillApprovedToEntities() {
  const msg = document.getElementById("adminMsg");
  try {
    const qRef = query(REPORTS, where("status", "==", "approved"), limit(200));
    const snap = await getDocs(qRef);
    let done = 0;
    snap.forEach((docSnap) => {
      const r = docSnap.data();
      if (r.entityKey && r.entityType && r.entityValue) {
        done++;
        upsertEntityFromReport(r);
      }
    });
    if (msg) {
      msg.textContent = `Synced ${done} approved report(s) into entities.`;
    }
  } catch (err) {
    console.error(err);
    if (msg) msg.textContent = "Backfill failed. Check console.";
  }
}

/* ---------- Access control & boot ---------- */

function showDenied() {
  const wrap = document.querySelector(".admin-wrap");
  if (wrap) {
    wrap.innerHTML = `
      <h2>SafeMM — Admin / Moderator</h2>
      <p class="muted small">
        Access denied. Please login with an admin account from the main SafeMM site.
      </p>
    `;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const table = document.getElementById("pendingTable");
  if (table) {
    table.addEventListener("click", (e) => {
      handleAction(e).catch(console.error);
    });
  }

  onAuthStateChanged(auth, (user) => {
    if (!isAdminUser(user)) {
      showDenied();
    } else {
      loadPending().catch(console.error);
      backfillApprovedToEntities().catch(console.error);
    }
  });
});