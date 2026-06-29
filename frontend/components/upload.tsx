"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/toast";

type ItemStatus =
  | "pending"
  | "uploading"
  | "processing"
  | "done"
  | "error"
  | "cancelled";

interface UploadItem {
  id: string;
  file: File;
  loaded: number;
  status: ItemStatus;
  error?: string;
  chunkCurrent?: number;
  chunkTotal?: number;
}

interface UploadTicket {
  token: string;
  upload_url: string;
  expires_at: number;
}

interface UploadResult {
  count?: number;
  live?: boolean;
  detail?: string;
  error?: string;
}

interface TransferStats {
  loaded: number;
  total: number;
  speed: number;
  elapsed: number;
  remaining: number | null;
}

interface WakeLockHandle {
  release: () => Promise<void>;
}

interface ActiveUpload {
  uploadId: string;
  ticket: UploadTicket | null;
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// Cloudflare 단일 요청 제한보다 작은 조각으로 자동 전송한다. Hub 설정과 같아야 한다.
const UPLOAD_CHUNK_BYTES = 64 * MiB;
const LARGE_TRANSFER_BYTES = 2 * GiB;
const MANUAL_SPLIT_RECOMMEND_BYTES = 10 * GiB;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  const digits = unit <= 1 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "계산 중";
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}초`;
  const minutes = Math.floor(rounded / 60);
  const secs = rounded % 60;
  if (minutes < 60) return `${minutes}분 ${secs}초`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}시간 ${mins}분`;
}

function itemLabel(status: ItemStatus): string {
  return {
    pending: "대기",
    uploading: "전송 중",
    processing: "PC로 전달 중",
    done: "완료",
    error: "실패",
    cancelled: "취소됨",
  }[status];
}

function parseJson(xhr: XMLHttpRequest): UploadResult {
  try {
    return JSON.parse(xhr.responseText || "{}");
  } catch {
    return {};
  }
}

function makeUploadId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requestUploadTicket(): Promise<UploadTicket> {
  const response = await fetch("/api/upload-ticket", { cache: "no-store" });
  const data = (await response.json().catch(() => ({}))) as Partial<UploadTicket> & {
    error?: string;
  };
  if (!response.ok || !data.token || !data.upload_url || !data.expires_at) {
    throw new Error(data.error || "업로드 준비에 실패했습니다.");
  }
  return data as UploadTicket;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** XMLHttpRequest를 써야 브라우저가 실제 업로드 바이트 진행률을 알려준다. */
function uploadChunk(
  ticket: UploadTicket,
  file: File,
  blob: Blob,
  uploadId: string,
  chunkIndex: number,
  chunkCount: number,
  onProgress: (loaded: number) => void,
  onXhr: (xhr: XMLHttpRequest) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onXhr(xhr);
    xhr.open("POST", `${ticket.upload_url.replace(/\/$/, "")}/upload/chunk`);
    xhr.setRequestHeader("x-upload-token", ticket.token);
    xhr.setRequestHeader("x-upload-id", uploadId);
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("x-chunk-index", String(chunkIndex));
    xhr.setRequestHeader("x-chunk-count", String(chunkCount));
    xhr.setRequestHeader("x-file-size", String(file.size));
    xhr.setRequestHeader("content-type", "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.min(event.loaded, blob.size));
    };
    xhr.onload = () => {
      const data = parseJson(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(blob.size);
        resolve();
        return;
      }
      if (xhr.status === 413) {
        reject(
          new Error(
            "파일 조각이 중계 서버 제한을 넘었습니다. 관리자에게 조각 크기 설정을 확인해주세요.",
          ),
        );
        return;
      }
      reject(new Error(data.detail || data.error || `전송에 실패했습니다. (${xhr.status})`));
    };
    xhr.onerror = () =>
      reject(
        new Error(
          "중앙 PC 연결이 끊겼습니다. 학교 WiFi와 VPN 상태를 확인한 뒤 다시 시도해주세요.",
        ),
      );
    xhr.onabort = () => reject(new DOMException("사용자가 전송을 취소했습니다.", "AbortError"));

    xhr.send(blob);
  });
}

