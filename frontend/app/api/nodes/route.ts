import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL!;
const API_KEY = process.env.API_KEY!;

const FALLBACK_NODES = [
  {
    id: "server-01",
    name: "1호기",
    cpu: "Intel Core i7",
    cpu_cores: 8,
    gpu: "NVIDIA GTX 1660",
    ram_gb: 32,
    storage_gb: 500,
    available: true,
    session_state: "none",
  },
];

export async function GET(request: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "로그인 필요" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const query = searchParams.toString();

  try {
    const res = await fetch(`${BACKEND_URL}/nodes${query ? `?${query}` : ""}`, {
      headers: { "x-api-key": API_KEY },
      cache: "no-store",
    });
    if (res.ok) return NextResponse.json(await res.json());
  } catch {
    // fall through to fallback
  }
  return NextResponse.json({ nodes: FALLBACK_NODES });
}
