"use client";

import { useRef, useState } from "react";
import { useToast } from "@/components/toast";

const MAX_BYTES = 100 * 1024 * 1024; // Cloudflare 무료 플랜 100MB 한도

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
    // 속도 평활화용 ring buffer
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

/**
 * 파일 업로드 버튼 — 활성 세션이 있을 때만 표시.
 *
 * 흐름:
 *  1) /api/upload-ticket 으로 서명 토큰을 받는다.
 *  2) 파일을 브라우저에서 허브(hub.dshs-app.net)로 직접 전송한다 (Vercel 우회 → 대용량 OK).
 *  3) 허브가 내 세션이 떠 있는 노드로 SSH 전송 → 컨테이너 바탕화면/받은파일 에 표시.
 */
export function UploadButton() {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState(0);
  const [speedBps, setSpeedBps] = useState(0);
  const [etaSec, setEtaSec] = useState(Infinity);
  const [busy, setBusy] = useState(false);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);

    const totalBytes = files.reduce((s, f) => s + f.size, 0);
    if (totalBytes > MAX_BYTES) {
      toast(
        `파일 크기가 너무 큽니다 (최대 100 MB). 현재 ${(totalBytes / 1024 / 1024).toFixed(1)} MB.`,
        "error"
      );
      return;
    }

    setBusy(true);
    setPct(0);
    setSpeedBps(0);
    setEtaSec(Infinity);

    try {
      const ticketRes = await fetch("/api/upload-ticket", { cache: "no-store" });
      const ticket = await ticketRes.json().catch(() => ({}));
      if (!ticketRes.ok) {
        toast(ticket.error || "업로드 준비에 실패했습니다.", "error");
        return;
      }

      const fd = new FormData();
      for (const f of files) fd.append("files", f);

      const result = await xhrUpload(
        `${ticket.upload_url}/upload`,
        { "x-upload-token": ticket.token },
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
        return;
      }

      const n = data.count ?? files.length;
      toast(
        data.live === false
          ? `${n}개 파일 전송됨 — 다음 접속 시 바탕화면에 표시됩니다.`
          : `${n}개 파일을 내 PC 바탕화면 '받은파일'로 보냈습니다.`,
        "success"
      );
    } catch {
      toast("파일 전송에 실패했습니다. 네트워크 연결을 확인해주세요.", "error");
    } finally {
      setBusy(false);
      setPct(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

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
        {busy ? "전송 중…" : "📤 내 PC로 파일 보내기"}
      </button>

      {busy && (
        <div style={{ marginBottom: "12px", padding: "0 4px" }}>
          {/* 진행 바 */}
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
          {/* 속도 / 남은 시간 */}
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
    </>
  );
}
