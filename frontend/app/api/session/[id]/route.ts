import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL!;
const API_KEY = process.env.API_KEY!;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const res = await fetch(`${BACKEND_URL}/session/${id}`, {
      headers: { "x-api-key": API_KEY },
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json({ error: "세션 조회 실패" }, { status: res.status });
    }

    return NextResponse.json(await res.json());
  } catch (e) {
    console.error("session status error:", e);
    return NextResponse.json(
      { error: "백엔드 서버에 연결할 수 없습니다." },
      { status: 503 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const res = await fetch(`${BACKEND_URL}/session/${id}`, {
      method: "DELETE",
      headers: { "x-api-key": API_KEY },
    });

    if (!res.ok) {
      return NextResponse.json({ error: "세션 종료 실패" }, { status: res.status });
    }

    return NextResponse.json(await res.json());
  } catch (e) {
    console.error("session delete error:", e);
    return NextResponse.json(
      { error: "백엔드 서버에 연결할 수 없습니다." },
      { status: 503 }
    );
  }
}
