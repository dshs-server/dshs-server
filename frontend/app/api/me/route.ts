import { NextResponse } from "next/server";
import { getSessionEmail, isAdminFull } from "@/lib/auth";

export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    email,
    isAdmin: await isAdminFull(email),
  });
}
