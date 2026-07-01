import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail, isAdminFull } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL;
const API_KEY = process.env.API_KEY;

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const email = await getSessionEmail();
  if (!(await isAdminFull(email))) return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  if (!BACKEND_URL || !API_KEY) return NextResponse.json({ error: "백엔드 미설정" }, { status: 503 });

  try {
    const body = await req.json();
    const res = await fetch(`${BACKEND_URL}/admin/security-alerts/${encodeURIComponent(params.id)}`, {
      method: "PATCH",
      headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "백엔드 연결 실패" }, { status: 503 });
  }
}
