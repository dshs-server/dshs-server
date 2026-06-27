import { NextResponse } from "next/server";
import { getSessionEmail, isAdmin } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL!;
const API_KEY = process.env.API_KEY!;

async function userHeaders() {
  const email = await getSessionEmail();
  if (!email) return null;
  return {
    "x-api-key": API_KEY,
    "x-user-email": email || "",
    "x-user-admin": isAdmin(email) ? "1" : "0",
  };
}

export async function GET() {
  const headers = await userHeaders();
  if (!headers) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  try {
    const res = await fetch(`${BACKEND_URL}/session`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ status: "none" });
    return NextResponse.json(await res.json());
  } catch (e) {
    console.error("session get error:", e);
    return NextResponse.json({ status: "none" });
  }
}

export async function POST(request: Request) {
  const headers = await userHeaders();
  if (!headers) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const resume = searchParams.get("resume");
  const backendPath =
    resume === "true"
      ? `${BACKEND_URL}/session?resume=true`
      : `${BACKEND_URL}/session`;

  try {
    const res = await fetch(backendPath, {
      method: "POST",
      headers,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 409 = 다른 사용자가 점유 중 (detail 안에 owner/queue_position)
      if (res.status === 409) {
        const d = data.detail || {};
        return NextResponse.json(
          { error: "사용 중", owner: d.owner, queue_position: d.queue_position },
          { status: 409 }
        );
      }
      const detail = typeof data.detail === "string" ? data.detail : null;
      return NextResponse.json(
        { error: detail || data.error || "세션 생성 실패" },
        { status: res.status }
      );
    }
    return NextResponse.json(data);
  } catch (e) {
    console.error("session create error:", e);
    return NextResponse.json(
      { error: "백엔드 서버에 연결할 수 없습니다." },
      { status: 503 }
    );
  }
}
