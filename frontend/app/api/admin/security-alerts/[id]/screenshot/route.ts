import { NextResponse } from "next/server";
import { getSessionEmail, isAdminFull } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL;
const API_KEY = process.env.API_KEY;

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const email = await getSessionEmail();
  if (!(await isAdminFull(email))) return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  if (!BACKEND_URL || !API_KEY) return NextResponse.json({ error: "백엔드 미설정" }, { status: 503 });

  try {
    const res = await fetch(
      `${BACKEND_URL}/admin/security-alerts/${encodeURIComponent(params.id)}/screenshot`,
      { headers: { "x-api-key": API_KEY }, cache: "no-store" }
    );
    if (!res.ok) return NextResponse.json({ error: "스크린샷 없음" }, { status: res.status });
    return new NextResponse(await res.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": res.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "백엔드 연결 실패" }, { status: 503 });
  }
}
