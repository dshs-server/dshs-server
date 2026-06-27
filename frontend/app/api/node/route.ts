import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL!;
const API_KEY = process.env.API_KEY!;

const STATIC_SPECS = {
  cpu: "Intel Core i7",
  gpu: "NVIDIA GTX 1660",
  ram_gb: 32,
  storage_gb: 500,
};

export async function GET() {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "로그인 필요" }, { status: 401 });

  try {
    const res = await fetch(`${BACKEND_URL}/node_specs`, {
      headers: { "x-api-key": API_KEY },
      cache: "no-store",
    });
    if (res.ok) return NextResponse.json(await res.json());
  } catch {
    // fall through to static
  }
  return NextResponse.json(STATIC_SPECS);
}
