import { NextRequest, NextResponse } from "next/server";
import { makeToken, COOKIE_NAME } from "@/lib/auth";

// ⚠️ 개발용 우회: Google OAuth 절차를 생략하고 바로 로그인 처리한다.
//   버튼 클릭 → 더미 계정으로 세션 쿠키 발급 → 대시보드 이동.
//   실제 운영 복구 시 이 파일을 git 이전 버전으로 되돌릴 것.
const DEV_EMAIL = process.env.DEV_LOGIN_EMAIL || "dev@ts.hs.kr";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const response = NextResponse.redirect(new URL("/dashboard", origin));
  response.cookies.set(COOKIE_NAME, makeToken(DEV_EMAIL), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 8,
    path: "/",
  });
  return response;
}
