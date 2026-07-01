"use client";

import { useRef, useState } from "react";
import { useToast } from "@/components/toast";
import { ConfirmSheet } from "@/app/portal/ui";

const MAX_BYTES = 100 * 1024 * 1024; // Cloudflare 무료 플랜 100MB 한도
const LAN_TIMEOUT_MS = 3000;

function fmtSpeed(bps: number) {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

function fmtEta(sec: number) {
  if (!isFinite(sec) || sec <= 0) return "";
  if (sec < 60) return `${Math.ceil(sec)}초`;
  return `${Math.floor(sec / 60)}분 ${Math.ceil(sec % 60)}초`;
}

async function checkLanReachable(lanUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), LAN_TIMEOUT_MS);
  try {
    await fetch(`${lanUrl}/health`, { signal: controller.signal, mode: "no-cors" });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(tid);
  }
}

function xhrUpload(
  url: string,
  headers: Record<string, string>,
  body: FormData,
  onProgress: (pct: number, speedBps: number, etaSec: number) => void
): Promise<{ ok: boolean; status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastLoaded = 0;
    let lastTs = Date.now();
    const speedSamples: number[] = [];

    xhr.upload.addEventListener("progress", (e) => {
      if (!e.lengthComputable) return;
      const now = Date.now();
      const dt = (now - lastTs) / 1000;
      if (dt > 0.1) {
        const instantBps = (e.loaded - lastLoaded) / dt;
        speedSamples.push(instantBps);
        if (speedSamples.length > 6) speedSamples.shift();
        const avgBps =
          speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
        const eta = avgBps > 0 ? (e.total - e.loaded) / avgBps : Infinity;
        onProgress((e.loaded / e.total) * 100, avgBps, eta);
        lastLoaded = e.loaded;
        lastTs = now;
      }
    });

    xhr.addEventListener("load", () => {
      resolve({ ok: xhr.status < 400, status: xhr.status, text: xhr.responseText });
    });
    xhr.addEventListener("error", () => reject(new Error("network")));
    xhr.addEventListener("abort", () => reject(new Error("aborted")));

    xhr.open("POST", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.send(body);
  });
}

type Phase = "idle" | "checking" | "uploading";

interface FallbackState {
  fd: FormData;
  token: string;
  cloudflareUrl: string;
  totalBytes: number;
}

/**
 * 파일 업로드 버튼 — 활성 세션이 있을 때만 표시.
 *
 * 흐름:
 *  1) /api/upload-ticket 으로 서명 토큰을 받는다.
 *  2a) lan_url이 있으면 3초 내 연결 확인 → 성공 시 LAN 직접 업로드 (용량 무제한).
 *  2b) LAN 연결 실패 시 → 사용자에게 Cloudflare(100 MB 제한) 경유 여부 선택 제공.
 *  2c) lan_url 없으면 → Cloudflare(100 MB 제한) 직행.
 *  3) 허브가 내 세션이 떠 있는 노드로 SSH 전송 → 컨테이너 바탕화면/받은파일에 표시.
 */
