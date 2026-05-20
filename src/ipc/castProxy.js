// ── Cast Proxy Server ──────────────────────────────────────────────────────────
//
// A lightweight HTTP proxy that the Chromecast uses to fetch video streams.
// This is necessary because many video servers don't send CORS headers, and
// the Chromecast's Default Media Receiver (a web app running in Chrome) blocks
// cross-origin responses without Access-Control-Allow-Origin.

const http = require("http");
const https = require("https");

let _server = null;
let _port = null;

/**
 * Probe the MP4 moov atom size by reading the first 64KB of the file and
 * scanning for the moov box header. If the moov atom is larger than 2MB,
 * the Chromecast 2nd gen will OOM trying to parse the chunk index.
 *
 * Returns 'HLS_NEEDED' if the moov is too large, 'BUFFERED' otherwise.
 * Falls back to 'BUFFERED' on any error (safe default).
 */
async function probeStreamType(url) {
  return new Promise((resolve) => {
    const isHttps = url.startsWith("https:");
    const lib = isHttps ? https : http;
    let parsed;
    try { parsed = new URL(url); } catch { return resolve("BUFFERED"); }

    // Fetch the first 65536 bytes — enough to find the moov box header
    // even when ftyp + free boxes precede it.
    const options = {
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port) : (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        host: parsed.hostname,
        range: "bytes=0-65535",
      },
      rejectUnauthorized: false,
      timeout: 10000,
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on("data", (d) => {
        chunks.push(d);
        // Stop once we have enough data
        const total = chunks.reduce((n, c) => n + c.length, 0);
        if (total >= 65536) {
          res.destroy();
          req.destroy();
        }
      });
      res.on("close", () => {
        if (!chunks.length) return resolve("BUFFERED");
        const buf = Buffer.concat(chunks);
        const moovSize = findMoovSize(buf);
        if (moovSize === null) {
          // moov not found in first 64KB — it's at the end (not faststart)
          // Chromecast must download the whole file first → use HLS
          console.log("[castProxy] probe: moov not in first 64KB → HLS_NEEDED");
          return resolve("HLS_NEEDED");
        }
        const MOOV_LIMIT = 2 * 1024 * 1024; // 2MB
        if (moovSize > MOOV_LIMIT) {
          console.log(`[castProxy] probe: moov too large (${(moovSize/1024/1024).toFixed(1)}MB > 2MB) → HLS_NEEDED`);
          resolve("HLS_NEEDED");
        } else {
          console.log(`[castProxy] probe: moov OK (${(moovSize/1024).toFixed(0)}KB) → BUFFERED`);
          resolve("BUFFERED");
        }
      });
      res.on("error", () => resolve("BUFFERED"));
    });
    req.on("error", () => resolve("BUFFERED"));
    req.on("timeout", () => { req.destroy(); resolve("BUFFERED"); });
    req.end();
  });
}

/**
 * Scan a buffer for an MP4 box named 'moov' and return its declared size.
 * Returns null if not found.
 */
function findMoovSize(buf) {
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const boxSize = buf.readUInt32BE(offset);
    const boxType = buf.slice(offset + 4, offset + 8).toString("ascii");
    if (boxType === "moov") {
      return boxSize;
    }
    if (boxSize < 8) break; // corrupt / unknown
    offset += boxSize;
  }
  return null;
}

// Headers we copy from the Chromecast's request to the upstream server
const CLIENT_HEADERS_TO_FORWARD = [
  "range",
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
  "if-range",
  "if-modified-since",
  "if-none-match",
];

// Hop-by-hop headers we strip from the upstream response before sending to Chromecast
const HOP_BY_HOP = new Set([
  "transfer-encoding",
  "connection",
  "keep-alive",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
]);

let _reqCount = 0;

