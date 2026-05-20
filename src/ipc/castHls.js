// ── Cast HLS Server ────────────────────────────────────────────────────────────
//
// Converts any MP4/video URL to an HLS stream on-the-fly using ffmpeg (-c copy,
// no re-encoding). The Chromecast receives standard HLS segments which it can
// play regardless of the source MP4's internal structure or CDN quirks.
//
// Architecture:
//   - HTTP server on a random port, bound to 0.0.0.0 (LAN-accessible)
//   - GET /hls/<id>/master.m3u8  → triggers ffmpeg, returns live HLS playlist
//   - GET /hls/<id>/seg<N>.ts    → returns the Nth segment (buffered in memory)
//   - Sessions are keyed by <id> (UUID). Each cast connection gets its own session.
//   - ffmpeg is killed when the session ends or when no request arrives for 60s.
//
// ffmpeg resolution:
//   In development: node_modules/ffmpeg-static/ffmpeg[.exe]
//   In production (asar): process.resourcesPath/app.asar.unpacked/node_modules/...

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const { EventEmitter } = require("events");

// ── Resolve ffmpeg binary path ─────────────────────────────────────────────────

function getFfmpegPath() {
  try {
    // ffmpeg-static returns the correct path for the current platform
    const p = require("ffmpeg-static");
    if (require("fs").existsSync(p)) return p;
  } catch {}

  // Fallback: when running from asar, ffmpeg-static is in the unpacked directory
  try {
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "ffmpeg-static",
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
    );
    if (require("fs").existsSync(unpacked)) return unpacked;
  } catch {}

  throw new Error("ffmpeg binary not found. Please ensure ffmpeg-static is installed.");
}

// ── Module state ───────────────────────────────────────────────────────────────

let _server = null;
let _port = null;

// Map<sessionId, HlsSession>
const _sessions = new Map();

// ── HlsSession ─────────────────────────────────────────────────────────────────

class HlsSession extends EventEmitter {
  constructor(id, sourceUrl, localIp) {
    super();
    this.id = id;
    this.sourceUrl = sourceUrl;
    this.localIp = localIp;
    this.segments = [];        // Array<Buffer> — completed .ts segments
    this.playlist = null;      // string — latest m3u8 playlist content
    this.ffmpeg = null;
    this.started = false;
    this.ended = false;
    this.error = null;
    this._idleTimer = null;
    this._segWaiters = [];     // pending resolvers waiting for a specific segment index
    this._playlistWaiters = []; // pending resolvers waiting for playlist
  }

