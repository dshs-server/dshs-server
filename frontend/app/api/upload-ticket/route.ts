import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL || "";
const API_KEY = process.env.API_KEY || "";

export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const res = await fetch(`${BACKEND_URL}/upload-ticket`, {
    headers: { "x-api-key": API_KEY, "x-user-email": email },
    cache: "no-store",
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json(
      { error: (data as { detail?: string }).detail || "업로드 준비에 실패했습니다." },
      { status: res.status }
    );
  }

  return NextResponse.json(data);
}
