import { NextResponse } from "next/server";
import { getSessionEmail, isAdmin } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL;
const API_KEY = process.env.API_KEY;

const EMPTY = { summary: { usage_seconds: 0, sessions_started: 0, upload_bytes: 0 }, events: [] };

export async function GET() {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!BACKEND_URL || !API_KEY) return NextResponse.json(EMPTY);

  try {
    const res = await fetch(`${BACKEND_URL}/history`, {
      headers: {
        "x-api-key": API_KEY,
        "x-user-email": email,
        "x-user-admin": isAdmin(email) ? "1" : "0",
      },
      cache: "no-store",
    });
    if (res.ok) return NextResponse.json(await res.json());
    return NextResponse.json(EMPTY);
  } catch {
    return NextResponse.json(EMPTY);
  }
}
