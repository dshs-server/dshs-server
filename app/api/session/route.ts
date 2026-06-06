import { NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL!;
const API_KEY = process.env.API_KEY!;

export async function POST() {
  try {
    const res = await fetch(`${BACKEND_URL}/session`, {
      method: "POST",
      headers: { "x-api-key": API_KEY },
    });

    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        { error: `백엔드 오류: ${body}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (e) {
    console.error("session create error:", e);
    return NextResponse.json(
      { error: "백엔드 서버에 연결할 수 없습니다." },
      { status: 503 }
    );
  }
}
