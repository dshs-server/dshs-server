"use client";

import { useRef, useState } from "react";
import { useToast } from "@/components/toast";

/**
 * 파일 업로드 버튼 — 활성 세션이 있을 때만 표시.
 *
 * 흐름:
 *  1) /api/upload-ticket 으로 서명 토큰 + 허브 LAN 주소를 받는다.
 *  2) 파일을 브라우저에서 중앙 PC(허브)로 직접 전송한다 (Vercel 우회 → 대용량 OK).
 *  3) 허브가 내 세션이 떠 있는 노드로 보내 컨테이너 바탕화면/받은파일 에 표시.
 */
export function UploadButton() {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setBusy(true);
    try {
      const ticketRes = await fetch("/api/upload-ticket", { cache: "no-store" });
      const ticket = await ticketRes.json().catch(() => ({}));
      if (!ticketRes.ok) {
        toast(ticket.error || "업로드 준비에 실패했습니다.", "error");
        return;
      }

      const fd = new FormData();
      for (const f of files) fd.append("files", f);

      const res = await fetch(`${ticket.upload_url}/upload`, {
        method: "POST",
        headers: { "x-upload-token": ticket.token },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
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
      // mixed content / 네트워크 / 학교 WiFi 밖 접속 등
      toast(
        "중앙 PC에 연결할 수 없습니다. 학교 WiFi에 연결됐는지 확인해주세요.",
        "error"
      );
    } finally {
      setBusy(false);
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
        style={{ marginBottom: "12px" }}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "전송 중…" : "📤 내 PC로 파일 보내기"}
      </button>
    </>
  );
}