function startProxy() {
  if (_server) return Promise.resolve(_port);

  return new Promise((resolve, reject) => {
    _server = http.createServer((req, res) => {
      const id = ++_reqCount;

      // CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Range, Content-Type",
          "Access-Control-Max-Age": "86400",
        });
        res.end();
        return;
      }

      // Extract ?url= raw. We encode & as %26 in buildProxyUrl to prevent the
      // & being interpreted as a second query param here. Restore it before
      // forwarding upstream. Do NOT use URL/URLSearchParams — they decode %XX
      // which would then re-encode and corrupt tokens like token=%3D.
      const qIdx = req.url.indexOf("?url=");
      if (qIdx === -1) {
        res.writeHead(400);
        res.end("Missing ?url= param");
        return;
      }
      const targetUrl = req.url.slice(qIdx + 5)
        .replace(/%26/gi, "&")
        .replace(/%20/g, " ");

      console.log(`[castProxy] #${id} ${req.method} ${req.headers["range"] || "no-range"} → ${targetUrl.slice(0, 80)}`);

      // Parse just the origin+path — keep search string raw to avoid re-encoding
      let hostname, port, pathname, search;
      try {
        const parsed = new URL(targetUrl);
        hostname = parsed.hostname;
        port = parsed.port ? parseInt(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
        pathname = parsed.pathname;
        search = parsed.search; // already encoded correctly
      } catch (e) {
        console.error(`[castProxy] #${id} invalid URL:`, e.message);
        res.writeHead(400);
        res.end("Invalid url param");
        return;
      }

      const isHttps = targetUrl.startsWith("https:");
      const lib = isHttps ? https : http;

      const forwardHeaders = { host: hostname };
      for (const h of CLIENT_HEADERS_TO_FORWARD) {
        if (req.headers[h]) forwardHeaders[h] = req.headers[h];
      }

      const options = {
        hostname,
        port,
        path: pathname + search,
        method: req.method,
        headers: forwardHeaders,
        rejectUnauthorized: false,
        timeout: 30000,
      };

      const proxyReq = lib.request(options, (proxyRes) => {
        console.log(`[castProxy] #${id} upstream status: ${proxyRes.statusCode}, content-length: ${proxyRes.headers["content-length"] || "none"}, content-range: ${proxyRes.headers["content-range"] || "none"}`);

        const outHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag",
        };

        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase())) {
            outHeaders[k] = v;
          }
        }

        // This CDN always returns bytes START-FILEEND regardless of the requested
        // range END, but sends content-length = only the requested slice size.
        // We need to:
        //   1. Fix content-range to match what was actually requested
        //   2. Fix content-length to match the requested range
        //   3. Truncate the piped body at exactly content-length bytes
        const clientRange = req.headers["range"]; // e.g. "bytes=1048576-2097151"
        const upstreamRange = proxyRes.headers["content-range"]; // e.g. "bytes 1048576-3495450108/3495450109"
        const upstreamCL = proxyRes.headers["content-length"];

        let truncateBytes = null; // if set, stop piping after this many bytes

        if (clientRange && upstreamRange && upstreamCL) {
          const clientM = clientRange.match(/bytes=(\d+)-(\d+)/);
          const upstreamM = upstreamRange.match(/bytes (\d+)-(\d+)\/(\d+)/);

          if (clientM && upstreamM) {
            const reqStart  = parseInt(clientM[1]);
            const reqEnd    = parseInt(clientM[2]);
            const upStart   = parseInt(upstreamM[1]);
            const upEnd     = parseInt(upstreamM[2]);
            const total     = parseInt(upstreamM[3]);
            const claimedCL = parseInt(upstreamCL);
            const requestedLen = reqEnd - reqStart + 1;

            // Server delivered more range than requested (upEnd > reqEnd)
            // but content-length = requested length — truncate + fix headers
            if (upEnd > reqEnd && claimedCL === requestedLen) {
              console.log(`[castProxy] #${id} truncating response to ${requestedLen} bytes (server sent ${upEnd - upStart + 1})`);
              outHeaders["content-range"] = `bytes ${reqStart}-${reqEnd}/${total}`;
              outHeaders["content-length"] = String(requestedLen);
              truncateBytes = requestedLen;
            } else if (claimedCL !== upEnd - upStart + 1) {
              // content-length doesn't match range — fix content-length + range
              const actualLen = upEnd - upStart + 1;
              console.log(`[castProxy] #${id} fixing content-length: ${claimedCL} → ${actualLen}`);
              outHeaders["content-length"] = String(actualLen);
            }
          }
        }

        // For very large files (>500MB) delivered as a full stream (bytes=0-),
        // remove Content-Length so the Chromecast doesn't calculate a buffer
        // timeout based on the full file size and give up before playback starts.
        const isFullStream = !clientRange || clientRange === "bytes=0-" || clientRange.endsWith("-");
        const cl = parseInt(outHeaders["content-length"] || "0");
        if (isFullStream && cl > 500 * 1024 * 1024) {
          console.log(`[castProxy] #${id} removing content-length (${cl} bytes) for full stream`);
          delete outHeaders["content-length"];
        }

        res.writeHead(proxyRes.statusCode, outHeaders);

        proxyRes.on("error", (err) => {
          console.error(`[castProxy] #${id} upstream body error:`, err.message);
        });

        res.on("error", (err) => {
          console.error(`[castProxy] #${id} client write error:`, err.message);
          proxyRes.destroy();
        });

        res.on("close", () => {
          console.log(`[castProxy] #${id} client closed connection`);
          proxyRes.destroy();
        });

        proxyRes.on("end", () => {
          console.log(`[castProxy] #${id} upstream finished`);
        });

        if (truncateBytes !== null) {
          // Stream exactly truncateBytes bytes then end the response
          let sent = 0;
          proxyRes.on("data", (chunk) => {
            if (sent >= truncateBytes) return;
            const remaining = truncateBytes - sent;
            if (chunk.length <= remaining) {
              res.write(chunk);
              sent += chunk.length;
            } else {
              res.write(chunk.slice(0, remaining));
              sent = truncateBytes;
              proxyRes.destroy();
              res.end();
            }
          });
          proxyRes.on("end", () => res.end());
          proxyRes.on("error", () => res.end());
        } else {
          let sent = 0;
          const countStream = new (require("stream").Transform)({
            transform(chunk, enc, cb) { sent += chunk.length; cb(null, chunk); }
          });
          res.on("close", () => {
            console.log(`[castProxy] #${id} client closed after ${sent} bytes (moov ends at ~${6347716})`);
          });
          proxyRes.pipe(countStream).pipe(res, { end: true });
        }
      });

      proxyReq.on("timeout", () => {
        console.error(`[castProxy] #${id} upstream request timed out`);
        proxyReq.destroy();
        if (!res.headersSent) {
          res.writeHead(504);
          res.end("Gateway timeout");
        }
      });

      proxyReq.on("error", (err) => {
        console.error(`[castProxy] #${id} upstream connect error:`, err.message);
        if (!res.headersSent) {
          res.writeHead(502);
          res.end("Upstream error: " + err.message);
        }
      });

      req.on("error", (err) => {
        console.error(`[castProxy] #${id} client read error:`, err.message);
        proxyReq.destroy();
      });

      req.pipe(proxyReq, { end: true });
    });

    _server.on("error", reject);

    // Keep connections alive longer for large video files
    _server.keepAliveTimeout = 120000;
    _server.headersTimeout = 125000;

    _server.listen(0, "0.0.0.0", () => {
      _port = _server.address().port;
      console.log("[castProxy] proxy listening on port", _port);
      resolve(_port);
    });
  });
}

function stopProxy() {
  return new Promise((resolve) => {
    if (!_server) return resolve();
    _server.close(() => {
      _server = null;
      _port = null;
      resolve();
    });
  });
}

function getPort() {
  return _port;
}

/**
 * Build a proxied URL that the Chromecast (on the same LAN) can reach.
 * @param {string} localIp  - LAN IP of this machine, e.g. "192.168.0.183"
 * @param {string} origUrl  - original video URL (may contain %XX sequences)
 * @returns {string}
 */
function buildProxyUrl(localIp, origUrl) {
  if (!_port) throw new Error("Proxy not started");
  // Encode only & and space — do NOT use encodeURIComponent which would
  // double-encode existing %XX sequences (e.g. token=%3D → %253D).
  const safe = origUrl.replace(/&/g, "%26").replace(/ /g, "%20");
  return `http://${localIp}:${_port}/proxy?url=${safe}`;
}

module.exports = { startProxy, stopProxy, getPort, buildProxyUrl, probeStreamType };
