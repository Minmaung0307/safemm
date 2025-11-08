import {
  db,
  collection,
  doc,
  getDocs,
  getDoc,
  query,
  where,
  updateDoc,
  limit
} from "./firebase.js";

// Very simple protection: restrict by email domain/IP via rules in real app.
// Here: display only; assume real security rules in Firestore.
const REPORTS = collection(db, "reports");
const ENTITIES = collection(db, "entities");

async function loadPending() {
  const tbody = document.querySelector("#pendingTable tbody");
  tbody.innerHTML = "<tr><td colspan='7'>Loading…</td></tr>";
  const qRef = query(REPORTS, where("status", "==", "pending"), limit(50));
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
        <button class="btn-xs btn-approve" data-approve="${s.id}">Approve</button>
        <button class="btn-xs btn-reject" data-reject="${s.id}">Reject</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function handleAction(e) {
  const approveId = e.target.getAttribute("data-approve");
  const rejectId = e.target.getAttribute("data-reject");
  if (!approveId && !rejectId) return;

  if (approveId) {
    await updateDoc(doc(REPORTS, approveId), { status: "approved" });
  } else if (rejectId) {
    await updateDoc(doc(REPORTS, rejectId), { status: "rejected" });
  }
  loadPending().catch(console.error);
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("pendingTable").addEventListener("click", handleAction);
  loadPending().catch(err => {
    console.error(err);
    document.getElementById("adminMsg").textContent = "Failed to load pending reports.";
  });
});