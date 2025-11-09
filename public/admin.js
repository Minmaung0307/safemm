import {
  db,
  auth,
  collection,
  doc,
  getDocs,
  getDoc,
  query,
  where,
  updateDoc,
  limit,
  onAuthStateChanged
} from "./firebase.js";

// Very simple protection: restrict by email domain/IP via rules in real app.
// Here: display only; assume real security rules in Firestore.
const REPORTS = collection(db, "reports");
const ENTITIES = collection(db, "entities");

const ADMIN_UIDS = [
  "S47vddL1CIfWkc6X2U25jxJWlzJ3",
  "S47vddL1CIfWkc6X2U25jxJWlzJ3",
  // "REPLACE_WITH_ADMIN_UID_2"
];

function isAdminUser(user) {
  return user && ADMIN_UIDS.includes(user.uid);
}

async function loadPending() {
  const tbody = document.querySelector("#pendingTable tbody");
  tbody.innerHTML = "<tr><td colspan='7'>Loading…</td></tr>";
  const qRef = query(REPORTS, where("status", "==", "pending"), limit(100));
  const snap = await getDocs(qRef);
  if (snap.empty) {
    tbody.innerHTML = "<tr><td colspan='7'>No pending reports.</td></tr>";
    return;
  }
  tbody.innerHTML = "";
  snap.forEach((s) => {
    const r = s.data();
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.createdAt ? r.createdAt.toDate().toLocaleString() : ""}</td>
      <td>${r.entityType}</td>
      <td>${r.entityValue}</td>
      <td>${r.category || ""}</td>
      <td>${r.region || ""}</td>
      <td>${(r.description || "").slice(0,80)}</td>
      <td>
        <button class="btn-xs btn-approve" data-id="${s.id}">Approve</button>
        <button class="btn-xs btn-reject" data-id="${s.id}">Reject</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function handleAction(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  if (!id) return;

  if (btn.classList.contains("btn-approve")) {
    await updateDoc(doc(REPORTS, id), { status: "approved" });
  } else if (btn.classList.contains("btn-reject")) {
    await updateDoc(doc(REPORTS, id), { status: "rejected" });
  }
  loadPending().catch(console.error);
}

function showDenied() {
  const wrap = document.querySelector(".admin-wrap");
  if (wrap) {
    wrap.innerHTML = `
      <h2>SafeMM Admin</h2>
      <p class="muted small">Access denied. Please login with an admin account from main site.</p>
    `;
  }
}
window.checkPhoneEnhanced = checkPhoneEnhanced;
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
    }
  });
});