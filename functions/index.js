"use strict";

// LP フォーム受け口（Cloud Run・依存パッケージゼロ）
// 自作原則（Plan B ADR-0007 §3: 言語標準機能の水準）に従い Node 標準 + fetch のみで実装。
// 環境変数: SENDER_USER / FORWARD_ADDRESS / THANKS_URL（README 参照）

const http = require("http");
const { URLSearchParams } = require("url");

const PORT = process.env.PORT || 8080;
const ALLOWED_ORIGINS = new Set(["https://takeblueprint.com"]);
const SLOTS = new Set(["週3日", "週4日", "週5日", "スポット・単発", "未定・相談したい"]);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const MAX_BODY_BYTES = 32 * 1024;
const METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default";

// ベストエフォートのレート制限（インスタンス内メモリ・10分5回）
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 600000);
  if (recent.length >= 5) return true;
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10000) hits.clear();
  return false;
}

function validate(body) {
  const name = String(body.get("name") || "").trim();
  const slot = String(body.get("slot") || "");
  const text = String(body.get("body") || "").trim();
  const replyTo = String(body.get("reply_to") || "").trim();
  const honeypot = String(body.get("website") || "");
  if (honeypot !== "") return { ok: false, reason: "honeypot" };
  if (!name || name.length > 60) return { ok: false, reason: "name" };
  if (!SLOTS.has(slot)) return { ok: false, reason: "slot" };
  if (!text || text.length > 400) return { ok: false, reason: "body" };
  if (replyTo.length > 254 || !EMAIL_RE.test(replyTo)) return { ok: false, reason: "reply_to" };
  return { ok: true, name, slot, text, replyTo };
}

async function metadata(path) {
  const res = await fetch(`${METADATA}${path}`, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata failed: ${res.status}`);
  return res;
}

// 鍵ファイルなしの DWD: 実行 SA が IAM signJwt で自身の assertion に署名し、
// SENDER_USER として gmail.send のアクセストークンを得る（詳細は README）
async function getGmailToken(subject) {
  const saEmail = await (await metadata("/email")).text();
  const saToken = (await (await metadata("/token")).json()).access_token;
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    iss: saEmail,
    sub: subject,
    scope: "https://www.googleapis.com/auth/gmail.send",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 600,
  });
  const signRes = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:signJwt`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${saToken}`, "content-type": "application/json" },
      body: JSON.stringify({ payload }),
    }
  );
  if (!signRes.ok) throw new Error(`signJwt failed: ${signRes.status}`);
  const { signedJwt } = await signRes.json();
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJwt,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
  return (await tokenRes.json()).access_token;
}

function b64utf8(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

// 本文フォーマットは現行 mailto と同一＋「ご連絡先メールアドレス」行を追加。
// 下流（mail_bridge→intake）が読む形式なので変更時は両者を同時に見ること。
function buildMime(v, sender, forward) {
  const subject = `お問い合わせ（${v.name} 様）`;
  const bodyText = [
    `お名前: ${v.name}`,
    `ご希望の稼働枠: ${v.slot}`,
    `ご連絡先メールアドレス: ${v.replyTo}`,
    "",
    "ご相談内容:",
    v.text,
    "",
    "---",
    "送信元: takeblueprint.com お問い合わせフォーム（POST）",
  ].join("\r\n");
  const mime = [
    `From: ${sender}`,
    `To: ${forward}`,
    `Reply-To: ${v.replyTo}`,
    `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64utf8(bodyText),
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large: 0"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Connection: close を常時付与——ボディ未読のまま応答するパス（405/403/429）で
// keep-alive ソケットが再利用されると次リクエストがリセットされるため
function send(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  res.end(text);
}

function redirect(res, url) {
  res.writeHead(303, { location: url, connection: "close" });
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    send(res, 405, "Method Not Allowed");
    return;
  }
  // 自サイト外からの直接 POST の一次フィルタ（Origin を送らない旧環境・curl は通し、
  // 偽 Origin 明示のみ弾く。最終防壁は honeypot＋検証＋レート制限）
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    console.log("contact: rejected (origin)");
    send(res, 403, "Forbidden");
    return;
  }
  const ip =
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "?";
  if (rateLimited(ip)) {
    console.log("contact: rate-limited");
    send(res, 429, "送信回数が多すぎます。しばらく経ってからお試しください。");
    return;
  }
  const thanksUrl = process.env.THANKS_URL || "https://takeblueprint.com/thanks.html";
  try {
    const raw = await readBody(req);
    const v = validate(new URLSearchParams(raw));
    if (!v.ok) {
      // 統治要件（GOV-0004）: 入力値はログに残さない。理由コードのみ
      console.log(`contact: rejected (${v.reason})`);
      if (v.reason === "honeypot") {
        redirect(res, thanksUrl);
        return;
      }
      send(res, 400, "入力内容をご確認ください（未入力または形式エラーの項目があります）。");
      return;
    }
    const sender = process.env.SENDER_USER;
    const forward = process.env.FORWARD_ADDRESS;
    if (!sender || !forward) throw new Error("config missing: 0");
    const token = await getGmailToken(sender);
    const sendRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(sender)}/messages/send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ raw: buildMime(v, sender, forward) }),
      }
    );
    if (!sendRes.ok) throw new Error(`gmail send failed: ${sendRes.status}`);
    console.log("contact: forwarded");
    redirect(res, thanksUrl);
  } catch (err) {
    // ログは固定コードのみ（GOV-0004）。自前 throw の固定文言だけ通し、
    // 想定外の例外は err.name に丸めて詳細が混入する芽を摘む
    const known = /^(signJwt failed|token exchange failed|gmail send failed|config missing|body too large|metadata failed): \d+$/.test(
      err?.message || ""
    );
    console.error(`contact: error (${known ? err.message : err?.name || "internal_error"})`);
    send(res, 500, "送信処理でエラーが発生しました。お手数ですが、時間をおいて再度お試しください。");
  }
});

server.listen(PORT, () => console.log(`contact: listening on ${PORT}`));
