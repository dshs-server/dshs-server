import { NextResponse } from "next/server";
import crypto from "crypto";
import { getSessionEmail } from "@/lib/auth";

// 허브가 검증할 업로드 토큰을 발급한다.
// 토큰 형식: base64url(`<email>|<exp>`) + '.' + HMAC-SHA256(secret, payload_b64) (hex)
// secret 은 허브의 UPLOAD_SECRET 과 동일해야 한다 (없으면 API_KEY 재사용).
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || process.env.API_KEY || "";

// 학생 브라우저가 파일을 직접 보낼 중앙 PC(허브)의 LAN HTTPS 주소.
// 예: https://hub.dshs-app.net  (유효한 인증서 필요 — mixed content 차단 방지)
const HUB_LAN_URL = process.env.HUB_LAN_URL || "";

const TTL_SECONDS = 300; // 5분

export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  if (!UPLOAD_SECRET || !HUB_LAN_URL) {
    return NextResponse.json(
      { error: "파일 전송이 아직 설정되지 않았습니다. (HUB_LAN_URL 미설정)" },
      { status: 503 }
    );
  }

  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payloadB64 = Buffer.from(`${email}|${exp}`, "utf-8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", UPLOAD_SECRET)
    .update(payloadB64)
    .digest("hex");

  return NextResponse.json({
    token: `${payloadB64}.${sig}`,
    upload_url: HUB_LAN_URL.replace(/\/$/, ""),
    expires_at: exp,
  });
}
