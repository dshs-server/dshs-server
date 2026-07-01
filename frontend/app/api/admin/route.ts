import { NextResponse } from "next/server";
import { getSessionEmail, isAdminFull } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL!;
const API_KEY = process.env.API_KEY!;

async function guard() {
  const email = await getSessionEmail();
  return (await isAdminFull(email)) ? email : null;
}

export async function GET() {
  if (!(await guard())) {
    return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  }
  try {
    const res = await fetch(`${BACKEND_URL}/admin/status`, {
      headers: { "x-api-key": API_KEY },
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ error: "조회 실패" }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "백엔드 연결 실패" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const email = await guard();
  if (!email) {
    return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  }
  const { action } = await request.json().catch(() => ({ action: "" }));

  const endpoints: Record<string, { path: string; method: string }> = {
    cleanup: { path: "/admin/cleanup", method: "POST" },
    terminate: { path: "/admin/terminate", method: "POST" },
  };
  const ep = endpoints[action];
  if (!ep) {
    return NextResponse.json({ error: "알 수 없는 작업" }, { status: 400 });
  }

  try {
    const res = await fetch(`${BACKEND_URL}${ep.path}`, {
      method: ep.method,
      headers: { "x-api-key": API_KEY, "x-user-admin": "1" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json({ error: "작업 실패" }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "백엔드 연결 실패" }, { status: 503 });
  }
}
