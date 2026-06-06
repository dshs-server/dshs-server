import crypto from "crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = "pc_rental_auth";

function makeToken(username: string): string {
  return crypto
    .createHmac("sha256", process.env.AUTH_SECRET!)
    .update(username)
    .digest("hex");
}

export function isValidCredentials(username: string, password: string): boolean {
  return (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  );
}

export async function setAuthCookie(username: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, makeToken(username), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24, // 1 day
    path: "/",
  });
}

export async function clearAuthCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export function verifyToken(token: string): boolean {
  const expected = makeToken(process.env.ADMIN_USERNAME!);
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
