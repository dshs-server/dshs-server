import { NextResponse } from "next/server";
import { getSessionEmail, isAdmin } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL!;
const API_KEY = process.env.API_KEY!;

export async function GET() {
  try {
    const res = await fetch(`${BACKEND_URL}/notice`, {
      headers: { "x-api-key": API_KEY },
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ notice: null });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ notice: null });
  }
}

export async function POST(request: Request) {
  const email = await getSessionEmail();
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    const res = await fetch(`${BACKEND_URL}/notice`, {
      method: "POST",
      headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ notice: body.notice ?? "" }),
    });
    if (!res.ok) {
      return NextResponse.json({ error: "공지 저장 실패" }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "백엔드 연결 실패" }, { status: 503 });
  }
}
