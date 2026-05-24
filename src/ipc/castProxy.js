// ── Cast Proxy Server ──────────────────────────────────────────────────────────
//
// A lightweight HTTP proxy that the Chromecast uses to fetch video streams.
// This is necessary because many video servers don't send CORS headers, and
// the Chromecast's Default Media Receiver (a web app running in Chrome) blocks
// cross-origin responses without Access-Control-Allow-Origin.

const http = require("http");
const https = require("https");
const os = require("os");
const zlib = require("zlib");

let _server = null;
let _port = null;

// Cookies de sessão por hostname — preenchidos pelo cast.js antes de conectar
const _domainCookies = {};

/**
 * Armazena cookies de sessão para um hostname específico.
 * Chamado pelo cast.js antes de iniciar a sessão de cast.
 * @param {string} hostname
 * @param {string} cookieStr  Formato "name=value; name2=value2"
 */
function setDomainCookies(hostname, cookieStr) {
  if (cookieStr) {
    _domainCookies[hostname] = cookieStr;
    console.log(`[castProxy] cookies armazenados para ${hostname} (${cookieStr.length} chars)`);
  } else {
    delete _domainCookies[hostname];
  }
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Detecta IP LAN (mesmo algoritmo do cast.js) ───────────────────────────────
function _pickLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const [, addrs] of Object.entries(ifaces)) {
    for (const a of addrs) {
      if (a.family !== "IPv4" || a.internal) continue;
      const p = a.address.split(".").map(Number);
      const isPrivate =
        p[0] === 10 ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
        (p[0] === 192 && p[1] === 168);
      if (isPrivate) return a.address;
    }
  }
  return "127.0.0.1";
}

// ── Reescrita de URLs dentro de playlists HLS ─────────────────────────────────
// Garante que o Chromecast acesse TODOS os recursos (playlists de qualidade,
// segmentos .ts, etc.) através do proxy local, evitando bloqueios de CORS e
// autenticação por sessão de browser.
function rewriteHlsUrls(content, originalUrl) {
  const localIp = _pickLocalIp();
  const proxyBase = `http://${localIp}:${_port}`;

  let baseOrigin, basePath;
  try {
    const u = new URL(originalUrl);
    baseOrigin = `${u.protocol}//${u.host}`;
    basePath = originalUrl.substring(0, originalUrl.lastIndexOf("/") + 1);
  } catch {
    return content; // URL inválida — retorna sem modificar
  }

  const lines = content.split("\n");
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();

    // Linha vazia ou tag HLS → mantém
    if (trimmed === "" || trimmed.startsWith("#")) {
      // Mas reescreve URI="..." dentro de tags como #EXT-X-MAP:URI="..."
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const abs = resolveUrl(uri, baseOrigin, basePath);
        const safe = abs.replace(/&/g, "%26").replace(/ /g, "%20");
        return `URI="${proxyBase}/proxy?url=${safe}"`;
      });
    }

    // Linha de URL de recurso (quality playlist, segment, etc.)
    const abs = resolveUrl(trimmed, baseOrigin, basePath);
    const safe = abs.replace(/&/g, "%26").replace(/ /g, "%20");
    return `${proxyBase}/proxy?url=${safe}`;
  });

  return rewritten.join("\n");
}

function resolveUrl(url, baseOrigin, basePath) {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return baseOrigin + url;
  return basePath + url; // relativo
}

/**
 * Probe the MP4 moov atom size by reading the first 64KB of the file and
 * scanning for the moov box header. If the moov atom is larger than 2MB,
 * the Chromecast 2nd gen will OOM trying to parse the chunk index.
 *
 * Returns 'HLS_NEEDED' if the moov is too large, 'BUFFERED' otherwise.
 * Falls back to 'BUFFERED' on any error (safe default).
 */
