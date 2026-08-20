"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const { GoogleAuth } = require("google-auth-library");

const SENDER_USER = defineString("SENDER_USER");
const FORWARD_ADDRESS = defineString("FORWARD_ADDRESS");

const SLOTS = new Set(["週3日", "週4日", "週5日", "スポット・単発", "未定・相談したい"]);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

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
  const name = String(body.name || "").trim();
  const slot = String(body.slot || "");
  const text = String(body.body || "").trim();
  const replyTo = String(body.reply_to || "").trim();
  const honeypot = String(body.website || "");
  if (honeypot !== "") return { ok: false, reason: "honeypot" };
  if (!name || name.length > 60) return { ok: false, reason: "name" };
  if (!SLOTS.has(slot)) return { ok: false, reason: "slot" };
  if (!text || text.length > 400) return { ok: false, reason: "body" };
  if (replyTo.length > 254 || !EMAIL_RE.test(replyTo)) return { ok: false, reason: "reply_to" };
  return { ok: true, name, slot, text, replyTo };
}

// 鍵ファイルなしの DWD: 実行 SA が signJwt で自身の assertion に署名し、
// SENDER_USER として gmail.send のアクセストークンを得る（詳細は README）
async function getGmailToken(subject) {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const { client_email: saEmail } = await auth.getCredentials();
  const client = await auth.getClient();
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    iss: saEmail,
    sub: subject,
    scope: "https://www.googleapis.com/auth/gmail.send",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 600,
  });
  const signRes = await client.request({
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:signJwt`,
    method: "POST",
    data: { payload },
  });
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signRes.data.signedJwt,
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

exports.contact = onRequest(
  { region: "asia-northeast1", maxInstances: 2, cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "?";
    if (rateLimited(ip)) {
      console.log("contact: rate-limited");
      res.status(429).send("送信回数が多すぎます。しばらく経ってからお試しください。");
      return;
    }
    const v = validate(req.body || {});
    if (!v.ok) {
      // 統治要件（GOV-0004）: 入力値はログに残さない。理由コードのみ
      console.log(`contact: rejected (${v.reason})`);
      if (v.reason === "honeypot") {
        res.redirect(303, "/thanks.html");
        return;
      }
      res.status(400).send("入力内容をご確認ください（未入力または形式エラーの項目があります）。");
      return;
    }
    try {
      const sender = SENDER_USER.value();
      const forward = FORWARD_ADDRESS.value();
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
      res.redirect(303, "/thanks.html");
    } catch (err) {
      // ログは固定コードのみ（GOV-0004）。自前 throw の固定文言だけ通し、
      // ライブラリ内部例外は err.name に丸めて想定外の詳細が混入する芽を摘む
      const known = /^(token exchange failed|gmail send failed): \d+$/.test(err?.message || "");
      console.error(`contact: error (${known ? err.message : err?.name || "internal_error"})`);
      res
        .status(500)
        .send("送信処理でエラーが発生しました。お手数ですが、時間をおいて再度お試しください。");
    }
  }
);
