# Vercel Telegram Stream Proxy

This small Vercel project provides a streaming proxy for Telegram files (files sent to your bot). It accepts a short-lived signed URL (HMAC) and streams the requested file from Telegram to the client, forwarding Range headers to support seeking.

## Files
- `api/stream.js` — main serverless function.
- `vercel.json` — Vercel config.
- `package.json` — minimal project metadata.

## Environment variables (set these in Vercel)
- `TELEGRAM_BOT_TOKEN` (required) — your bot token (keep private).
- `SHARED_SECRET` (required) — shared HMAC secret used to verify signed URLs (must match Render's signer).
- `MAX_CONCURRENT_STREAMS` (optional) — integer, default 10.
- `DEFAULT_THROTTLE_BPS` (optional) — bytes/sec to throttle each stream (0 = disabled).

## Signing URLs (on your Render app)
On Render, sign URLs using the same `SHARED_SECRET`:

```py
import hmac, hashlib, time, urllib.parse

def make_signed_url(vercel_base, shared_secret_bytes, file_id, ttl_seconds=300):
    expires = int(time.time()) + ttl_seconds
    msg = f\"{file_id}:{expires}\".encode()
    sig = hmac.new(shared_secret_bytes, msg, hashlib.sha256).hexdigest()
    qs = urllib.parse.urlencode({\"file_id\": file_id, \"expires\": expires, \"sig\": sig})
    return f\"{vercel_base}/api/stream?{qs}\"
```

Return the signed URL to clients (or embed in your HTML `<video>` tag). Keep TTL short (e.g., 2–10 minutes).

## Notes & Tips
- Vercel functions are stateless and typically scale horizontally; the in-memory `activeStreams` counter is per instance — for strong global concurrency control use an external store (Redis).
- Monitor Vercel bandwidth/runtime limits on your plan; if you need higher throughput consider Cloudflare Workers, a CDN, or object storage with signed URLs.
