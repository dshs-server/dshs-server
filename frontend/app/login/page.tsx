"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { signInWithPopup, GoogleAuthProvider } from "firebase/auth";
import { auth } from "@/lib/firebase";
import s from "./login.module.css";

const ERROR_MESSAGES: Record<string, string> = {
  domain: "학교 계정(@ts.hs.kr)으로만 로그인할 수 있습니다.",
  unverified: "이메일 인증이 완료되지 않은 계정입니다.",
  state: "로그인 세션이 만료되었습니다. 다시 시도해 주세요.",
  oauth: "Google 인증에 실패했습니다. 다시 시도해 주세요.",
  config: "로그인 설정이 아직 완료되지 않았습니다. 관리자에게 문의하세요.",
};

function LoginCard() {
  const params = useSearchParams();
  const router = useRouter();
  const errorKey = params.get("error");
  const [clientError, setClientError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const error = clientError ?? (errorKey ? ERROR_MESSAGES[errorKey] || "로그인에 실패했습니다." : null);

  async function handleGoogleLogin() {
    setClientError(null);
    setLoading(true);
    try {
      if (!auth) {
        setClientError(ERROR_MESSAGES["config"]);
        return;
      }
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      const idToken = await result.user.getIdToken();

      const res = await fetch("/api/auth/firebase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });

      if (!res.ok) {
        const data = await res.json();
        setClientError(ERROR_MESSAGES[data.error] || "로그인에 실패했습니다.");
        return;
      }

      router.push("/dashboard");
    } catch {
      setClientError("Google 인증에 실패했습니다. 다시 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={s.card}>
      <div className={s.wordmark}>
        <span>DSHS</span>
        <strong>전산실</strong>
      </div>

      <p className={s.subtitle}>
        학교 전산실의 GPU 데스크톱을
        <br />
        브라우저에서 바로 사용하세요.
      </p>

      {error && (
        <div className={s.error}>
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}

      <button
        className={s.googleBtn}
        onClick={handleGoogleLogin}
        disabled={loading}
      >
        <GoogleIcon />
        {loading ? "로그인 중…" : "Google 계정으로 로그인"}
      </button>

      <p className={s.hint}>
        학생 계정 <b>@ts.hs.kr</b> 전용
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className={s.root}>
      <div className={s.field} aria-hidden="true" />
      <Suspense>
        <LoginCard />
      </Suspense>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
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
