import { NextResponse } from "next/server";
import { getSessionEmail, isAdmin } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL!;
const API_KEY = process.env.API_KEY!;

async function guard() {
  const email = await getSessionEmail();
  return isAdmin(email) ? email : null;
}

export async function DELETE(
  _req: Request,
  { params }: { params: { name: string } }
) {
  if (!(await guard())) {
    return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  }
  try {
    const res = await fetch(
      `${BACKEND_URL}/admin/containers/${encodeURIComponent(params.name)}`,
      {
        method: "DELETE",
        headers: { "x-api-key": API_KEY },
      }
    );
    if (!res.ok) return NextResponse.json({ error: "삭제 실패" }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "백엔드 연결 실패" }, { status: 503 });
  }
}