  // Start ffmpeg and begin producing segments
  start() {
    if (this.started) return;
    this.started = true;

    let ffmpegPath;
    try {
      ffmpegPath = getFfmpegPath();
    } catch (e) {
      this.error = e.message;
      this.ended = true;
      this._notifyAll();
      return;
    }

    console.log(`[castHls] #${this.id} starting ffmpeg for: ${this.sourceUrl.slice(0, 80)}`);

    // Use a temp directory for HLS segments output
    const tmpDir = require("os").tmpdir();
    const sessionDir = path.join(tmpDir, `streambert-hls-${this.id}`);
    require("fs").mkdirSync(sessionDir, { recursive: true });
    this._sessionDir = sessionDir;

    const segPattern = path.join(sessionDir, "seg%05d.ts");
    const playlistPath = path.join(sessionDir, "playlist.m3u8");
    this._playlistPath = playlistPath;
    this._segPattern = segPattern;

    const args = [
      "-loglevel", "warning",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-i", this.sourceUrl,
      "-c:v", "copy",        // copy video stream — no re-encoding
      "-c:a", "aac",         // transcode audio to AAC stereo (Chromecast requires stereo AAC in TS)
      "-ac", "2",            // downmix to stereo — Chromecast DefaultMediaReceiver doesn't support AAC 5.1 in TS
      "-b:a", "192k",
      "-f", "hls",
      "-hls_time", "6",                    // 6-second segments
      "-hls_list_size", "0",               // keep ALL segments in playlist (VOD-in-LIVE: no skipping)
      "-hls_segment_filename", segPattern,
      "-hls_flags", "independent_segments",
      playlistPath,
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.ffmpeg = proc;

    proc.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) console.log(`[castHls] ffmpeg: ${msg}`);
    });

    // Watch the output directory for new segment files
    this._watchSegments();

    proc.on("close", (code) => {
      console.log(`[castHls] #${this.id} ffmpeg exited (code ${code})`);
      this.ended = true;
      this._stopWatcher();
      // Final scan for any segments we might have missed
      this._scanSegments();
      this._notifyAll();
    });

    proc.on("error", (err) => {
      console.error(`[castHls] #${this.id} ffmpeg error: ${err.message}`);
      this.error = err.message;
      this.ended = true;
      this._notifyAll();
    });

    this._resetIdleTimer();
  }

  _watchSegments() {
    const fs = require("fs");
    // Poll the session directory every 500ms for new segments and playlist updates
    this._watchInterval = setInterval(() => {
      this._scanSegments();
    }, 500);
  }

  _scanSegments() {
    const fs = require("fs");
    const dir = this._sessionDir;
    if (!dir) return;

    try {
      // Check for new .ts segment files
      const files = fs.readdirSync(dir).sort();
      let added = false;
      for (const f of files) {
        if (!f.endsWith(".ts")) continue;
        const idx = parseInt(f.replace("seg", "").replace(".ts", ""));
        if (isNaN(idx) || idx < this.segments.length) continue;
        if (idx === this.segments.length) {
          try {
            const buf = fs.readFileSync(path.join(dir, f));
            if (buf.length > 0) {
              this.segments.push(buf);
              added = true;
              console.log(`[castHls] #${this.id} segment ${idx} ready (${buf.length} bytes)`);
            }
          } catch {}
        }
      }

      // Check for updated playlist
      if (fs.existsSync(this._playlistPath)) {
        try {
          const pl = fs.readFileSync(this._playlistPath, "utf8");
          if (pl !== this.playlist) {
            this.playlist = pl;
          }
        } catch {}
      }

      if (added) this._notifyWaiters();
    } catch {}
  }

  _stopWatcher() {
    if (this._watchInterval) {
      clearInterval(this._watchInterval);
      this._watchInterval = null;
    }
  }

  _notifyWaiters() {
    // Notify segment waiters
    this._segWaiters = this._segWaiters.filter(({ idx, resolve }) => {
      if (idx < this.segments.length || this.ended) {
        resolve();
        return false;
      }
      return true;
    });
    // Notify playlist waiters
    if (this.playlist) {
      const w = this._playlistWaiters.splice(0);
      w.forEach(r => r());
    }
  }

  _notifyAll() {
    const sw = this._segWaiters.splice(0);
    sw.forEach(({ resolve }) => resolve());
    const pw = this._playlistWaiters.splice(0);
    pw.forEach(r => r());
  }

  // Wait until segment[idx] is available (or session ends)
  waitForSegment(idx) {
    if (idx < this.segments.length || this.ended) return Promise.resolve();
    return new Promise(resolve => {
      this._segWaiters.push({ idx, resolve });
    });
  }

  // Wait until playlist is available AND at least minSegments segments are ready.
  // This ensures the Chromecast has enough buffer when it first receives the playlist.
  waitForPlaylist(minSegments = 3) {
    if ((this.playlist && this.segments.length >= minSegments) || this.ended) return Promise.resolve();
    return new Promise(resolve => {
      const poll = setInterval(() => {
        if ((this.playlist && this.segments.length >= minSegments) || this.ended) {
          clearInterval(poll);
          resolve();
        }
      }, 200);
    });
  }

  _resetIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      console.log(`[castHls] #${this.id} idle timeout — destroying session`);
      this.destroy();
    }, 120000); // 2 minutes idle
  }

  touch() {
    this._resetIdleTimer();
  }

  destroy() {
    this._stopWatcher();
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (this.ffmpeg) {
      try { this.ffmpeg.kill("SIGKILL"); } catch {}
      this.ffmpeg = null;
    }
    // Clean up temp directory
    if (this._sessionDir) {
      try {
        const fs = require("fs");
        const files = fs.readdirSync(this._sessionDir);
        for (const f of files) {
          try { fs.unlinkSync(path.join(this._sessionDir, f)); } catch {}
        }
        fs.rmdirSync(this._sessionDir);
      } catch {}
      this._sessionDir = null;
    }
    this.ended = true;
    this._notifyAll();
    _sessions.delete(this.id);
    console.log(`[castHls] #${this.id} session destroyed`);
  }
}

// ── HTTP Server ────────────────────────────────────────────────────────────────

