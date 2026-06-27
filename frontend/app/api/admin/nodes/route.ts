import { NextResponse } from "next/server";
import { getSessionEmail, isAdmin } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL!;
const API_KEY = process.env.API_KEY!;

export async function GET() {
  const email = await getSessionEmail();
  if (!isAdmin(email)) return NextResponse.json({ error: "권한 없음" }, { status: 403 });

  try {
    const res = await fetch(`${BACKEND_URL}/admin/nodes`, {
      headers: { "x-api-key": API_KEY },
      cache: "no-store",
    });
    if (res.ok) return NextResponse.json(await res.json());
    return NextResponse.json({ nodes: [] });
  } catch {
    return NextResponse.json({ nodes: [] });
  }
}
