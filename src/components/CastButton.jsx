import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

// ── SVG Icons (inline, no external dep) ───────────────────────────────────────

function CastIcon({ active }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: 16, height: 16, color: active ? "var(--accent, #e50914)" : undefined }}
    >
      <path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
      <line x1="2" y1="20" x2="2.01" y2="20" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      style={{ width: 16, height: 16, animation: "cast-spin 0.8s linear infinite" }}
    >
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}>
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}>
      <polygon points="5,3 19,12 5,21" />
    </svg>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(secs) {
  if (!secs || !isFinite(secs)) return "0:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── CastButton component ───────────────────────────────────────────────────────
//
// The dropdown is rendered via a portal into document.body and positioned with
// position:fixed + getBoundingClientRect. This escapes the player-wrap's
// overflow:hidden and the opacity:0 hover mask.

export default function CastButton({ streamUrl, onCastChange, onTimeUpdate }) {
  // ── State ──────────────────────────────────────────────────────────────────
  const [castState, setCastStateInternal] = useState("idle");
  const [devices, setDevices] = useState([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
  const [scanning, setScanning] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [remoteCurrentTime, setRemoteCurrentTime] = useState(0);
  const [remoteDuration, setRemoteDuration] = useState(0);
  const [remotePaused, setRemotePaused] = useState(false);
  const [seekDragging, setSeekDragging] = useState(false);
  const [seekDragValue, setSeekDragValue] = useState(0);

  const castStateRef = useRef("idle");
  const btnRef = useRef(null);
  const dropdownRef = useRef(null);
  const connectedDeviceRef = useRef(null);

  const setCastState = useCallback((s) => {
    castStateRef.current = s;
    setCastStateInternal(s);
    onCastChange?.(s);
  }, [onCastChange]);

  // ── cast:time-update listener ──────────────────────────────────────────────
  useEffect(() => {
    if (!window.electron?.onCastTimeUpdate) return;
    const h = window.electron.onCastTimeUpdate((data) => {
      setRemoteCurrentTime(data.currentTime ?? 0);
      setRemoteDuration(data.duration ?? 0);
      setRemotePaused(data.playerState === "PAUSED");
      onTimeUpdate?.({ currentTime: data.currentTime, duration: data.duration });
    });
    return () => window.electron.offCastTimeUpdate?.(h);
  }, [onTimeUpdate]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  // NOTE: do NOT call castDisconnect on unmount — the component may remount
  // due to parent re-renders while a cast session is active. The session lives
  // in the main process and survives renderer re-renders.
  useEffect(() => {
    return () => {};
  }, []);

  // ── Click-outside to close dropdown ───────────────────────────────────────
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e) => {
      if (
        btnRef.current && !btnRef.current.contains(e.target) &&
        dropdownRef.current && !dropdownRef.current.contains(e.target)
      ) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  // ── Reposition on scroll / resize ─────────────────────────────────────────
  useEffect(() => {
    if (!dropdownOpen) return;
    const reposition = () => {
      if (!btnRef.current) return;
      const r = btnRef.current.getBoundingClientRect();
      setDropdownPos(calcPos(r));
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [dropdownOpen]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function calcPos(rect) {
    const DROPDOWN_HEIGHT = 320; // approx max height
    const DROPDOWN_WIDTH = 260;
    const GAP = 6;
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    // Prefer opening below; if not enough room, open above
    let top;
    if (rect.bottom + GAP + DROPDOWN_HEIGHT < vh) {
      top = rect.bottom + GAP;
    } else {
      top = Math.max(8, rect.top - GAP - DROPDOWN_HEIGHT);
    }

    // Align left edge of button; clamp to viewport
    let left = rect.left;
    if (left + DROPDOWN_WIDTH > vw - 8) {
      left = vw - DROPDOWN_WIDTH - 8;
    }

    return { top, left };
  }

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleOpen = useCallback(async () => {
    const isOpening = !dropdownOpen;
    if (isOpening && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setDropdownPos(calcPos(r));
    }
    setDropdownOpen((v) => !v);
    // Don't re-scan when already casting — just show controls
    if (isOpening && castStateRef.current !== "casting") {
      setScanning(true);
      setErrorMsg(null);
      try {
        const res = await window.electron?.castDiscover?.();
        setDevices(res?.devices ?? []);
      } catch {
        setDevices([]);
      } finally {
        setScanning(false);
      }
    }
  }, [dropdownOpen]);

  const handleRescan = useCallback(async () => {
    setScanning(true);
    setErrorMsg(null);
    try {
      const res = await window.electron?.castDiscover?.();
      setDevices(res?.devices ?? []);
    } catch {
      setDevices([]);
    } finally {
      setScanning(false);
    }
  }, []);

  const handleConnect = useCallback(async (device) => {
    if (!streamUrl) {
      setErrorMsg("URL do stream não detectada ainda. Aguarde o vídeo carregar.");
      return;
    }
    console.log("[CastButton] connecting to", device.name, "streamUrl:", streamUrl);
    setErrorMsg(null);
    setCastState("connecting");
    connectedDeviceRef.current = device;
    try {
      const res = await window.electron?.castConnect?.(device.id, streamUrl, device);
      console.log("[CastButton] castConnect result:", res);
      if (res?.ok) {
        setCastState("casting");
        // Keep dropdown open so user can see controls immediately
        setDropdownOpen(true);
      } else {
        setErrorMsg(res?.error || "Falha ao conectar");
        setCastState("error");
      }
    } catch (err) {
      console.error("[CastButton] castConnect exception:", err);
      setErrorMsg(err.message);
      setCastState("error");
    }
  }, [streamUrl, setCastState]);

  const handleDisconnect = useCallback(async () => {
    await window.electron?.castDisconnect?.();
    connectedDeviceRef.current = null;
    setCastState("idle");
    setRemoteCurrentTime(0);
    setRemoteDuration(0);
    setRemotePaused(false);
  }, [setCastState]);

  const handlePause = useCallback(async () => {
    await window.electron?.castControl?.("pause");
    setRemotePaused(true);
  }, []);

  const handleResume = useCallback(async () => {
    await window.electron?.castControl?.("resume");
    setRemotePaused(false);
  }, []);

  const handleSeekCommit = useCallback(async (value) => {
    setSeekDragging(false);
    await window.electron?.castControl?.("seek", Number(value));
    setRemoteCurrentTime(Number(value));
  }, []);

  const handleVolume = useCallback(async (value) => {
    await window.electron?.castControl?.("volume", undefined, Number(value) / 100);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  const isCasting = castState === "casting";
  const isConnecting = castState === "connecting";
  const isError = castState === "error";
  const seekValue = seekDragging ? seekDragValue : remoteCurrentTime;

  const dropdown = dropdownOpen && createPortal(
    <div
      ref={dropdownRef}
      className="cast-dropdown"
      style={{ top: dropdownPos.top, left: dropdownPos.left }}
    >
      {/* ── Controls (only when casting) */}
      {isCasting && (
        <div className="cast-dropdown__controls">
          <div className="cast-dropdown__controls-row">
            <button
              className="cast-ctrl-btn"
              onClick={remotePaused ? handleResume : handlePause}
              title={remotePaused ? "Retomar" : "Pausar"}
            >
              {remotePaused ? <PlayIcon /> : <PauseIcon />}
              {remotePaused ? "Retomar" : "Pausar"}
            </button>
            <button
              className="cast-ctrl-btn cast-ctrl-btn--disconnect"
              onClick={handleDisconnect}
            >
              Desconectar
            </button>
          </div>

          {/* Seek slider */}
          {remoteDuration > 0 && (
            <div className="cast-dropdown__seek">
              <span className="cast-time">{fmtTime(seekValue)}</span>
              <input
                type="range"
                className="cast-slider"
                min={0}
                max={remoteDuration}
                step={1}
                value={seekValue}
                onChange={(e) => {
                  setSeekDragging(true);
                  setSeekDragValue(Number(e.target.value));
                }}
                onMouseUp={(e) => handleSeekCommit(e.target.value)}
                onTouchEnd={(e) => handleSeekCommit(e.target.value)}
              />
              <span className="cast-time">{fmtTime(remoteDuration)}</span>
            </div>
          )}

          {/* Volume slider */}
          <div className="cast-dropdown__volume">
            <span className="cast-label">Volume</span>
            <input
              type="range"
              className="cast-slider"
              min={0}
              max={100}
              step={1}
              defaultValue={80}
              onChange={(e) => handleVolume(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* ── Device list */}
      <div className="cast-dropdown__section-title">
        {isCasting ? "Dispositivo ativo" : "Dispositivos disponíveis"}
      </div>

      {errorMsg && (
        <div className="cast-dropdown__error">{errorMsg}</div>
      )}

      {scanning ? (
        <div className="cast-dropdown__scanning">Procurando dispositivos…</div>
      ) : devices.length === 0 ? (
        <div className="cast-dropdown__empty">
          <span>Nenhum dispositivo encontrado</span>
          <button className="cast-rescan-btn" onClick={handleRescan}>
            Tentar novamente
          </button>
        </div>
      ) : (
        <ul className="cast-dropdown__list">
          {devices.map((device) => (
            <li key={device.id}>
              <button
                className={
                  "cast-device-btn" +
                  (connectedDeviceRef.current?.id === device.id && isCasting
                    ? " cast-device-btn--active"
                    : "")
                }
                onClick={() => !isCasting && handleConnect(device)}
                disabled={isCasting}
              >
                <span className="cast-device-icon">
                  {device.type === "chromecast" ? "📺" : "🖥"}
                </span>
                <span className="cast-device-name">{device.name}</span>
                <span className="cast-device-type">
                  {device.type === "chromecast" ? "Chromecast" : "DLNA"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!isCasting && devices.length > 0 && (
        <button
          className="cast-rescan-btn cast-rescan-btn--inline"
          onClick={handleRescan}
          disabled={scanning}
        >
          {scanning ? "Procurando…" : "Atualizar lista"}
        </button>
      )}
    </div>,
    document.body
  );

  return (
    <>
      <button
        ref={btnRef}
        className={
          "player-overlay-btn" +
          (isCasting ? " player-overlay-btn--casting" : "") +
          (isConnecting ? " player-overlay-btn--connecting" : "")
        }
        onClick={handleOpen}
        title={isCasting ? "Gerenciar cast" : "Espelhar para TV"}
        disabled={isConnecting}
      >
        {isConnecting ? <SpinnerIcon /> : <CastIcon active={isCasting} />}
        {isCasting ? "Cast" : isError ? "Erro" : "Cast"}
      </button>
      {dropdown}
    </>
  );
}