export function UploadButton() {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pct, setPct] = useState(0);
  const [speedBps, setSpeedBps] = useState(0);
  const [etaSec, setEtaSec] = useState(Infinity);
  const [fallback, setFallback] = useState<FallbackState | null>(null);

  function resetInput() {
    if (inputRef.current) inputRef.current.value = "";
  }

  async function runUpload(uploadUrl: string, token: string, fd: FormData) {
    setPhase("uploading");
    setPct(0);
    setSpeedBps(0);
    setEtaSec(Infinity);
    try {
      const result = await xhrUpload(
        `${uploadUrl}/upload`,
        { "x-upload-token": token },
        fd,
        (p, spd, eta) => {
          setPct(p);
          setSpeedBps(spd);
          setEtaSec(eta);
        }
      );
      const data = JSON.parse(result.text || "{}");
      if (!result.ok) {
        toast(data.detail || data.error || "전송에 실패했습니다.", "error");
      } else {
        const n = data.count ?? "?";
        toast(
          data.live === false
            ? `${n}개 파일 전송됨 — 다음 접속 시 바탕화면에 표시됩니다.`
            : `${n}개 파일을 내 PC 바탕화면 '받은파일'로 보냈습니다.`,
          "success"
        );
      }
    } catch {
      toast("파일 전송에 실패했습니다. 네트워크 연결을 확인해주세요.", "error");
    } finally {
      setPhase("idle");
      setPct(0);
      resetInput();
    }
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const totalBytes = files.reduce((s, f) => s + f.size, 0);

    setPhase("checking");

    let ticket: {
      token?: string;
      upload_url?: string;
      lan_url?: string;
      error?: string;
    } = {};
    try {
      const ticketRes = await fetch("/api/upload-ticket", { cache: "no-store" });
      ticket = await ticketRes.json().catch(() => ({}));
      if (!ticketRes.ok) {
        toast(ticket.error || "업로드 준비에 실패했습니다.", "error");
        setPhase("idle");
        return;
      }
    } catch {
      toast("업로드 준비에 실패했습니다.", "error");
      setPhase("idle");
      return;
    }

    const fd = new FormData();
    for (const f of files) fd.append("files", f);

    const lanUrl = ticket.lan_url;
    const cloudflareUrl = ticket.upload_url!;
    const token = ticket.token!;

    if (lanUrl) {
      const lanOk = await checkLanReachable(lanUrl);
      if (lanOk) {
        await runUpload(lanUrl, token, fd);
        return;
      }
      // LAN 미연결 → 사용자 선택 대기
      setPhase("idle");
      setFallback({ fd, token, cloudflareUrl, totalBytes });
      resetInput();
      return;
    }

    // LAN URL 없음 → Cloudflare 직행
    if (totalBytes > MAX_BYTES) {
      toast(
        `파일 크기가 너무 큽니다 (최대 100 MB). 현재 ${(totalBytes / 1024 / 1024).toFixed(1)} MB.`,
        "error"
      );
      setPhase("idle");
      resetInput();
      return;
    }
    await runUpload(cloudflareUrl, token, fd);
  }

  async function handleFallbackConfirm() {
    if (!fallback) return;
    const { fd, token, cloudflareUrl, totalBytes } = fallback;
    setFallback(null);
    if (totalBytes > MAX_BYTES) {
      toast(
        `파일 크기가 너무 큽니다 (최대 100 MB). 현재 ${(totalBytes / 1024 / 1024).toFixed(1)} MB.`,
        "error"
      );
      return;
    }
    await runUpload(cloudflareUrl, token, fd);
  }

  const busy = phase !== "idle";
  const mbStr = fallback
    ? (fallback.totalBytes / 1024 / 1024).toFixed(1)
    : "0";
  const overLimit = fallback ? fallback.totalBytes > MAX_BYTES : false;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
      <button
        className="btn btn-ghost btn-block"
        style={{ marginBottom: busy ? "8px" : "12px" }}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {phase === "checking"
          ? "연결 확인 중…"
          : phase === "uploading"
          ? "전송 중…"
          : "📤 내 PC로 파일 보내기"}
      </button>

      {phase === "uploading" && (
        <div style={{ marginBottom: "12px", padding: "0 4px" }}>
          <div
            style={{
              height: "6px",
              borderRadius: "3px",
              background: "rgba(255,255,255,0.12)",
              overflow: "hidden",
              marginBottom: "6px",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                borderRadius: "3px",
                background: "var(--color-accent, #7c6cdc)",
                transition: "width 0.2s ease",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "11px",
              opacity: 0.6,
            }}
          >
            <span>{pct > 0 ? `${pct.toFixed(0)}%` : "연결 중…"}</span>
            <span>
              {speedBps > 0 && fmtSpeed(speedBps)}
              {etaSec < Infinity && speedBps > 0 && ` · ${fmtEta(etaSec)} 남음`}
            </span>
          </div>
        </div>
      )}

      {fallback && (
        <ConfirmSheet
          title="WiFi 공유기에 연결되지 않았습니다"
          message={
            `학교 WiFi 공유기를 통한 연결에 실패했습니다.\n` +
            `인터넷(Cloudflare)을 통해 업로드하면 최대 100 MB까지 전송 가능합니다.\n\n` +
            `현재 파일 크기: ${mbStr} MB` +
            (overLimit ? "\n⚠️ 100 MB 초과 — 인터넷 업로드도 불가합니다." : "")
          }
          confirmLabel="인터넷으로 업로드"
          onConfirm={handleFallbackConfirm}
          onCancel={() => setFallback(null)}
        />
      )}
    </>
  );
}
