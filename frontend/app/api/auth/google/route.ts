import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export async function GET(request: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.redirect(
      new URL("/login?error=config", request.nextUrl.origin)
    );
  }

  const redirectUri = `${request.nextUrl.origin}/api/auth/callback`;
  const state = crypto.randomBytes(16).toString("hex");
  const domain = process.env.ALLOWED_DOMAIN || "ts.hs.kr";

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
    hd: domain, // 학교 도메인 힌트 (계정 선택 시 해당 도메인 우선)
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  const response = NextResponse.redirect(authUrl);
  response.cookies.set("g_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return response;
}
