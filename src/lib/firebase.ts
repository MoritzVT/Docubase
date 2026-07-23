import { getApp, getApps, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  type Auth,
} from "firebase/auth";
import {
  connectFirestoreEmulator,
  getFirestore,
  type Firestore,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const requiredKeys = ["apiKey", "projectId", "appId"] as const;
const missingKeys = requiredKeys.filter((key) => !firebaseConfig[key]);

export const firebaseConfigurationError =
  missingKeys.length > 0
    ? `Firebase is missing: ${missingKeys.join(", ")}. Copy .env.example to .env.local and fill in the web app config.`
    : null;

export let auth: Auth | null = null;
export let db: Firestore | null = null;

if (!firebaseConfigurationError) {
  const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
  auth = getAuth(app);
  db = getFirestore(
    app,
    import.meta.env.VITE_FIREBASE_DATABASE_ID || "default",
  );

  if (
    import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true" &&
    !(globalThis as { __DOCUBASE_EMULATORS_CONNECTED__?: boolean })
      .__DOCUBASE_EMULATORS_CONNECTED__
  ) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    (
      globalThis as { __DOCUBASE_EMULATORS_CONNECTED__?: boolean }
    ).__DOCUBASE_EMULATORS_CONNECTED__ = true;
  }
}

export function requireAuth(): Auth {
  if (!auth) throw new Error(firebaseConfigurationError ?? "Auth is unavailable.");
  return auth;
}

export function requireDb(): Firestore {
  if (!db) {
    throw new Error(firebaseConfigurationError ?? "Firestore is unavailable.");
  }
  return db;
}
