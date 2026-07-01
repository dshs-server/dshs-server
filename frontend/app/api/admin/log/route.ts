import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail, isAdminFull } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL;
const API_KEY = process.env.API_KEY;

export async function GET(req: NextRequest) {
  const email = await getSessionEmail();
  if (!(await isAdminFull(email))) return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  if (!BACKEND_URL || !API_KEY) return NextResponse.json({ date: null, content: null });

  const date = req.nextUrl.searchParams.get("date") ?? "";
  const url = date
    ? `${BACKEND_URL}/admin/log?date=${encodeURIComponent(date)}`
    : `${BACKEND_URL}/admin/log`;

  try {
    const res = await fetch(url, {
      headers: { "x-api-key": API_KEY },
      cache: "no-store",
    });
    if (res.ok) return NextResponse.json(await res.json());
    return NextResponse.json({ date: null, content: null });
  } catch {
    return NextResponse.json({ date: null, content: null });
  }
}
