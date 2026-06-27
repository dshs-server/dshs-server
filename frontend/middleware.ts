import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "pc_rental_auth";
const encoder = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 토큰 검증 → 유효하면 email, 아니면 null */
async function verify(
  token: string | undefined,
  secret: string
): Promise<string | null> {
  if (!token) return null;
  const sep = token.indexOf(".");
  if (sep <= 0) return null;
  const sig = token.slice(0, sep);
  let email: string;
  try {
    email = decodeURIComponent(token.slice(sep + 1));
  } catch {
    return null;
  }
  const expected = await hmacHex(secret, email);
  return sig === expected ? email : null;
}

function isAdmin(email: string): boolean {
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  const email = await verify(token, secret);

  if (!email) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // 관리자 전용 경로
  if (pathname.startsWith("/admin") && !isAdmin(email)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*"],
};
