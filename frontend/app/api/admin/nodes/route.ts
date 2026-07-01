import { NextResponse } from "next/server";
import { getSessionEmail, isAdminFull } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL;
const API_KEY = process.env.API_KEY;

const LOCAL_FALLBACK_NODES = [
  {
    id: "server-01",
    name: "1호기 (로컬 Mock)",
    status: "idle",
    cpu_usage: 5.2,
    gpu_usage: 0,
    ram_used_gb: 4.1,
    ram_total_gb: 32,
    storage_used_gb: 120,
    storage_total_gb: 500,
  },
];

export async function GET() {
  const email = await getSessionEmail();
  if (!(await isAdminFull(email))) return NextResponse.json({ error: "권한 없음" }, { status: 403 });

  if (!BACKEND_URL || !API_KEY) {
    return NextResponse.json({ nodes: LOCAL_FALLBACK_NODES });
  }

  try {
    const res = await fetch(`${BACKEND_URL}/admin/nodes`, {
      headers: { "x-api-key": API_KEY },
      cache: "no-store",
    });
    if (res.ok) return NextResponse.json(await res.json());
    return NextResponse.json({ nodes: LOCAL_FALLBACK_NODES });
  } catch {
    return NextResponse.json({ nodes: LOCAL_FALLBACK_NODES });
  }
}
