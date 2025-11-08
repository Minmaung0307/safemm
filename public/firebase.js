// public/firebase.js
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getFirestore,
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
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCpgsZEARME1fsNy2RRzYrusbNcrRl_mDQ",
  authDomain: "safe-mm.firebaseapp.com",
  projectId: "safe-mm",
};

export const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Re-export helpers for app.js
export {
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
  serverTimestamp
};