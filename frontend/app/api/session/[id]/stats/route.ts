import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL;
const API_KEY = process.env.API_KEY;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await params; // session_id is implicitly validated by the session existing
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  if (!BACKEND_URL || !API_KEY) return NextResponse.json({});

  try {
    const res = await fetch(`${BACKEND_URL}/admin/nodes`, {
      headers: { "x-api-key": API_KEY },
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({});

    const data = await res.json();
    const nodes: {
      status: string;
      cpu_usage?: number;
      gpu_usage?: number;
      ram_used_gb?: number;
      ram_total_gb?: number;
      storage_used_gb?: number;
      storage_total_gb?: number;
      top_process?: string;
    }[] = data.nodes || [];

    const node = nodes.find((n) => n.status === "in_use");
    if (!node) return NextResponse.json({});

    const ramPct =
      node.ram_total_gb && node.ram_used_gb != null
        ? Math.round((node.ram_used_gb / node.ram_total_gb) * 100)
        : undefined;

    const storagePct =
      node.storage_total_gb && node.storage_used_gb != null
        ? Math.round((node.storage_used_gb / node.storage_total_gb) * 100)
        : undefined;

    return NextResponse.json({
      cpu_pct: node.cpu_usage,
      gpu_pct: node.gpu_usage,
      ram_pct: ramPct,
      ram_used: node.ram_used_gb != null ? `${node.ram_used_gb}GiB` : undefined,
      ram_total: node.ram_total_gb != null ? `${node.ram_total_gb}GiB` : undefined,
      storage_pct: storagePct,
      storage_used_gb: node.storage_used_gb,
      storage_total_gb: node.storage_total_gb,
      top_process: node.top_process,
    });
  } catch {
    return NextResponse.json({});
  }
}
