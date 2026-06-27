"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const ERROR_MESSAGES: Record<string, string> = {
  domain: "학교 계정(@ts.hs.kr)으로만 로그인할 수 있습니다.",
  unverified: "이메일 인증이 완료되지 않은 계정입니다.",
  state: "로그인 세션이 만료되었습니다. 다시 시도해 주세요.",
  oauth: "Google 인증에 실패했습니다. 다시 시도해 주세요.",
  config: "로그인 설정이 아직 완료되지 않았습니다. 관리자에게 문의하세요.",
};

function LoginCard() {
  const params = useSearchParams();
  const errorKey = params.get("error");
  const error = errorKey ? ERROR_MESSAGES[errorKey] || "로그인에 실패했습니다." : null;

  return (
    <div className="glass glass-strong fade-in" style={card}>
      <div style={logoWrap}>
        <div style={logoBadge}>🖥️</div>
      </div>

      <h1 style={title}>PC 대여 포털</h1>
      <p style={subtitle}>
        학교 전산실의 GPU 데스크톱을
        <br />
        브라우저에서 바로 사용하세요.
      </p>

      {error && (
        <div style={errorBox} className="fade-in">
          <span style={{ fontSize: "16px" }}>⚠️</span>
          <span>{error}</span>
        </div>
      )}

      <a href="/api/auth/google" className="btn btn-google btn-block" style={{ marginTop: "8px" }}>
        <GoogleIcon />
        Google 계정으로 로그인
      </a>

      <div style={hintBox}>
        <span style={{ color: "var(--text-faint)" }}>학생 계정</span>
        <span style={{ fontWeight: 600 }}>@ts.hs.kr</span>
        <span style={{ color: "var(--text-faint)" }}>전용</span>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="page center">
      <Suspense>
        <LoginCard />
      </Suspense>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

const card: React.CSSProperties = {
  width: "100%",
  maxWidth: "400px",
  padding: "44px 36px 32px",
  textAlign: "center",
};
const logoWrap: React.CSSProperties = {
  display: "flex",
  justifyContent: "center",
  marginBottom: "18px",
};
const logoBadge: React.CSSProperties = {
  width: "64px",
  height: "64px",
  borderRadius: "18px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "30px",
  background: "linear-gradient(135deg, rgba(124,140,255,0.35), rgba(99,102,241,0.18))",
  border: "1px solid var(--glass-border-strong)",
  boxShadow: "0 8px 24px -8px var(--accent-glow)",
};
const title: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: "26px",
  fontWeight: 800,
  letterSpacing: "-0.5px",
};
const subtitle: React.CSSProperties = {
  margin: "0 0 26px",
  color: "var(--text-dim)",
  fontSize: "14.5px",
  lineHeight: 1.6,
};
const errorBox: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "9px",
  textAlign: "left",
  fontSize: "13.5px",
  color: "#fecdd3",
  background: "rgba(244,63,94,0.12)",
  border: "1px solid rgba(251,113,133,0.4)",
  borderRadius: "12px",
  padding: "12px 14px",
  marginBottom: "18px",
};
const hintBox: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "6px",
  marginTop: "22px",
  fontSize: "13px",
};
