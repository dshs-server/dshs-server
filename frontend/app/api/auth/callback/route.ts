import { NextRequest, NextResponse } from "next/server";
import { makeToken, isAllowedDomain, COOKIE_NAME } from "@/lib/auth";

interface GoogleUserInfo {
  email?: string;
  email_verified?: boolean | string;
  hd?: string;
  name?: string;
}

function loginRedirect(origin: string, error: string) {
  return NextResponse.redirect(new URL(`/login?error=${error}`, origin));
}

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const { searchParams } = request.nextUrl;

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const stateCookie = request.cookies.get("g_oauth_state")?.value;

  // CSRF: state 검증
  if (!code || !state || !stateCookie || state !== stateCookie) {
    return loginRedirect(origin, "state");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return loginRedirect(origin, "config");
  }

  // authorization code → token 교환
  let accessToken: string | undefined;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${origin}/api/auth/callback`,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      return loginRedirect(origin, "oauth");
    }
    const data = await tokenRes.json();
    accessToken = data.access_token;
  } catch {
    return loginRedirect(origin, "oauth");
  }

  if (!accessToken) return loginRedirect(origin, "oauth");

  // Google이 발급한 access token으로 사용자 정보를 서버에서 다시 확인한다.
  let claims: GoogleUserInfo | null = null;
  try {
    const userInfoRes = await fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!userInfoRes.ok) return loginRedirect(origin, "oauth");
    claims = await userInfoRes.json();
  } catch {
    return loginRedirect(origin, "oauth");
  }

  const email = claims?.email?.toLowerCase();
  const verified =
    claims?.email_verified === true || claims?.email_verified === "true";

  if (!email || !verified) {
    return loginRedirect(origin, "unverified");
  }

  // 학교 도메인(@ts.hs.kr)만 허용 — hd 클레임 + 이메일 도메인 이중 확인
  const domain = (process.env.ALLOWED_DOMAIN || "ts.hs.kr").toLowerCase();
  if (!isAllowedDomain(email) || (claims?.hd && claims.hd.toLowerCase() !== domain)) {
    return loginRedirect(origin, "domain");
  }

  // 인증 성공 → 세션 쿠키 발급
  const response = NextResponse.redirect(new URL("/dashboard", origin));
  response.cookies.set(COOKIE_NAME, makeToken(email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  response.cookies.delete("g_oauth_state");
  return response;
}
