// api/stream.js
// Node 18+ on Vercel (Edge runtime not required).
import crypto from "crypto";


// Config
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_STREAMS || 10); // tune for your plan
const DEFAULT_THROTTLE_BPS = Number(process.env.DEFAULT_THROTTLE_BPS || 0); // 0 = no throttle


// in-memory concurrency counter (simple guard). Note: serverless instances are ephemeral.
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


export default async function handler(req, res) {
try {
const { file_id, expires, sig } = req.query || {};
if (!file_id || !expires || !sig) return res.status(400).send("missing params");


const secret = process.env.SHARED_SECRET;
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!secret || !botToken) return res.status(500).send("server misconfigured");


if (isExpired(expires)) return res.status(403).send("url expired");
if (!verifySig({ file_id, expires, sig }, secret)) return res.status(403).send("invalid signature");


// concurrency guard
if (activeStreams >= MAX_CONCURRENT) return res.status(429).send("too many concurrent streams");
activeStreams += 1;


// Get Telegram file info
const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(file_id)}`;
const gfResp = await fetch(getFileUrl);
if (!gfResp.ok) {
activeStreams -= 1;
return res.status(502).send("failed to get file metadata");
}
const gfJson = await gfResp.json();
if (!gfJson.ok || !gfJson.result || !gfJson.result.file_path) {
activeStreams -= 1;
return res.status(404).send("file not found");
}
