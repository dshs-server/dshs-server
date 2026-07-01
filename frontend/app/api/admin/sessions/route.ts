import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail, isAdminFull } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL;
const API_KEY = process.env.API_KEY;

async function adminHeaders() {
  const email = await getSessionEmail();
  if (!(await isAdminFull(email))) return null;
  return {
    "x-api-key": API_KEY!,
    "x-user-email": email!,
    "x-user-admin": "1",
  };
}

export async function GET() {
  const headers = await adminHeaders();
  if (!headers) return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  if (!BACKEND_URL) return NextResponse.json({ sessions: [] });

  try {
    const res = await fetch(`${BACKEND_URL}/admin/sessions`, {
      headers,
      cache: "no-store",
    });
    if (res.ok) return NextResponse.json(await res.json());
    return NextResponse.json({ sessions: [] });
  } catch {
    return NextResponse.json({ sessions: [] });
  }
}

// 관리자가 세션 연장 허가
export async function PATCH(request: NextRequest) {
  const headers = await adminHeaders();
  if (!headers) return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  if (!BACKEND_URL) return NextResponse.json({ error: "설정 오류" }, { status: 500 });

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("session_id");
  if (!sessionId) return NextResponse.json({ error: "session_id 필요" }, { status: 400 });

  try {
    const body = await request.json();
    const res = await fetch(`${BACKEND_URL}/session/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : null;
      return NextResponse.json({ error: detail || "처리 실패" }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "백엔드 연결 실패" }, { status: 503 });
  }
}

// 관리자가 특정 세션 강제 종료
export async function DELETE(request: NextRequest) {
  const headers = await adminHeaders();
  if (!headers) return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  if (!BACKEND_URL) return NextResponse.json({ error: "설정 오류" }, { status: 500 });

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("session_id");
  if (!sessionId) return NextResponse.json({ error: "session_id 필요" }, { status: 400 });

  try {
    const res = await fetch(
      `${BACKEND_URL}/session/${encodeURIComponent(sessionId)}?permanent=true`,
      { method: "DELETE", headers }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : null;
      return NextResponse.json({ error: detail || "종료 실패" }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "백엔드 연결 실패" }, { status: 503 });
  }
}

// 관리자가 다른 사용자 대신 세션 생성
export async function POST(request: NextRequest) {
  const headers = await adminHeaders();
  if (!headers) return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  if (!BACKEND_URL) return NextResponse.json({ error: "설정 오류" }, { status: 500 });

  try {
    const body = await request.json();
    const res = await fetch(`${BACKEND_URL}/session`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : null;
      return NextResponse.json({ error: detail || "세션 생성 실패" }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "백엔드 연결 실패" }, { status: 503 });
  }
}
