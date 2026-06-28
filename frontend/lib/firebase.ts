import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app =
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY
    ? getApps().length
      ? getApps()[0]
      : initializeApp(firebaseConfig)
    : null;
export const auth = app ? getAuth(app) : null;
