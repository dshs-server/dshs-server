import { NextRequest, NextResponse } from "next/server";
import { getApps } from "firebase-admin/app";
import "@/lib/firebase-admin";
import { getAuth } from "firebase-admin/auth";
import { makeToken, isAllowedDomain, COOKIE_NAME } from "@/lib/auth";

export async function POST(request: NextRequest) {
  let idToken: string;
  try {
    const body = await request.json();
    idToken = body.idToken;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (!idToken) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  console.log("[firebase/route] apps initialized:", getApps().length, "PROJECT_ID:", !!process.env.FIREBASE_PROJECT_ID);

  let decoded: import("firebase-admin/auth").DecodedIdToken;
  try {
    decoded = await getAuth().verifyIdToken(idToken);
  } catch (e) {
    console.error("[firebase/route] verifyIdToken failed:", e);
    return NextResponse.json({ error: "oauth", detail: String(e) }, { status: 401 });
  }

  const email = decoded.email?.toLowerCase();
  if (!email || !decoded.email_verified) {
    return NextResponse.json({ error: "unverified" }, { status: 403 });
  }

  if (!isAllowedDomain(email)) {
    return NextResponse.json({ error: "domain" }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, makeToken(email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return response;
}
