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
const { Client: CastClient, DefaultMediaReceiver } = require("castv2-client");
const { Client: SsdpClient } = require("node-ssdp");
const multicastDns = require("multicast-dns");

// ── Module state ──────────────────────────────────────────────────────────────

let _getMainWindow = null; // injected by register()

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
};

function resetSession() {
  if (session.castClient) {
    try { session.castClient.close(); } catch {}
  }
  if (session.mediaStatusInterval) {
    clearInterval(session.mediaStatusInterval);
    session.mediaStatusInterval = null;
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

function register(getMainWindow) {
  _getMainWindow = getMainWindow;

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
  ipcMain.handle("cast:connect", async (_, { deviceId, streamUrl, device }) => {
    console.log("[cast] cast:connect called — deviceId:", deviceId, "streamUrl:", streamUrl, "device:", JSON.stringify(device));
    if (session.state === "casting" || session.state === "connecting") {
      resetSession();
    }

    session.state = "connecting";
    session.deviceId = deviceId;

    try {
      if (device.type === "chromecast") {
        await connectChromecast(device, streamUrl);
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

function connectChromecast(device, streamUrl) {
  return new Promise((resolve, reject) => {
    console.log("[cast] connectChromecast start", device.host, device.port, streamUrl);
    const client = new CastClient();
    session.castClient = client;
    session.type = "chromecast";

    client.connect({ host: device.host, port: device.port }, () => {
      console.log("[cast] connected to Chromecast, launching DefaultMediaReceiver");
      client.launch(DefaultMediaReceiver, (err, player) => {
        if (err) {
          console.error("[cast] launch error:", err);
          return reject(err);
        }
        console.log("[cast] receiver launched, loading media:", streamUrl);
        session.mediaPlayer = player;

        // Detect stream type from URL
        const isHls = streamUrl.includes(".m3u8");
        const isDash = streamUrl.includes(".mpd");
        const contentType = isHls
          ? "application/x-mpegURL"
          : isDash
          ? "application/dash+xml"
          : "video/mp4";
        const streamType = "BUFFERED";

        console.log("[cast] contentType:", contentType, "streamType:", streamType);

        const media = {
          contentId: streamUrl,
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
            session.currentTime = status.currentTime ?? session.currentTime;
            session.duration = status.media?.duration ?? session.duration;
            session.playerState = status.playerState ?? session.playerState;

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
