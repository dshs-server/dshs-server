import { NextResponse } from "next/server";
import { getSessionEmail, isAdminFull } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL;
const API_KEY = process.env.API_KEY;

export async function GET() {
  const email = await getSessionEmail();
  if (!(await isAdminFull(email))) return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  if (!BACKEND_URL || !API_KEY) {
    return NextResponse.json({ alerts: [], unacknowledged: 0, scan_enabled: false });
  }

  try {
    const res = await fetch(`${BACKEND_URL}/admin/security-alerts`, {
      headers: { "x-api-key": API_KEY },
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ error: "조회 실패" }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "백엔드 연결 실패" }, { status: 503 });
  }
}
