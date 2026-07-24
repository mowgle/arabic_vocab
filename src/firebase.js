// ---------------------------------------------------------------------------
// Paste your Firebase project's web config below. You get this from:
// Firebase Console → Project settings → General → "Your apps" → SDK setup
// and configuration → Config.
//
// This is safe to commit / expose publicly — Firebase web config values are
// not secrets. Access control is enforced by Firestore Security Rules
// (see firestore.rules in this repo), not by hiding this config.
// ---------------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "PASTE_YOUR_API_KEY_HERE",
  authDomain: "PASTE_YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_YOUR_PROJECT_ID",
  storageBucket: "PASTE_YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_YOUR_SENDER_ID",
  appId: "PASTE_YOUR_APP_ID",
};

import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
