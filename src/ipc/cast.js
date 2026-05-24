// ── IPC: Chromecast / DLNA cast session management ────────────────────────────
//
// Handlers:
//   cast:discover   – scan mDNS + SSDP for 5 s, return device list
//   cast:connect    – connect to device and start stream
//   cast:disconnect – end active session
//   cast:status     – return state + currentTime/duration
//   cast:control    – send pause/resume/seek/volume to device
//
// Push events emitted to renderer:
//   cast:time-update  – { currentTime, duration, playerState } from Chromecast MEDIA_STATUS
//
// Architecture notes:
//   - All heavy lifting runs in the main process; renderer calls via ipcRenderer.invoke
//   - castv2-client handles Chromecast (Cast v2 protocol over TLS)
//   - node-ssdp handles UPnP/DLNA discovery; http/xml handles AVTransport control
//   - Active session is stored in module-level `session` object (one at a time)

const { ipcMain } = require("electron");
const os = require("os");
const http = require("http");
const https = require("https");
const { Client: CastClient, DefaultMediaReceiver } = require("castv2-client");
const { Client: SsdpClient } = require("node-ssdp");
const multicastDns = require("multicast-dns");
const castProxy = require("./castProxy");
const castHls = require("./castHls");

// ── Module state ──────────────────────────────────────────────────────────────

let _getMainWindow = null;     // injected by register()
let _getPlayerCookies = null;  // async (url) => cookieString

// Active cast session (one at a time)
const session = {
  state: "idle", // idle | connecting | casting | error
  deviceId: null,
  type: null, // 'chromecast' | 'dlna'
  castClient: null,
  mediaPlayer: null,
  dlnaHost: null,
  dlnaPort: null,
  dlnaControlUrl: null,
  currentTime: 0,
  duration: 0,
  playerState: "IDLE", // IDLE | PLAYING | PAUSED | BUFFERING
  mediaStatusInterval: null, // DLNA polling timer
  hlsSessionId: null, // active HLS transcoding session (if using HLS fallback)
};

// Start the CORS proxy as soon as the module loads
castProxy.startProxy().catch((err) =>
  console.error("[cast] proxy start error:", err.message)
);

function resetSession() {
  if (session.castClient) {
    try { session.castClient.close(); } catch {}
  }
  if (session.mediaStatusInterval) {
    clearInterval(session.mediaStatusInterval);
    session.mediaStatusInterval = null;
  }
  if (session.hlsSessionId) {
    castHls.destroyHlsSession(session.hlsSessionId);
    session.hlsSessionId = null;
  }
  session.state = "idle";
  session.deviceId = null;
  session.type = null;
  session.castClient = null;
  session.mediaPlayer = null;
  session.dlnaHost = null;
  session.dlnaPort = null;
  session.dlnaControlUrl = null;
  session.currentTime = 0;
  session.duration = 0;
  session.playerState = "IDLE";
}

// ── Pick the best local IPv4 interface for multicast ─────────────────────────
// Prefer the first non-internal, non-VPN-looking interface on the same subnet
// as a typical home router (192.168.x.x / 10.x.x.x / 172.16-31.x.x).
// Radmin VPN and similar use 26.x.x.x / 100.x.x.x ranges — skip those.

function pickLocalInterface() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [, addrs] of Object.entries(ifaces)) {
    for (const a of addrs) {
      if (a.family !== "IPv4" || a.internal) continue;
      const parts = a.address.split(".").map(Number);
      const isPrivate =
        parts[0] === 10 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168);
      if (isPrivate) candidates.push(a.address);
    }
  }
  return candidates[0] || undefined; // undefined = OS default
}

// ── mDNS discovery via multicast-dns ─────────────────────────────────────────
// Binds explicitly to the LAN interface to avoid VPN adapters hijacking the
// multicast socket. Sends PTR query for _googlecast._tcp.local and collects
// SRV + A records to build a { host, port, name } device list.

