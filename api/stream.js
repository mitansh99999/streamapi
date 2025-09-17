// api/stream.js
// ESM module for Vercel (Node 18+). Make sure package.json contains: "type": "module"

import crypto from "crypto";

/**
 * Simple in-memory concurrency guard (per instance).
 * Keep MAX_CONCURRENT small on free tiers.
 */
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_STREAMS || 10);
let activeStreams = 0;

function timingSafeCompare(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (e) {
    return false;
  }
}

function verifySig({ file_id, expires, sig }, secret) {
  const msg = `${file_id}:${expires}`;
  const h = crypto.createHmac("sha256", secret).update(msg).digest("hex");
  return timingSafeCompare(h, sig);
}

function isExpired(expires) {
  const ts = Number(expires || 0);
  if (!ts || Number.isNaN(ts)) return true;
  return Date.now() > ts * 1000;
}

/**
 * Main handler exported as default for Vercel.
 */
export default async function handler(req, res) {
  try {
    const { file_id, expires, sig } = req.query || {};
    if (!file_id || !expires || !sig) {
      res.status(400).send("missing params (file_id, expires, sig required)");
      return;
    }

    const secret = process.env.SHARED_SECRET;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!secret || !botToken) {
      res.status(500).send("server misconfigured: missing SHARED_SECRET or TELEGRAM_BOT_TOKEN");
      return;
    }

    if (isExpired(expires)) {
      res.status(403).send("url expired");
      return;
    }
    if (!verifySig({ file_id, expires, sig }, secret)) {
      res.status(403).send("invalid signature");
      return;
    }

    // concurrency guard
    if (activeStreams >= MAX_CONCURRENT) {
      res.status(429).send("too many concurrent streams");
      return;
    }
    activeStreams += 1;

    // Step 1: call getFile to obtain file_path (Telegram API)
    const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(file_id)}`;

    let gfResp;
    try {
      gfResp = await fetch(getFileUrl);
    } catch (err) {
      console.error("Failed to fetch getFile:", err);
      activeStreams = Math.max(0, activeStreams - 1);
      res.status(502).send("failed to get file metadata (network error)");
      return;
    }

    if (!gfResp.ok) {
      const text = await gfResp.text().catch(() => "");
      console.error("getFile non-ok:", gfResp.status, text);
      activeStreams = Math.max(0, activeStreams - 1);
      res.status(502).send("failed to get file metadata (bad response)");
      return;
    }

    let gfJson;
    try {
      gfJson = await gfResp.json();
    } catch (err) {
      console.error("getFile json parse error:", err);
      activeStreams = Math.max(0, activeStreams - 1);
      res.status(502).send("failed to parse file metadata");
      return;
    }

    if (!gfJson.ok || !gfJson.result || !gfJson.result.file_path) {
      console.error("getFile result missing file_path:", JSON.stringify(gfJson));
      activeStreams = Math.max(0, activeStreams - 1);
      res.status(404).send("file not found");
      return;
    }

    const filePath = gfJson.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

    // Forward Range header if present
    const forwardHeaders = {};
    if (req.headers && req.headers.range) forwardHeaders.Range = req.headers.range;
    forwardHeaders["User-Agent"] = "vercel-telegram-proxy/1.0";

    let fileFetch;
    try {
      fileFetch = await fetch(fileUrl, { headers: forwardHeaders, method: "GET" });
    } catch (err) {
      console.error("Error fetching file URL:", err);
      activeStreams = Math.max(0, activeStreams - 1);
      res.status(502).send("failed to fetch file from Telegram");
      return;
    }

    // Forward status and essential headers
    res.status(fileFetch.status);
    const allowed = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "content-disposition",
      "cache-control",
      "last-modified",
    ];
    for (const [k, v] of fileFetch.headers.entries()) {
      if (allowed.includes(k.toLowerCase())) res.setHeader(k, v);
    }
    res.setHeader("X-Proxy-By", "vercel-telegram-proxy");

    // Optional throttle params
    const throttleBps = Number(process.env.DEFAULT_THROTTLE_BPS || 0) || 0; // bytes/sec
    const throttleWindow = 0.5; // seconds
    const bytesPerWindow = throttleBps ? Math.max(1, Math.floor(throttleBps * throttleWindow)) : null;
    let bytesSinceSleep = 0;

    // Stream body: browser expects streaming response; pipe chunks from Telegram to client
    const reader = fileFetch.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // value is a Uint8Array
        res.write(Buffer.from(value));

        if (throttleBps) {
          bytesSinceSleep += value.length;
          if (bytesSinceSleep >= bytesPerWindow) {
            await new Promise((r) => setTimeout(r, throttleWindow * 1000));
            bytesSinceSleep = 0;
          }
        }

        // if client disconnected, stop reading
        if (res.writableEnded) break;
      }
      res.end();
    } catch (err) {
      // network error or client aborted
      console.error("streaming error:", err);
      try { res.end(); } catch (e) {}
    } finally {
      activeStreams = Math.max(0, activeStreams - 1);
    }
  } catch (err) {
    console.error("handler top-level error:", err);
    try { if (!res.headersSent) res.status(500).send("internal error"); else res.end(); } catch (e) {}
    activeStreams = Math.max(0, activeStreams - 1);
  }
}
