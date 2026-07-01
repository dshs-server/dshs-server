import crypto from "crypto";
import { cookies } from "next/headers";

export const COOKIE_NAME = "pc_rental_auth";

/**
 * 쿠키 토큰 형식: `<hmac>.<urlencoded-email>`
 *  - hmac 은 email 에 대한 HMAC-SHA256 (hex, 64자, 점 없음)
 *  - email 은 점을 포함할 수 있으므로 첫 번째 '.' 를 구분자로 사용
 */
function sign(email: string): string {
  return crypto
    .createHmac("sha256", process.env.AUTH_SECRET!)
    .update(email)
    .digest("hex");
}

export function makeToken(email: string): string {
  return `${sign(email)}.${encodeURIComponent(email)}`;
}

/** 토큰을 검증하고 유효하면 email 을, 아니면 null 을 반환한다. */
export function verifyToken(token: string | undefined): string | null {
  if (!token || !process.env.AUTH_SECRET) return null;
  const sep = token.indexOf(".");
  if (sep <= 0) return null;

  const sig = token.slice(0, sep);
  let email: string;
  try {
    email = decodeURIComponent(token.slice(sep + 1));
  } catch {
    return null;
  }

  const expected = sign(email);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
  } catch {
    return null;
  }
  return email;
}

export async function setAuthCookie(email: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, makeToken(email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30, // 30일
    path: "/",
  });
}

export async function clearAuthCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

/** 현재 로그인한 사용자의 email 을 반환 (서버 컴포넌트/라우트용). */
export async function getSessionEmail(): Promise<string | null> {
  const cookieStore = await cookies();
  return verifyToken(cookieStore.get(COOKIE_NAME)?.value);
}

/** 허용 도메인(@ts.hs.kr 등) 여부. */
export function isAllowedDomain(email: string): boolean {
  const domain = (process.env.ALLOWED_DOMAIN || "ts.hs.kr").toLowerCase();
  return email.toLowerCase().endsWith(`@${domain}`);
}

const HARDCODED_ADMINS = ["ts250024@ts.hs.kr", "ts250015@ts.hs.kr"];

/** 관리자 email 여부. ADMIN_EMAILS 환경변수(쉼표 구분) 또는 하드코딩 목록. */
export function isAdmin(email: string | null): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  if (HARDCODED_ADMINS.includes(lower)) return true;
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(lower);
}

/** 환경변수 + Firestore is_admin 필드 통합 체크 (서버사이드 전용). */
export async function isAdminFull(email: string | null): Promise<boolean> {
  if (!email) return false;
  if (isAdmin(email)) return true;
  try {
    const res = await fetch(
      `${process.env.BACKEND_URL}/admin/users/${encodeURIComponent(email)}`,
      { headers: { "x-api-key": process.env.API_KEY! }, cache: "no-store" }
    );
    if (res.ok) return (await res.json()).is_admin === true;
  } catch {}
  return false;
}