function startHlsServer() {
  if (_server) return Promise.resolve(_port);

  return new Promise((resolve, reject) => {
    _server = http.createServer(async (req, res) => {
      // GET /hls/<id>/master.m3u8   — playlist
      // GET /hls/<id>/seg<N>.ts     — segment
      const m = req.url.match(/^\/hls\/([^/]+)\/(master\.m3u8|seg(\d+)\.ts)$/);
      if (!m) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const sessionId = m[1];
      const file = m[2];
      const session = _sessions.get(sessionId);

      if (!session) {
        res.writeHead(404);
        res.end("Session not found");
        return;
      }

      session.touch();

      if (file === "master.m3u8") {
        // Wait up to 15s for the first playlist to appear
        const timeout = setTimeout(() => {
          if (!res.headersSent) {
            res.writeHead(503);
            res.end("Playlist not ready");
          }
        }, 15000);

        await session.waitForPlaylist();
        clearTimeout(timeout);

        if (session.error) {
          res.writeHead(500);
          res.end("ffmpeg error: " + session.error);
          return;
        }

        if (!session.playlist) {
          res.writeHead(503);
          res.end("Playlist unavailable");
          return;
        }

        // Rewrite the playlist so segment URLs point to our server
        const rewritten = rewritePlaylist(session.playlist, sessionId, session.localIp, _port);
        res.writeHead(200, {
          "Content-Type": "application/x-mpegURL",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        });
        res.end(rewritten);

      } else {
        // Segment request
        const segIdx = parseInt(m[3]);

        // Wait up to 30s for the segment to be ready
        const timeout = setTimeout(() => {
          if (!res.headersSent) {
            res.writeHead(503);
            res.end("Segment not ready");
          }
        }, 30000);

        await session.waitForSegment(segIdx);
        clearTimeout(timeout);

        if (res.headersSent) return;

        const buf = session.segments[segIdx];
        if (!buf) {
          res.writeHead(404);
          res.end("Segment not found");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "video/MP2T",
          "Content-Length": buf.length,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        });
        res.end(buf);
      }
    });

    _server.on("error", reject);
    _server.listen(0, "0.0.0.0", () => {
      _port = _server.address().port;
      console.log("[castHls] HLS server listening on port", _port);
      resolve(_port);
    });
  });
}

// Rewrite the ffmpeg-generated playlist so segment filenames become full absolute
// URLs pointing to our HLS server. The Chromecast needs absolute URLs because it
// won't correctly resolve relative paths from the playlist URL base.
function rewritePlaylist(playlist, sessionId, localIp, port) {
  const base = `http://${localIp}:${port}/hls/${sessionId}`;
  return playlist
    .split("\n")
    .map(line => {
      line = line.trim();
      // Rewrite segment lines (seg00000.ts etc)
      if (line && !line.startsWith("#") && line.endsWith(".ts")) {
        const segName = path.basename(line);
        const segIdx = parseInt(segName.replace(/[^0-9]/g, ""));
        return `${base}/seg${String(segIdx).padStart(5, "0")}.ts`;
      }
      return line;
    })
    .join("\n");
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Start the HLS server and a new transcoding session.
 * Returns the master.m3u8 URL that the Chromecast should load.
 *
 * @param {string} localIp   - LAN IP of this machine
 * @param {string} sourceUrl - Original video URL (MP4, etc.)
 * @returns {Promise<{ hlsUrl: string, sessionId: string }>}
 */
async function createHlsSession(localIp, sourceUrl) {
  await startHlsServer();

  const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const session = new HlsSession(sessionId, sourceUrl, localIp);
  _sessions.set(sessionId, session);
  session.start();

  const hlsUrl = `http://${localIp}:${_port}/hls/${sessionId}/master.m3u8`;
  console.log(`[castHls] created session ${sessionId} → ${hlsUrl}`);
  return { hlsUrl, sessionId };
}

/**
 * Destroy a specific HLS session (call on cast disconnect).
 */
function destroyHlsSession(sessionId) {
  const session = _sessions.get(sessionId);
  if (session) session.destroy();
}

/**
 * Destroy all active sessions and stop the server.
 */
function stopHlsServer() {
  for (const session of _sessions.values()) {
    session.destroy();
  }
  _sessions.clear();
  return new Promise(resolve => {
    if (!_server) return resolve();
    _server.close(() => {
      _server = null;
      _port = null;
      resolve();
    });
  });
}

function getPort() { return _port; }

module.exports = { createHlsSession, destroyHlsSession, stopHlsServer, getPort };