function discoverChromecast(timeoutMs) {
  return new Promise((resolve) => {
    const devices = [];
    const seen = new Set();

    // Intermediate map: instanceName -> { name, port, host }
    const pending = {};

    const iface = pickLocalInterface();
    let mdns;
    try {
      mdns = multicastDns({ interface: iface });
    } catch (e) {
      console.error("[cast] multicast-dns init error:", e.message);
      return resolve([]);
    }

    mdns.on("response", (response) => {
      const all = [...(response.answers || []), ...(response.additionals || [])];

      for (const record of all) {
        if (record.type === "PTR" && record.name === "_googlecast._tcp.local") {
          const instance = record.data;
          if (!pending[instance]) pending[instance] = {};
        }
        if (record.type === "SRV") {
          if (!pending[record.name]) pending[record.name] = {};
          pending[record.name].port = record.data.port;
          pending[record.name].target = record.data.target;
        }
        if (record.type === "TXT") {
          if (!pending[record.name]) pending[record.name] = {};
          // fn= field is the friendly name
          const bufs = Array.isArray(record.data) ? record.data : [];
          for (const b of bufs) {
            const s = Buffer.isBuffer(b) ? b.toString() : String(b);
            if (s.startsWith("fn=")) {
              pending[record.name].friendlyName = s.slice(3);
            }
          }
        }
        if (record.type === "A") {
          // Match A record to pending instances by target
          for (const [key, val] of Object.entries(pending)) {
            if (val.target === record.name || key.includes(record.name)) {
              val.host = record.data;
            }
          }
        }
      }
    });

    mdns.on("error", (err) => {
      console.error("[cast] mdns error:", err.message);
    });

    // Send PTR query; repeat after 1.5 s for devices that missed the first
    mdns.query([{ name: "_googlecast._tcp.local", type: "PTR" }]);
    const retry = setTimeout(() => {
      mdns.query([{ name: "_googlecast._tcp.local", type: "PTR" }]);
    }, 1500);

    setTimeout(() => {
      clearTimeout(retry);
      try { mdns.destroy(); } catch {}

      // Build final device list from collected records
      for (const [instance, info] of Object.entries(pending)) {
        if (!info.host || !info.port) continue;
        const id = `${info.host}:${info.port}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const label = info.friendlyName || instance.split(".")[0] || info.host;
        devices.push({
          id,
          name: label,
          type: "chromecast",
          host: info.host,
          port: info.port,
        });
      }

      resolve(devices);
    }, timeoutMs);
  });
}

// ── SSDP discovery (DLNA/UPnP) ───────────────────────────────────────────────

function discoverDlna(timeoutMs) {
  return new Promise((resolve) => {
    const devices = [];
    const seen = new Set();
    const client = new SsdpClient();

    client.on("response", (headers) => {
      const location = headers.LOCATION || headers.location;
      if (!location) return;
      if (seen.has(location)) return;
      seen.add(location);

      // Parse the device description XML to get name and control URL
      fetchDeviceDescription(location).then((desc) => {
        if (!desc) return;
        devices.push({
          id: location,
          name: desc.friendlyName || new URL(location).hostname,
          type: "dlna",
          host: new URL(location).hostname,
          port: parseInt(new URL(location).port, 10) || 80,
          controlUrl: desc.controlUrl,
          location,
        });
      }).catch(() => {});
    });

    client.search("urn:schemas-upnp-org:service:AVTransport:1");

    setTimeout(() => {
      client.stop();
      resolve(devices);
    }, timeoutMs);
  });
}

function fetchDeviceDescription(location) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout")), 3000);
    http.get(location, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        clearTimeout(timeout);
        try {
          const friendlyName = (data.match(/<friendlyName>([^<]+)<\/friendlyName>/) || [])[1] || null;
          // Find AVTransport controlURL
          const avBlock = data.match(/AVTransport[\s\S]*?<controlURL>([^<]+)<\/controlURL>/);
          const controlPath = avBlock ? avBlock[1] : null;
          const base = new URL(location);
          const controlUrl = controlPath
            ? new URL(controlPath, base).href
            : null;
          resolve({ friendlyName, controlUrl });
        } catch { resolve(null); }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── DLNA AVTransport SOAP helpers ─────────────────────────────────────────────

function soapAction(host, port, controlUrl, action, body) {
  return new Promise((resolve, reject) => {
    const xml = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>${body}</s:Body>
</s:Envelope>`;

    const path = controlUrl.startsWith("http")
      ? new URL(controlUrl).pathname
      : controlUrl;

    const options = {
      host,
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPACTION": `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
        "Content-Length": Buffer.byteLength(xml),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve(data));
    });
    req.setTimeout(4000, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.write(xml);
    req.end();
  });
}

function dlnaSetUri(host, port, controlUrl, uri) {
  const body = `<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
    <InstanceID>0</InstanceID>
    <CurrentURI>${uri}</CurrentURI>
    <CurrentURIMetaData></CurrentURIMetaData>
  </u:SetAVTransportURI>`;
  return soapAction(host, port, controlUrl, "SetAVTransportURI", body);
}

function dlnaPlay(host, port, controlUrl) {
  const body = `<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
    <InstanceID>0</InstanceID><Speed>1</Speed>
  </u:Play>`;
  return soapAction(host, port, controlUrl, "Play", body);
}

function dlnaPause(host, port, controlUrl) {
  const body = `<u:Pause xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
    <InstanceID>0</InstanceID>
  </u:Pause>`;
  return soapAction(host, port, controlUrl, "Pause", body);
}

function dlnaStop(host, port, controlUrl) {
  const body = `<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
    <InstanceID>0</InstanceID>
  </u:Stop>`;
  return soapAction(host, port, controlUrl, "Stop", body);
}

function dlnaSeek(host, port, controlUrl, seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const target = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  const body = `<u:Seek xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
    <InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${target}</Target>
  </u:Seek>`;
  return soapAction(host, port, controlUrl, "Seek", body);
}

function dlnaGetPositionInfo(host, port, controlUrl) {
  const body = `<u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
    <InstanceID>0</InstanceID>
  </u:GetPositionInfo>`;
  return soapAction(host, port, controlUrl, "GetPositionInfo", body).then((xml) => {
    const hhmmss = (s) => {
      const parts = (s || "0:0:0").split(":").map(Number);
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    };
    const ct = (xml.match(/<RelTime>([^<]+)<\/RelTime>/) || [])[1] || "0:0:0";
    const dur = (xml.match(/<TrackDuration>([^<]+)<\/TrackDuration>/) || [])[1] || "0:0:0";
    return { currentTime: hhmmss(ct), duration: hhmmss(dur) };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendTimeUpdate(data) {
  try {
    const win = _getMainWindow?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send("cast:time-update", data);
    }
  } catch {}
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

function register(getMainWindow, getPlayerCookies) {
  _getMainWindow = getMainWindow;
  _getPlayerCookies = getPlayerCookies || null;

  // ── cast:discover ──────────────────────────────────────────────────────────
  ipcMain.handle("cast:discover", async () => {
    try {
      const TIMEOUT = 5000;
      const [chromecasts, dlnaDevices] = await Promise.all([
        discoverChromecast(TIMEOUT),
        discoverDlna(TIMEOUT),
      ]);
      return { ok: true, devices: [...chromecasts, ...dlnaDevices] };
    } catch (err) {
      return { ok: false, error: err.message, devices: [] };
    }
  });

  // ── cast:connect ───────────────────────────────────────────────────────────
  ipcMain.handle("cast:connect", async (_, { deviceId, streamUrl, device, altStreamUrl }) => {
    console.log("[cast] cast:connect called — deviceId:", deviceId, "streamUrl:", streamUrl, "altStreamUrl:", altStreamUrl || "(none)", "device:", JSON.stringify(device));
    if (session.state === "casting" || session.state === "connecting") {
      resetSession();
    }

    session.state = "connecting";
    session.deviceId = deviceId;

    // Captura cookies do player session para o domínio do stream.
    // Necessário para servidores protegidos por Cloudflare (cf_clearance, etc.).
    let cookieStr = "";
    if (_getPlayerCookies) {
      try {
        cookieStr = await _getPlayerCookies(streamUrl);
        if (cookieStr) {
          const hostname = new URL(streamUrl).hostname;
          castProxy.setDomainCookies(hostname, cookieStr);
          console.log(`[cast] cookies do player injetados no proxy para ${hostname}`);
        }
      } catch (e) {
        console.warn("[cast] falha ao buscar cookies do player:", e.message);
      }
    }

    try {
      if (device.type === "chromecast") {
        await connectChromecast(device, streamUrl, cookieStr, altStreamUrl);
      } else if (device.type === "dlna") {
        await connectDlna(device, streamUrl);
      } else {
        throw new Error("Unknown device type: " + device.type);
      }
      session.state = "casting";
      return { ok: true };
    } catch (err) {
      session.state = "error";
      return { ok: false, error: err.message };
    }
  });

  // ── cast:disconnect ────────────────────────────────────────────────────────
  ipcMain.handle("cast:disconnect", async () => {
    console.log("[cast] cast:disconnect called, session.type:", session.type, "state:", session.state);
    try {
      if (session.type === "dlna" && session.dlnaHost) {
        await dlnaStop(session.dlnaHost, session.dlnaPort, session.dlnaControlUrl).catch(() => {});
      }
      if (session.type === "chromecast" && session.castClient) {
        try { session.castClient.stop(session.mediaPlayer, () => {}); } catch {}
      }
    } catch {}
    resetSession();
    console.log("[cast] session reset done");
    return { ok: true };
  });

  // ── cast:status ────────────────────────────────────────────────────────────
  ipcMain.handle("cast:status", async () => {
    // For DLNA: poll GetPositionInfo on demand
    if (session.state === "casting" && session.type === "dlna" && session.dlnaHost) {
      try {
        const pos = await dlnaGetPositionInfo(
          session.dlnaHost, session.dlnaPort, session.dlnaControlUrl
        );
        session.currentTime = pos.currentTime;
        session.duration = pos.duration;
      } catch {}
    }
    return {
      state: session.state,
      currentTime: session.currentTime,
      duration: session.duration,
      playerState: session.playerState,
    };
  });

  // ── cast:control ───────────────────────────────────────────────────────────
  ipcMain.handle("cast:control", async (_, { action, position, level }) => {
    if (session.state !== "casting") return { ok: false, error: "Not casting" };

    try {
      if (session.type === "chromecast") {
        await controlChromecast(action, position, level);
      } else if (session.type === "dlna") {
        await controlDlna(action, position);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// ── Chromecast connection + control ───────────────────────────────────────────

// ── Quick probe: fetch first 2KB of a playlist to detect if it's audio or video ──
// Returns 'audio' if segments are in /Audio/ paths, 'video' if in /Video/ paths,
// or 'unknown' if we can't determine.
async function detectStreamRole(url, cookieStr) {
  return new Promise((resolve) => {
    const isHttps = url.startsWith("https:");
    const lib = isHttps ? https : http;
    let parsed;
    try { parsed = new URL(url); } catch { return resolve("unknown"); }

    const headers = {
      host: parsed.hostname,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "referer": `https://${parsed.hostname}/`,
    };
    const domainCookie = cookieStr || "";
    if (domainCookie) headers["cookie"] = domainCookie;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port) : (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers,
      rejectUnauthorized: false,
      timeout: 8000,
    };

    // Guard against resolving more than once (race between data/close/error)
    let _resolved = false;
    const done = (role) => { if (_resolved) return; _resolved = true; resolve(role); };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString("utf8");
        // Check pattern immediately — avoids the req.destroy() → error → "unknown" race.
        // Calling res.destroy() here is safe: it fires "close" but NOT req's "error".
        if (/\/Audio\//i.test(data)) { res.destroy(); return done("audio"); }
        if (/\/Video\//i.test(data)) { res.destroy(); return done("video"); }
        if (data.length > 4096) res.destroy(); // enough data, no match yet
      });
      res.on("close", () => {
        // Fallback: codec hints if path-based check didn't trigger
        if (/CODECS="avc/i.test(data) || /\bVIDEO\b/i.test(data)) return done("video");
        if (/CODECS="mp4a/i.test(data) || /\bAUDIO\b/i.test(data)) return done("audio");
        done("unknown");
      });
      res.on("error", () => done("unknown"));
    });
    req.on("error", () => done("unknown"));
    req.on("timeout", () => { req.destroy(); done("unknown"); });
    req.end();
  });
}

function connectChromecast(device, streamUrl, cookieStr, altStreamUrl) {
  return new Promise((resolve, reject) => {
    console.log("[cast] connectChromecast start", device.host, device.port, streamUrl);
    if (altStreamUrl) console.log("[cast] altStreamUrl:", altStreamUrl);
    const client = new CastClient();
    session.castClient = client;
    session.type = "chromecast";

    client.connect({ host: device.host, port: device.port }, () => {
      console.log("[cast] connected to Chromecast, launching DefaultMediaReceiver");
      client.launch(DefaultMediaReceiver, async (err, player) => {
        if (err) {
          console.error("[cast] launch error:", err);
          return reject(err);
        }

        // HLS: padrão (.m3u8) OU playlist mascarada como .txt em caminho /hls/
        //      OU endpoint /m3/ (servidores MSE que servem playlists sem extensão)
        const isHls = streamUrl.includes(".m3u8") ||
                      (/\/hls\//i.test(streamUrl) && /\.txt(\?|$)/i.test(streamUrl)) ||
                      /\/cdn\/hls\//i.test(streamUrl) ||
                      /\/m3\//i.test(streamUrl);
        const isDash = streamUrl.includes(".mpd");
        const localIp = pickLocalInterface();

        // ── Demuxed HLS (áudio+vídeo em playlists separados) ─────────────────
        // Quando o servidor usa MSE com dois tracks separados, temos dois URLs /m3/.
        // Identificamos qual é áudio e qual é vídeo, depois servimos um master HLS.
        const bothAreDemuxedHls = isHls && altStreamUrl && /\/m3\//i.test(altStreamUrl);
        let videoUrl = streamUrl;
        let audioUrl = null;

        if (bothAreDemuxedHls) {
          console.log("[cast] detectando papéis dos streams demuxados (áudio vs vídeo)...");
          const [role1, role2] = await Promise.all([
            detectStreamRole(streamUrl, cookieStr),
            detectStreamRole(altStreamUrl, cookieStr),
          ]);
          console.log(`[cast] stream1=${role1}, stream2=${role2}`);

          if (role1 === "audio" && role2 !== "audio") {
            audioUrl = streamUrl;
            videoUrl = altStreamUrl;
          } else if (role2 === "audio" && role1 !== "audio") {
            audioUrl = altStreamUrl;
            videoUrl = streamUrl;
          } else {
            // Can't determine — use streamUrl as video, altStreamUrl as audio (best guess)
            console.log("[cast] ⚠️ não foi possível determinar papel dos streams — usando ordem original");
            audioUrl = altStreamUrl;
            videoUrl = streamUrl;
          }
          // Inject cookies for altStreamUrl hostname too
          if (altStreamUrl) {
            try {
              const altHostname = new URL(altStreamUrl).hostname;
              if (altHostname !== new URL(streamUrl).hostname && cookieStr) {
                castProxy.setDomainCookies(altHostname, cookieStr);
              }
            } catch {}
          }
          console.log(`[cast] videoUrl: ${videoUrl.slice(0, 60)}`);
          console.log(`[cast] audioUrl: ${audioUrl.slice(0, 60)}`);
        }

        let castUrl = streamUrl;
        let contentType;
        let streamType;

        if (isHls) {
          contentType = "application/x-mpegURL";
          streamType = "LIVE";
          try {
            if (localIp && castProxy.getPort()) {
              if (bothAreDemuxedHls) {
                // Serve um master HLS sintético que combina áudio+vídeo
                castUrl = castProxy.buildMuxUrl(localIp, videoUrl, audioUrl);
                console.log("[cast] usando mux URL (master demuxado):", castUrl.slice(0, 100));
              } else {
                castUrl = castProxy.buildProxyUrl(localIp, streamUrl);
              }
            }
          } catch (e) {
            console.warn("[cast] falha ao construir castUrl:", e.message);
          }
        } else if (isDash) {
          contentType = "application/dash+xml";
          streamType = "LIVE";
          try {
            if (localIp && castProxy.getPort()) {
              castUrl = castProxy.buildProxyUrl(localIp, streamUrl);
            }
          } catch {}
        } else {
          // MP4 ou stream desconhecido — probe o CDN com os cookies do browser
          contentType = "video/mp4";
          let brokenRanges = false;
          try {
            const probed = await castProxy.probeStreamType(streamUrl, cookieStr);
            brokenRanges = (probed === "HLS_NEEDED");
          } catch {}

          if (brokenRanges && localIp) {
            // CDN doesn't support real ranges → remux to HLS on-the-fly
            console.log("[cast] CDN has broken ranges — using HLS on-the-fly via ffmpeg");
            try {
              const { hlsUrl, sessionId } = await castHls.createHlsSession(localIp, streamUrl, cookieStr);
              session.hlsSessionId = sessionId;
              castUrl = hlsUrl;
              contentType = "application/x-mpegURL";
              streamType = "LIVE";
              console.log("[cast] HLS session created:", hlsUrl);
            } catch (hlsErr) {
              console.error("[cast] HLS session creation failed:", hlsErr.message, "— falling back to proxy");
              // Fall back to direct proxy
              try {
                if (localIp && castProxy.getPort()) {
                  castUrl = castProxy.buildProxyUrl(localIp, streamUrl);
                }
              } catch {}
              streamType = "BUFFERED";
            }
          } else {
            // CDN supports ranges — use CORS proxy normally
            streamType = "BUFFERED";
            try {
              if (localIp && castProxy.getPort()) {
                castUrl = castProxy.buildProxyUrl(localIp, streamUrl);
                console.log("[cast] using proxy URL:", castUrl.slice(0, 80) + "...");
              }
            } catch (e) {
              console.warn("[cast] proxy URL build failed:", e.message);
            }
          }
        }

        console.log("[cast] loading media — contentType:", contentType, "streamType:", streamType);
        console.log("[cast] streamUrl original:", streamUrl);
        console.log("[cast] castUrl (proxy/final):", castUrl);

        const media = {
          contentId: castUrl,
          contentType,
          streamType,
        };

        player.load(media, { autoplay: true }, (err2, status) => {
          if (err2) {
            console.error("[cast] player.load error:", err2);
            return reject(err2);
          }
          console.log("[cast] media loaded OK, status:", JSON.stringify(status));

          // Subscribe to media status updates (push from device ~every 1s)
          player.on("status", (status) => {
            if (!status) return;
            console.log("[cast] status update:", status.playerState, "t=", status.currentTime);
            const prevState = session.playerState;
            session.currentTime = status.currentTime ?? session.currentTime;
            session.duration = status.media?.duration ?? session.duration;
            session.playerState = status.playerState ?? session.playerState;

            // If the device went IDLE well into playback, the stream likely ended.
            // Only clean up HLS if we've actually played a meaningful amount (>30s),
            // to avoid destroying the session during early buffering/startup glitches.
            if (
              session.playerState === "IDLE" &&
              prevState === "PLAYING" &&
              session.currentTime > 30
            ) {
              console.log("[cast] device went IDLE after playing — cleaning up HLS session");
              if (session.hlsSessionId) {
                castHls.destroyHlsSession(session.hlsSessionId);
                session.hlsSessionId = null;
              }
            }

            sendTimeUpdate({
              currentTime: session.currentTime,
              duration: session.duration,
              playerState: session.playerState,
            });
          });

          resolve();
        });
      });
    });

    client.on("error", (err) => {
      console.error("[cast] client error:", err);
      if (session.state === "connecting") reject(err);
      else {
        session.state = "error";
        sendTimeUpdate({ currentTime: 0, duration: 0, playerState: "ERROR" });
      }
    });

    // Timeout after 15 s
    setTimeout(() => {
      if (session.state === "connecting") {
        console.error("[cast] connection timed out");
        reject(new Error("Connection timed out"));
      }
    }, 15000);
  });
}

async function controlChromecast(action, position, level) {
  const player = session.mediaPlayer;
  if (!player) throw new Error("No active media player");

  if (action === "pause") {
    await new Promise((res, rej) => player.pause((e) => e ? rej(e) : res()));
    session.playerState = "PAUSED";
  } else if (action === "resume") {
    await new Promise((res, rej) => player.play((e) => e ? rej(e) : res()));
    session.playerState = "PLAYING";
  } else if (action === "seek") {
    await new Promise((res, rej) => player.seek(position, (e) => e ? rej(e) : res()));
    session.currentTime = position;
  } else if (action === "volume") {
    const client = session.castClient;
    if (!client) throw new Error("No cast client");
    await new Promise((res, rej) =>
      client.setVolume({ level: Math.max(0, Math.min(1, level)) }, (e) => e ? rej(e) : res())
    );
  }
}

// ── DLNA connection + control ─────────────────────────────────────────────────

async function connectDlna(device, streamUrl) {
  session.type = "dlna";
  session.dlnaHost = device.host;
  session.dlnaPort = device.port;
  session.dlnaControlUrl = device.controlUrl;

  await dlnaSetUri(device.host, device.port, device.controlUrl, streamUrl);
  await dlnaPlay(device.host, device.port, device.controlUrl);

  // DLNA has no push: poll GetPositionInfo every 5 s and emit time-update
  session.mediaStatusInterval = setInterval(async () => {
    if (session.state !== "casting") return;
    try {
      const pos = await dlnaGetPositionInfo(
        session.dlnaHost, session.dlnaPort, session.dlnaControlUrl
      );
      session.currentTime = pos.currentTime;
      session.duration = pos.duration;
      sendTimeUpdate({
        currentTime: session.currentTime,
        duration: session.duration,
        playerState: "PLAYING",
      });
    } catch {}
  }, 5000);
}

async function controlDlna(action, position) {
  const { dlnaHost: host, dlnaPort: port, dlnaControlUrl: url } = session;
  if (!host) throw new Error("No active DLNA session");

  if (action === "pause") {
    await dlnaPause(host, port, url);
    session.playerState = "PAUSED";
  } else if (action === "resume") {
    await dlnaPlay(host, port, url);
    session.playerState = "PLAYING";
  } else if (action === "seek") {
    await dlnaSeek(host, port, url, position);
    session.currentTime = position;
  }
  // DLNA volume control varies widely by device; omit for now
}

module.exports = { register };