async function finishUpload(
  ticket: UploadTicket,
  file: File,
  uploadId: string,
  chunkCount: number,
): Promise<UploadResult> {
  const response = await fetch(`${ticket.upload_url.replace(/\/$/, "")}/upload/complete`, {
    method: "POST",
    headers: {
      "x-upload-token": ticket.token,
      "x-upload-id": uploadId,
      "x-file-name": encodeURIComponent(file.name),
      "x-chunk-count": String(chunkCount),
      "x-file-size": String(file.size),
    },
  });
  const data = (await response.json().catch(() => ({}))) as UploadResult;
  if (!response.ok) {
    throw new Error(data.detail || data.error || `파일 마무리에 실패했습니다. (${response.status})`);
  }
  return data;
}

async function discardUpload(
  ticket: UploadTicket | null,
  uploadId: string,
): Promise<void> {
  try {
    let current = ticket ?? (await requestUploadTicket());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${current.upload_url.replace(/\/$/, "")}/upload/chunk`, {
        method: "DELETE",
        headers: {
          "x-upload-token": current.token,
          "x-upload-id": uploadId,
        },
      });
      if (response.ok) return;
      if (response.status !== 401) return;
      current = await requestUploadTicket();
    }
  } catch {
    // 네트워크가 끊긴 경우 Hub의 24시간 정리 작업이 임시 파일을 제거한다.
  }
}

/**
 * 활성 세션으로 파일을 보내는 대용량 전송 UI.
 * 파일을 순차 전송해 한 파일의 실패가 전체 큐를 망가뜨리지 않게 하고,
 * 매 파일마다 새 티켓을 받아 긴 대기열에서도 토큰 만료를 피한다.
 */
export function UploadButton({ availableStorageGb }: { availableStorageGb?: number }) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const activeXhrRef = useRef<XMLHttpRequest | null>(null);
  const activeUploadRef = useRef<ActiveUpload | null>(null);
  const cancelledRef = useRef(false);
  const wakeLockRef = useRef<WakeLockHandle | null>(null);
  const startedAtRef = useRef(0);
  const speedSamplesRef = useRef<Array<{ at: number; loaded: number }>>([]);
  const latestStatsRef = useRef<TransferStats>({
    loaded: 0,
    total: 0,
    speed: 0,
    elapsed: 0,
    remaining: null,
  });

  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [stats, setStats] = useState<TransferStats>(latestStatsRef.current);

  const totalBytes = useMemo(
    () => items.reduce((sum, item) => sum + item.file.size, 0),
    [items],
  );
  const oversizedItems = useMemo(
    () => items.filter((item) => item.file.size > MANUAL_SPLIT_RECOMMEND_BYTES),
    [items],
  );
  const doneCount = items.filter((item) => item.status === "done").length;
  const failedCount = items.filter((item) => item.status === "error").length;
  const allDone = items.length > 0 && doneCount === items.length;
  const progress = stats.total > 0 ? Math.min(100, (stats.loaded / stats.total) * 100) : 0;
  const availableStorageBytes =
    availableStorageGb === undefined ? null : Math.max(0, availableStorageGb) * GiB;
  const storageRisk =
    availableStorageBytes !== null && totalBytes > availableStorageBytes;

  useEffect(() => {
    if (!busy) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [busy]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      const current = latestStatsRef.current;
      const elapsed = Math.max(0, (Date.now() - startedAtRef.current) / 1000);
      const remaining =
        current.speed > 0 ? Math.max(0, (current.total - current.loaded) / current.speed) : null;
      const next = { ...current, elapsed, remaining };
      latestStatsRef.current = next;
      setStats(next);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(
    () => () => {
      activeXhrRef.current?.abort();
      const active = activeUploadRef.current;
      if (active) void discardUpload(active.ticket, active.uploadId);
    },
    [],
  );

  function updateItem(id: string, update: Partial<UploadItem>) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...update } : item)),
    );
  }

  function selectFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || busy) return;
    const next = Array.from(fileList).map((file, index) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
      file,
      loaded: 0,
      status: "pending" as const,
    }));
    setItems(next);
    setHasStarted(false);
    const total = next.reduce((sum, item) => sum + item.file.size, 0);
    const initial = { loaded: 0, total, speed: 0, elapsed: 0, remaining: null };
    latestStatsRef.current = initial;
    setStats(initial);
    if (inputRef.current) inputRef.current.value = "";
  }

  function recordProgress(loaded: number, total: number) {
    const now = Date.now();
    const samples = speedSamplesRef.current;
    samples.push({ at: now, loaded });
    while (samples.length > 2 && now - samples[0].at > 8000) samples.shift();

    const first = samples[0];
    const spanSeconds = first ? (now - first.at) / 1000 : 0;
    const speed = spanSeconds >= 0.4 ? Math.max(0, (loaded - first.loaded) / spanSeconds) : 0;
    const elapsed = Math.max(0, (now - startedAtRef.current) / 1000);
    const remaining = speed > 0 ? Math.max(0, (total - loaded) / speed) : null;
    const next = { loaded, total, speed, elapsed, remaining };
    latestStatsRef.current = next;
    setStats(next);
  }

  async function requestWakeLock() {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (kind: "screen") => Promise<WakeLockHandle> };
      };
      wakeLockRef.current = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {
      // 지원하지 않거나 권한이 없어도 전송 자체에는 영향이 없다.
    }
  }

  async function releaseWakeLock() {
    try {
      await wakeLockRef.current?.release();
    } catch {
      // 이미 해제된 경우 무시한다.
    } finally {
      wakeLockRef.current = null;
    }
  }

  async function startUpload() {
    if (busy || items.length === 0) return;
    const queue = items.filter((item) => item.status !== "done");
    if (queue.length === 0) return;

    cancelledRef.current = false;
    setBusy(true);
    setHasStarted(true);
    setItems((current) =>
      current.map((item) =>
        item.status === "done"
          ? item
          : {
              ...item,
              loaded: 0,
              status: "pending",
              error: undefined,
              chunkCurrent: undefined,
              chunkTotal: undefined,
            },
      ),
    );

    const completedBeforeRun = items
      .filter((item) => item.status === "done")
      .reduce((sum, item) => sum + item.file.size, 0);
    const runTotal = items.reduce((sum, item) => sum + item.file.size, 0);
    startedAtRef.current = Date.now();
    speedSamplesRef.current = [{ at: startedAtRef.current, loaded: completedBeforeRun }];
    recordProgress(completedBeforeRun, runTotal);
    await requestWakeLock();

    let completedBytes = completedBeforeRun;
    let successes = 0;
    let lastResult: UploadResult | null = null;

    try {
      for (const item of queue) {
        if (cancelledRef.current) break;
        updateItem(item.id, { status: "uploading", loaded: 0, error: undefined });

        try {
          const uploadId = makeUploadId();
          const chunkCount = Math.max(1, Math.ceil(item.file.size / UPLOAD_CHUNK_BYTES));
          let ticket: UploadTicket | null = null;
          activeUploadRef.current = { uploadId, ticket };

          const freshTicket = async (force = false) => {
            if (
              force ||
              !ticket ||
              ticket.expires_at * 1000 - Date.now() < 30_000
            ) {
              ticket = await requestUploadTicket();
              activeUploadRef.current = { uploadId, ticket };
            }
            return ticket as UploadTicket;
          };

          try {
            for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
              if (cancelledRef.current) {
                throw new DOMException("사용자가 전송을 취소했습니다.", "AbortError");
              }
              const chunkStart = chunkIndex * UPLOAD_CHUNK_BYTES;
              updateItem(item.id, {
                chunkCurrent: chunkIndex + 1,
                chunkTotal: chunkCount,
              });
              const chunk = item.file.slice(
                chunkStart,
                Math.min(item.file.size, chunkStart + UPLOAD_CHUNK_BYTES),
              );

              let sent = false;
              let lastError: unknown = null;
              for (let attempt = 0; attempt < 3 && !sent; attempt += 1) {
                try {
                  const currentTicket = await freshTicket(attempt > 0);
                  await uploadChunk(
                    currentTicket,
                    item.file,
                    chunk,
                    uploadId,
                    chunkIndex,
                    chunkCount,
                    (chunkLoaded) => {
                      const fileLoaded = Math.min(item.file.size, chunkStart + chunkLoaded);
                      updateItem(item.id, { loaded: fileLoaded });
                      recordProgress(completedBytes + fileLoaded, runTotal);
                    },
                    (xhr) => {
                      activeXhrRef.current = xhr;
                    },
                  );
                  sent = true;
                } catch (error) {
                  lastError = error;
                  if (error instanceof DOMException && error.name === "AbortError") throw error;
                  if (attempt < 2) await wait(800 * (attempt + 1));
                } finally {
                  activeXhrRef.current = null;
                }
              }
              if (!sent) throw lastError;
            }

            updateItem(item.id, { status: "processing", loaded: item.file.size });
            lastResult = await finishUpload(
              await freshTicket(),
              item.file,
              uploadId,
              chunkCount,
            );
            activeUploadRef.current = null;
          } catch (error) {
            await discardUpload(ticket, uploadId);
            activeUploadRef.current = null;
            throw error;
          }

          completedBytes += item.file.size;
          successes += 1;
          updateItem(item.id, { status: "done", loaded: item.file.size });
          recordProgress(completedBytes, runTotal);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            updateItem(item.id, { status: "cancelled", error: "사용자가 취소했습니다." });
            break;
          }
          const message = error instanceof Error ? error.message : "전송에 실패했습니다.";
          updateItem(item.id, { status: "error", error: message });
          toast(message, "error");
          // 같은 네트워크 문제로 나머지 대용량 파일까지 연속 실패하지 않도록 멈춘다.
          break;
        } finally {
          activeXhrRef.current = null;
          activeUploadRef.current = null;
        }
      }

      if (cancelledRef.current) {
        toast("파일 전송을 취소했습니다.", "info");
      } else if (successes === queue.length) {
        toast(
          lastResult?.live === false
            ? `${successes}개 파일 전송 완료 — 다음 접속 시 바탕화면에 표시됩니다.`
            : `${successes}개 파일을 바탕화면 '받은파일'로 보냈습니다.`,
          "success",
        );
      }
    } finally {
      setBusy(false);
      await releaseWakeLock();
    }
  }

  function cancelUpload() {
    cancelledRef.current = true;
    const active = activeUploadRef.current;
    activeXhrRef.current?.abort();
    if (active) {
      void wait(300).then(() => discardUpload(active.ticket, active.uploadId));
    }
  }

  function reset() {
    if (busy) return;
    setItems([]);
    setHasStarted(false);
    const initial = { loaded: 0, total: 0, speed: 0, elapsed: 0, remaining: null };
    latestStatsRef.current = initial;
    setStats(initial);
  }

  return (
    <div className="upload-shell">
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => selectFiles(event.target.files)}
      />

      {items.length === 0 ? (
        <button
          className="btn btn-ghost btn-block upload-pick"
          onClick={() => inputRef.current?.click()}
        >
          <span className="upload-pick-icon">⇧</span>
          <span>
            <strong>내 PC로 파일 보내기</strong>
            <small>진행률과 남은 시간을 확인할 수 있어요</small>
          </span>
        </button>
      ) : (
        <div className="glass upload-panel">
          <div className="upload-heading">
            <div>
              <div className="upload-eyebrow">FILE TRANSFER</div>
              <strong>{items.length}개 파일 · {formatBytes(totalBytes)}</strong>
            </div>
            <span className={`upload-state ${busy ? "is-live" : allDone ? "is-done" : ""}`}>
              {busy ? "● 전송 중" : allDone ? "✓ 완료" : hasStarted ? "이어 보내기" : "전송 준비"}
            </span>
          </div>

          {oversizedItems.length > 0 && (
            <div className="upload-warning" role="alert">
              <span>⚠</span>
              <div>
                <strong>큰 파일은 분할 압축을 권장합니다</strong>
                <p>
                  {formatBytes(MANUAL_SPLIT_RECOMMEND_BYTES)}를 넘는 파일이 {oversizedItems.length}개 있습니다.
                  전송 자체는 64MB 조각으로 자동 처리되지만, 브라우저가 닫히면 큰 파일을 처음부터
                  다시 보내야 합니다. 가능하면 7-Zip 등으로 2~5GB 단위 분할 압축을 권장합니다.
                </p>
              </div>
            </div>
          )}

          {storageRisk && availableStorageBytes !== null && (
            <div className="upload-warning upload-danger" role="alert">
              <span>⛔</span>
              <div>
                <strong>노드 저장공간이 부족할 수 있습니다</strong>
                <p>
                  선택한 파일은 {formatBytes(totalBytes)}인데 현재 표시된 여유 공간은 약
                  {" "}{formatBytes(availableStorageBytes)}입니다. 불필요한 파일을 지우거나
                  전송 용량을 줄인 뒤 다시 시도해주세요.
                </p>
              </div>
            </div>
          )}

          {totalBytes >= LARGE_TRANSFER_BYTES && (
            <div className="upload-tip">
              <span>☕</span>
              <span>
                장시간 전송입니다. 이 탭을 닫지 말고 전원을 연결하세요. 전송 중에는 화면 절전을
                가능한 범위에서 자동으로 막습니다.
              </span>
            </div>
          )}

          {totalBytes > UPLOAD_CHUNK_BYTES && (
            <div className="upload-protection">
              <span>🛡</span>
              64MB 자동 분할 전송 · 실패한 조각 최대 3회 자동 재시도
            </div>
          )}

          {(hasStarted || busy) && (
            <div className="upload-progress-card">
              <div className="upload-progress-top">
                <div>
                  <span className="upload-percent">{progress.toFixed(progress < 10 ? 1 : 0)}%</span>
                  <span className="upload-byte-count">
                    {formatBytes(stats.loaded)} / {formatBytes(stats.total)}
                  </span>
                </div>
                {busy && <span className="upload-eta">약 {stats.remaining === null ? "계산 중…" : formatDuration(stats.remaining)} 남음</span>}
              </div>
              <div className="upload-track" aria-label={`전송 진행률 ${Math.round(progress)}%`}>
                <div className={`upload-fill ${busy ? "is-moving" : ""}`} style={{ width: `${progress}%` }} />
              </div>
              <div className="upload-metrics">
                <div><span>전송 속도</span><strong>{stats.speed > 0 ? `${formatBytes(stats.speed)}/s` : "측정 중"}</strong></div>
                <div><span>경과 시간</span><strong>{formatDuration(stats.elapsed)}</strong></div>
                <div><span>완료</span><strong>{doneCount} / {items.length}개</strong></div>
                <div><span>남은 시간</span><strong>{stats.remaining === null ? "계산 중" : formatDuration(stats.remaining)}</strong></div>
              </div>
            </div>
          )}

          <div className="upload-list">
            {items.map((item) => {
              const itemProgress = item.file.size > 0 ? (item.loaded / item.file.size) * 100 : 0;
              return (
                <div className={`upload-item status-${item.status}`} key={item.id}>
                  <div className="upload-file-icon">{item.status === "done" ? "✓" : item.status === "error" ? "!" : "↥"}</div>
                  <div className="upload-file-main">
                    <div className="upload-file-line">
                      <span title={item.file.name}>{item.file.name}</span>
                      <em>{formatBytes(item.file.size)}</em>
                    </div>
                    {(item.status === "uploading" || item.status === "processing") && (
                      <div className="upload-mini-track">
                        <div style={{ width: `${itemProgress}%` }} />
                      </div>
                    )}
                    {item.error && <p className="upload-file-error">{item.error}</p>}
                  </div>
                  <span className="upload-item-status">
                    {item.status === "uploading" && item.chunkTotal && item.chunkTotal > 1
                      ? `${item.chunkCurrent} / ${item.chunkTotal}`
                      : itemLabel(item.status)}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="upload-actions">
            {busy ? (
              <button className="btn btn-danger btn-block" onClick={cancelUpload}>
                전송 취소
              </button>
            ) : allDone ? (
              <button className="btn btn-primary btn-block" onClick={reset}>
                다른 파일 보내기
              </button>
            ) : (
              <>
                <button className="btn btn-primary" onClick={startUpload}>
                  {failedCount > 0 || hasStarted ? "남은 파일 다시 보내기" : "전송 시작"}
                </button>
                <button className="btn btn-ghost" onClick={() => inputRef.current?.click()}>
                  다시 선택
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <style jsx>{`
        .upload-shell { margin-bottom: 14px; }
        .upload-pick { min-height: 66px; text-align: left; }
        .upload-pick-icon {
          width: 36px; height: 36px; display: grid; place-items: center; border-radius: 11px;
          background: linear-gradient(135deg, rgba(124,140,255,.28), rgba(99,102,241,.12));
          border: 1px solid rgba(124,140,255,.35); color: #c7d2fe; font-size: 22px;
        }
        .upload-pick span:last-child { display: flex; flex-direction: column; gap: 3px; }
        .upload-pick strong { font-size: 14px; }
        .upload-pick small { color: var(--text-faint); font-size: 11.5px; font-weight: 500; }
        .upload-panel { padding: 18px; overflow: hidden; }
        .upload-heading { display: flex; justify-content: space-between; align-items: center; gap: 14px; margin-bottom: 14px; }
        .upload-heading strong { display: block; font-size: 15px; margin-top: 3px; }
        .upload-eyebrow { color: var(--accent); font-size: 9.5px; font-weight: 800; letter-spacing: .14em; }
        .upload-state {
          flex-shrink: 0; padding: 5px 9px; border-radius: 999px; font-size: 10.5px; font-weight: 700;
          color: var(--text-dim); background: rgba(255,255,255,.07); border: 1px solid var(--glass-border);
        }
        .upload-state.is-live { color: #c7d2fe; border-color: rgba(124,140,255,.4); animation: uploadPulse 1.8s ease-in-out infinite; }
        .upload-state.is-done { color: #a7f3d0; border-color: rgba(52,211,153,.35); }
        .upload-warning, .upload-tip { display: flex; align-items: flex-start; gap: 10px; border-radius: 12px; padding: 12px; margin-bottom: 12px; }
        .upload-warning { background: rgba(251,191,36,.1); border: 1px solid rgba(251,191,36,.32); color: #fde68a; }
        .upload-warning.upload-danger { background: rgba(251,113,133,.09); border-color: rgba(251,113,133,.32); color: #fecdd3; }
        .upload-warning.upload-danger p { color: rgba(254,205,211,.76); }
        .upload-warning > span { font-size: 17px; }
        .upload-warning strong { font-size: 12.5px; }
        .upload-warning p { margin: 4px 0 0; font-size: 11.5px; line-height: 1.55; color: rgba(254,243,199,.75); }
        .upload-tip { background: rgba(124,140,255,.09); border: 1px solid rgba(124,140,255,.25); color: var(--text-dim); font-size: 11.5px; line-height: 1.5; }
        .upload-protection { display: flex; align-items: center; gap: 7px; color: #a7f3d0; font-size: 10.5px; font-weight: 650; margin: -2px 2px 12px; }
        .upload-progress-card { padding: 14px; border-radius: 14px; background: rgba(7,10,35,.28); border: 1px solid rgba(255,255,255,.1); margin-bottom: 12px; }
        .upload-progress-top { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-bottom: 10px; }
        .upload-percent { font-size: 25px; line-height: 1; font-weight: 850; letter-spacing: -.04em; }
        .upload-byte-count { margin-left: 9px; font-size: 10.5px; color: var(--text-faint); }
        .upload-eta { color: #c7d2fe; font-size: 11px; font-weight: 700; }
        .upload-track { height: 11px; border-radius: 99px; background: rgba(255,255,255,.09); overflow: hidden; box-shadow: inset 0 1px 3px rgba(0,0,0,.25); }
        .upload-fill { position: relative; height: 100%; min-width: 0; border-radius: inherit; background: linear-gradient(90deg, #6366f1, #8b5cf6 50%, #60a5fa); box-shadow: 0 0 18px rgba(124,140,255,.55); transition: width .25s ease-out; overflow: hidden; }
        .upload-fill.is-moving::after { content: ""; position: absolute; inset: 0; background: linear-gradient(110deg, transparent 20%, rgba(255,255,255,.35) 45%, transparent 70%); animation: uploadShine 1.5s linear infinite; }
        .upload-metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; margin-top: 12px; }
        .upload-metrics div { min-width: 0; padding: 8px; border-radius: 9px; background: rgba(255,255,255,.045); }
        .upload-metrics span, .upload-metrics strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .upload-metrics span { color: var(--text-faint); font-size: 9.5px; margin-bottom: 3px; }
        .upload-metrics strong { font-size: 11px; }
        .upload-list { display: flex; flex-direction: column; gap: 6px; max-height: 236px; overflow: auto; padding-right: 2px; }
        .upload-item { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border-radius: 11px; background: rgba(255,255,255,.045); border: 1px solid transparent; }
        .upload-item.status-uploading, .upload-item.status-processing { border-color: rgba(124,140,255,.28); background: rgba(124,140,255,.075); }
        .upload-item.status-done { border-color: rgba(52,211,153,.18); }
        .upload-item.status-error { border-color: rgba(251,113,133,.28); background: rgba(251,113,133,.06); }
        .upload-file-icon { flex: 0 0 27px; width: 27px; height: 27px; display: grid; place-items: center; border-radius: 8px; background: rgba(124,140,255,.14); color: #c7d2fe; font-size: 13px; font-weight: 800; }
        .status-done .upload-file-icon { background: rgba(52,211,153,.13); color: #6ee7b7; }
        .status-error .upload-file-icon { background: rgba(251,113,133,.13); color: #fda4af; }
        .upload-file-main { min-width: 0; flex: 1; }
        .upload-file-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .upload-file-line span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-weight: 650; }
        .upload-file-line em { flex-shrink: 0; color: var(--text-faint); font-size: 9.5px; font-style: normal; }
        .upload-mini-track { height: 3px; border-radius: 9px; background: rgba(255,255,255,.08); overflow: hidden; margin-top: 6px; }
        .upload-mini-track div { height: 100%; background: linear-gradient(90deg, var(--accent), #60a5fa); transition: width .2s linear; }
        .upload-file-error { color: #fda4af; font-size: 9.5px; line-height: 1.4; margin: 4px 0 0; }
        .upload-item-status { flex-shrink: 0; color: var(--text-faint); font-size: 9.5px; font-weight: 700; }
        .status-uploading .upload-item-status, .status-processing .upload-item-status { color: #c7d2fe; }
        .status-done .upload-item-status { color: #6ee7b7; }
        .status-error .upload-item-status { color: #fda4af; }
        .upload-actions { display: flex; gap: 8px; margin-top: 13px; }
        .upload-actions .btn { flex: 1; padding: 10px 12px; font-size: 12px; }
        @keyframes uploadShine { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
        @keyframes uploadPulse { 50% { opacity: .62; } }
        @media (max-width: 560px) {
          .upload-panel { padding: 14px; }
          .upload-metrics { grid-template-columns: repeat(2, 1fr); }
          .upload-progress-top { align-items: flex-start; flex-direction: column; gap: 7px; }
          .upload-actions { flex-direction: column; }
        }
      `}</style>
    </div>
  );
}
