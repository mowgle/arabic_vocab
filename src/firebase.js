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
  apiKey: "AIzaSyAEYz7XurI2r7NihIrVx8pjunflbSZOfB0",
  authDomain: "seekers-light-arabic-vocab.firebaseapp.com",
  projectId: "seekers-light-arabic-vocab",
  storageBucket: "seekers-light-arabic-vocab.firebasestorage.app",
  messagingSenderId: "1090628488929",
  appId: "1:1090628488929:web:13e05fa5db272bead7b1a0"
};

import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