async function probeStreamType(url, cookieStr) {
  return new Promise((resolve) => {
    const isHttps = url.startsWith("https:");
    const lib = isHttps ? https : http;
    let parsed;
    try { parsed = new URL(url); } catch { return resolve("BUFFERED"); }

    // Fetch the first 65536 bytes — enough to find the moov box header
    // even when ftyp + free boxes precede it.
    const probeHeaders = {
      host: parsed.hostname,
      range: "bytes=0-65535",
      "user-agent": BROWSER_UA,
      "referer": `https://${parsed.hostname}/`,
    };
    // Injeta cookies se disponíveis (necessário para servidores protegidos por Cloudflare)
    const domainCookie = cookieStr || _domainCookies[parsed.hostname] || "";
    if (domainCookie) {
      probeHeaders["cookie"] = domainCookie;
      console.log(`[castProxy] probe: usando cookies para ${parsed.hostname}`);
    }
    const options = {
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port) : (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: probeHeaders,
      rejectUnauthorized: false,
      timeout: 10000,
    };

    console.log("[castProxy] probe iniciada para:", url);
    const req = lib.request(options, (res) => {
      console.log(`[castProxy] probe — status HTTP: ${res.statusCode}`);
      console.log(`[castProxy] probe — headers upstream:`, JSON.stringify({
        "content-type"  : res.headers["content-type"],
        "content-length": res.headers["content-length"],
        "content-range" : res.headers["content-range"],
        "accept-ranges" : res.headers["accept-ranges"],
        "server"        : res.headers["server"],
        "location"      : res.headers["location"], // redirect?
      }));

      if (res.statusCode === 403 || res.statusCode === 401 || res.statusCode === 404) {
        console.log(`[castProxy] ❌ probe bloqueada — status ${res.statusCode} (URL provavelmente exige cookies/referer)`);
        res.destroy();
        return resolve("BUFFERED"); // fallback; casting provavelmente vai falhar
      }
      if (res.statusCode >= 300 && res.statusCode < 400) {
        console.log(`[castProxy] ↪️ redirect para: ${res.headers["location"]}`);
      }

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
        if (!chunks.length) {
          console.log("[castProxy] probe: nenhum dado recebido → BUFFERED");
          return resolve("BUFFERED");
        }
        const buf = Buffer.concat(chunks);
        console.log(`[castProxy] probe: ${buf.length} bytes recebidos`);
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
      res.on("error", (e) => {
        console.error("[castProxy] probe erro de leitura:", e.message);
        resolve("BUFFERED");
      });
    });
    req.on("error", (e) => {
      console.error("[castProxy] probe erro de conexão:", e.message);
      resolve("BUFFERED");
    });
    req.on("timeout", () => {
      console.error("[castProxy] probe timeout — URL pode estar bloqueando requests sem browser");
      req.destroy();
      resolve("BUFFERED");
    });
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

// Headers we copy from the Chromecast's request to the upstream server.
// NOTE: "accept-encoding" is intentionally excluded — we need to inspect and
// potentially rewrite HLS playlist bodies before forwarding, so we always
// request uncompressed responses from upstream. (For large .ts segments the
// savings are negligible on a LAN anyway.)
const CLIENT_HEADERS_TO_FORWARD = [
  "range",
  "accept",
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

      // ── /mux endpoint — synthetic HLS master para streams demuxados ───────
      // Servidores com MSE usam playlists HLS separados para vídeo e áudio.
      // O Chromecast precisa de um master HLS que referencie ambos.
      // URL: /mux?v=VIDEO_URL&a=AUDIO_URL  (& encoded as %26 in each URL param)
      if (req.url.startsWith("/mux?") || req.url === "/mux") {
        const rawQ = req.url.indexOf("?") >= 0 ? req.url.slice(req.url.indexOf("?") + 1) : "";
        // Manual parse: find v= and &a= (can't use URLSearchParams — would double-decode %XX)
        // We look for &key= (with & prefix) to avoid false matches inside the v= value.
        // For the first param (v=) we allow it at position 0.
        const parseParam = (qs, key) => {
          // Try &key= first (not at start), then key= at the very start
          let valueStart;
          const withAmp = `&${key}=`;
          const idx = qs.indexOf(withAmp);
          if (idx >= 0) {
            valueStart = idx + withAmp.length;
          } else if (qs.startsWith(`${key}=`)) {
            valueStart = key.length + 1;
          } else {
            return null;
          }
          // Find next literal & — values have & encoded as %26 so this is the delimiter
          const nextAmp = qs.indexOf("&", valueStart);
          const raw = nextAmp >= 0 ? qs.slice(valueStart, nextAmp) : qs.slice(valueStart);
          return raw.replace(/%26/gi, "&").replace(/%20/g, " ");
        };

        const videoUrl = parseParam(rawQ, "v");
        const audioUrl = parseParam(rawQ, "a");

        if (!videoUrl) {
          res.writeHead(400);
          res.end("Missing v= param");
          return;
        }

        const localIp = _pickLocalIp();
        const proxyBase = `http://${localIp}:${_port}`;
        const vSafe = videoUrl.replace(/&/g, "%26");
        const aSafe = audioUrl ? audioUrl.replace(/&/g, "%26") : null;

        // Master HLS: Version 3 é o mais compatível com Chromecast 2nd gen.
        // Não incluímos CODECS no STREAM-INF para evitar mismatches com o real.
        let master = "#EXTM3U\n#EXT-X-VERSION:3\n\n";

        if (aSafe) {
          master += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="en",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="${proxyBase}/proxy?url=${aSafe}"\n\n`;
          master += `#EXT-X-STREAM-INF:BANDWIDTH=2500000,AUDIO="aud"\n`;
        } else {
          master += `#EXT-X-STREAM-INF:BANDWIDTH=2500000\n`;
        }
        master += `${proxyBase}/proxy?url=${vSafe}\n`;

        const buf = Buffer.from(master, "utf8");
        console.log(`[castProxy] /mux → master playlist gerado (${buf.length} bytes), videoUrl=${videoUrl.slice(0, 60)}, audioUrl=${audioUrl ? audioUrl.slice(0, 60) : "none"}`);
        res.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Content-Length": String(buf.length),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        });
        res.end(buf);
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

      // Injeta cookies de sessão (necessário para CDNs protegidos por Cloudflare)
      const domainCookie = _domainCookies[hostname] || "";
      if (domainCookie) {
        forwardHeaders["cookie"] = domainCookie;
        forwardHeaders["referer"] = `https://${hostname}/`;
        // Só sobrescreve user-agent se o Chromecast não enviou o seu próprio
        if (!forwardHeaders["user-agent"]) forwardHeaders["user-agent"] = BROWSER_UA;
        console.log(`[castProxy] #${id} 🍪 injetando cookies para ${hostname}`);
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
        const upCt = proxyRes.headers["content-type"] || "none";
        console.log(`[castProxy] #${id} upstream status: ${proxyRes.statusCode}, content-type: ${upCt}, content-length: ${proxyRes.headers["content-length"] || "none"}, content-range: ${proxyRes.headers["content-range"] || "none"}, content-encoding: ${proxyRes.headers["content-encoding"] || "none"}`);

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

        // ── HLS Segment Content-Type Override ────────────────────────────────
        // CDNs usam extensões fake (.html, .js, .css, .woff) para disfarçar
        // segmentos MPEG-TS. O content-type upstream seria "text/html" ou similar,
        // mas o Chromecast precisa de "video/MP2T" para aceitar o segmento.
        const urlHasVideoSegment = /\/Video\//i.test(targetUrl) || /\/Audio\//i.test(targetUrl);
        const ctIsFakeType = /text\/html|text\/javascript|application\/javascript|text\/css|font\/woff|application\/octet/i.test(upCt);
        if (urlHasVideoSegment && (ctIsFakeType || upCt === "none")) {
          outHeaders["content-type"] = "video/MP2T";
          console.log(`[castProxy] #${id} 🔧 content-type sobrescrito: ${upCt} → video/MP2T`);
        }

        // ── HLS Playlist Rewriting ──────────────────────────────────────────
        // Se a resposta for uma playlist HLS (detectada pelo Content-Type ou
        // pelo padrão da URL), bufferizamos o conteúdo, reescrevemos todas as
        // URLs internas para passarem pelo proxy e enviamos o resultado.
        // Isso é essencial para servers que usam MSE/XHR-based HLS onde os
        // segmentos não chegam ao Chromecast como requests diretos.
        const upstreamCt = (proxyRes.headers["content-type"] || "").toLowerCase();
        const upstreamCL = parseInt(proxyRes.headers["content-length"] || "0");
        const looksLikePlaylist =
          /mpegurl/i.test(upstreamCt) ||
          /\/hls\//i.test(targetUrl) ||
          /\.m3u8/i.test(targetUrl) ||
          /\/m3\//i.test(targetUrl) ||
          (upstreamCL > 0 && upstreamCL < 2 * 1024 * 1024 && /\.txt(\?|$)/i.test(targetUrl));

        if (looksLikePlaylist) {
          const chunks = [];
          proxyRes.on("data", (chunk) => chunks.push(chunk));
          proxyRes.on("end", async () => {
            let raw = Buffer.concat(chunks);

            // ── Descompressão (gzip/deflate/br) ───────────────────────────────
            // Alguns CDNs comprimem mesmo sem Accept-Encoding explícito.
            // O browser XHR descomprime transparente; nosso proxy precisa fazer o
            // mesmo antes de detectar #EXTM3U e reescrever URLs.
            const contentEncoding = (proxyRes.headers["content-encoding"] || "").toLowerCase();
            if (contentEncoding.includes("gzip") || raw[0] === 0x1f && raw[1] === 0x8b) {
              try {
                raw = await new Promise((ok, fail) => zlib.gunzip(raw, (e, r) => e ? fail(e) : ok(r)));
                console.log(`[castProxy] #${id} 🗜 gunzip: ${chunks.reduce((n, c) => n + c.length, 0)} → ${raw.length} bytes`);
              } catch (e) {
                console.warn(`[castProxy] #${id} gunzip falhou: ${e.message}`);
              }
            } else if (contentEncoding.includes("deflate")) {
              try {
                raw = await new Promise((ok, fail) => zlib.inflate(raw, (e, r) => e ? fail(e) : ok(r)));
                console.log(`[castProxy] #${id} 🗜 inflate: → ${raw.length} bytes`);
              } catch (e) {
                console.warn(`[castProxy] #${id} inflate falhou: ${e.message}`);
              }
            } else if (contentEncoding.includes("br")) {
              try {
                raw = await new Promise((ok, fail) => zlib.brotliDecompress(raw, (e, r) => e ? fail(e) : ok(r)));
                console.log(`[castProxy] #${id} 🗜 brotli: → ${raw.length} bytes`);
              } catch (e) {
                console.warn(`[castProxy] #${id} brotli falhou: ${e.message}`);
              }
            }
            // Remove content-encoding dos headers de saída (já descomprimimos)
            delete outHeaders["content-encoding"];

            const text = raw.toString("utf8", 0, Math.min(raw.length, 16)).trim();
            const isHlsPlaylist = text.startsWith("#EXTM3U");

            if (isHlsPlaylist) {
              const rewritten = rewriteHlsUrls(raw.toString("utf8"), targetUrl);
              const outBuf = Buffer.from(rewritten, "utf8");
              console.log(`[castProxy] #${id} ✅ HLS rewrite: ${raw.length} → ${outBuf.length} bytes`);
              // Loga as primeiras linhas da playlist reescrita para diagnóstico
              const playlistPreview = rewritten.split("\n").slice(0, 30).join("\n");
              console.log(`[castProxy] #${id} playlist (primeiras 30 linhas):\n${playlistPreview}`);
              outHeaders["content-type"] = "application/vnd.apple.mpegurl";
              outHeaders["content-length"] = String(outBuf.length);
              res.writeHead(proxyRes.statusCode, outHeaders);
              res.end(outBuf);
            } else {
              // Não é playlist HLS — loga os primeiros 200 bytes (hex) e chars para diagnóstico
              const previewHex = raw.slice(0, 32).toString("hex").replace(/../g, "$& ").trim();
              const previewTxt = raw.toString("utf8", 0, Math.min(raw.length, 200)).replace(/\n/g, "↵");
              console.log(`[castProxy] #${id} ⚠️ não é HLS (${upstreamCt || "sem content-type"}), ${raw.length} bytes`);
              console.log(`[castProxy] #${id} hex (primeiros 32 bytes): ${previewHex}`);
              console.log(`[castProxy] #${id} texto (início):           ${previewTxt}`);
              res.writeHead(proxyRes.statusCode, outHeaders);
              res.end(raw);
            }
          });
          proxyRes.on("error", (err) => {
            console.error(`[castProxy] #${id} upstream error (playlist buffer):`, err.message);
            if (!res.headersSent) res.writeHead(502).end("Upstream error");
          });
          return; // não cai no pipe abaixo
        }

        // ── Range fix (para MP4 com CDNs que não respeitam range end) ──────
        const clientRange = req.headers["range"];
        const upstreamRange = proxyRes.headers["content-range"];
        const rawCL = proxyRes.headers["content-length"];

        let truncateBytes = null;

        if (clientRange && upstreamRange && rawCL) {
          const clientM = clientRange.match(/bytes=(\d+)-(\d+)/);
          const upstreamM = upstreamRange.match(/bytes (\d+)-(\d+)\/(\d+)/);

          if (clientM && upstreamM) {
            const reqStart  = parseInt(clientM[1]);
            const reqEnd    = parseInt(clientM[2]);
            const upStart   = parseInt(upstreamM[1]);
            const upEnd     = parseInt(upstreamM[2]);
            const total     = parseInt(upstreamM[3]);
            const claimedCL = parseInt(rawCL);
            const requestedLen = reqEnd - reqStart + 1;

            if (upEnd > reqEnd && claimedCL === requestedLen) {
              console.log(`[castProxy] #${id} truncating response to ${requestedLen} bytes (server sent ${upEnd - upStart + 1})`);
              outHeaders["content-range"] = `bytes ${reqStart}-${reqEnd}/${total}`;
              outHeaders["content-length"] = String(requestedLen);
              truncateBytes = requestedLen;
            } else if (claimedCL !== upEnd - upStart + 1) {
              const actualLen = upEnd - upStart + 1;
              console.log(`[castProxy] #${id} fixing content-length: ${claimedCL} → ${actualLen}`);
              outHeaders["content-length"] = String(actualLen);
            }
          }
        }

        // Remove Content-Length para streams completos muito grandes
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
          proxyRes.destroy();
        });

        proxyRes.on("end", () => {
          console.log(`[castProxy] #${id} upstream finished`);
        });

        if (truncateBytes !== null) {
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
          let _sniffed = false;
          const countStream = new (require("stream").Transform)({
            transform(chunk, enc, cb) {
              sent += chunk.length;
              if (!_sniffed) {
                _sniffed = true;
                const peek = chunk.slice(0, 16);
                const hexSniff = peek.toString("hex").replace(/../g, "$& ").trim();
                const isMpegTs = peek[0] === 0x47;
                const isMp4 = peek.length >= 8 &&
                  ["ftyp", "moof", "moov"].includes(peek.slice(4, 8).toString("ascii"));
                const fmt = isMpegTs ? "MPEG-TS" : isMp4 ? "fMP4" : "?";
                console.log(`[castProxy] #${id} 🔍 segment fmt: ${fmt} | hex: ${hexSniff}`);
              }
              cb(null, chunk);
            },
            flush(cb) {
              console.log(`[castProxy] #${id} ✅ segment done — ${sent} bytes total`);
              cb();
            },
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

/**
 * Build a /mux URL that serves a synthetic HLS master playlist combining
 * separate video and audio streams (used for MSE-demuxed servers).
 * @param {string} localIp   - LAN IP of this machine
 * @param {string} videoUrl  - original URL of the video HLS playlist
 * @param {string} audioUrl  - original URL of the audio HLS playlist (may be null)
 * @returns {string}
 */
function buildMuxUrl(localIp, videoUrl, audioUrl) {
  if (!_port) throw new Error("Proxy not started");
  const vSafe = videoUrl.replace(/&/g, "%26").replace(/ /g, "%20");
  let url = `http://${localIp}:${_port}/mux?v=${vSafe}`;
  if (audioUrl) {
    const aSafe = audioUrl.replace(/&/g, "%26").replace(/ /g, "%20");
    url += `&a=${aSafe}`;
  }
  return url;
}

module.exports = { startProxy, stopProxy, getPort, buildProxyUrl, buildMuxUrl, probeStreamType, setDomainCookies };
