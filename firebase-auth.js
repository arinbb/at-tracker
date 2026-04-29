// Firebase auth + Firestore module — exposes a small global API for app.js.
// app.js stays a plain IIFE (no module system) and reads window.AT_AUTH.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Persist auth across sessions in localStorage (default but be explicit).
setPersistence(auth, browserLocalPersistence).catch((e) => {
  console.warn("auth persistence failed:", e);
});

const provider = new GoogleAuthProvider();

let listeners = [];

function onAuthChange(cb) {
  listeners.push(cb);
}

onAuthStateChanged(auth, (user) => {
  for (const cb of listeners) {
    try { cb(user); } catch (e) { console.warn("auth listener failed:", e); }
  }
});

async function signInWithGoogle() {
  // Popup is simpler than redirect; on iOS Safari it may fall back automatically.
  return signInWithPopup(auth, provider);
}

async function signOut() {
  return fbSignOut(auth);
}

function userDocRef(uid) {
  return doc(db, "users", uid);
}

async function loadCloudData(uid) {
  const snap = await getDoc(userDocRef(uid));
  return snap.exists() ? snap.data() : null;
}

async function saveCloudData(uid, payload) {
  await setDoc(
    userDocRef(uid),
    { ...payload, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

window.AT_AUTH = {
  ready: true,
  onAuthChange,
  signInWithGoogle,
  signOut,
  getCurrentUser: () => auth.currentUser,
  loadCloudData,
  saveCloudData,
};

// Notify any pending listeners that auth is ready (in case app.js loads first).
window.dispatchEvent(new CustomEvent("at-auth-ready"));
