// LINE FAQ Bot - Netlify Function
// LINE Webhook → 署名検証 → Googleシート(FAQ参照) → Claude → LINE返信 → 未回答ログ記録

const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { GoogleAuth } = require("google-auth-library");

// ---- 環境変数 ----
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHEET_ID = process.env.SHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;   // 電話受付と同じ値を流用
const SA_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"); // \n を改行に戻す
const GAS_MAIL_URL = process.env.GAS_MAIL_URL;   // GASのデプロイURL
const GAS_SECRET = process.env.GAS_SECRET;       // GASと共有する合言葉

// ---- シート名（電話受付と合わせる）----
const FAQ_TAB = "FAQ一覧";          // A列:質問 / B列:回答
const DEPT_TAB = "部署マスタ";       // A列:部署名 / B列:メール / C列:扱う内容
const LOG_TAB = "LINE未回答ログ";  // A:日時 B:ユーザーID C:質問 D:振り分け部署 E:送信先メール F:回答記入欄 G:採用フラグ

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ===== Claudeがmarkdownで包む対策（電話受付で入れたのと同じ）=====
function tryParseJson(text) {
  if (!text) return null;
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  }
  try { return JSON.parse(t); } catch { return null; }
}

// ===== Google Sheets アクセス =====
async function getAccessToken() {
  const auth = new GoogleAuth({
    credentials: {
      client_email: SA_EMAIL,
      private_key: SA_PRIVATE_KEY,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

async function readFaqSheet(token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(FAQ_TAB)}!A2:B`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return (data.values || []).map((r) => ({ q: r[0] || "", a: r[1] || "" }));
}

// 部署マスタを読む（A:部署名 B:メール C:扱う内容）
async function readDeptSheet(token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(DEPT_TAB)}!A2:C`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return (data.values || [])
    .map((r) => ({ name: r[0] || "", email: r[1] || "", scope: r[2] || "" }))
    .filter((d) => d.name && d.email);
}

async function appendLog(token, userId, question, deptName, deptEmail) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(LOG_TAB)}!A:G:append?valueInputOption=USER_ENTERED`;
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  // 日時 / ユーザーID / 質問 / 振り分け部署 / 送信先メール / 回答記入欄(空) / 採用フラグ(空)
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [[now, userId, question, deptName, deptEmail, "", ""]] }),
  });
}

// ===== 担当部署へメール通知（極小GASを叩く）=====
async function notifyByMail(toEmail, deptName, userId, question) {
  if (!GAS_MAIL_URL || !toEmail) return;
  try {
    await fetch(GAS_MAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: GAS_SECRET, to: toEmail, dept: deptName, userId, question }),
    });
  } catch (e) {
    console.error("MAIL NOTIFY FAILED:", e);
  }
}

// ===== Claude でFAQ照合＋未ヒット時の部署推定 =====
async function askClaude(faqList, deptList, userMessage) {
  const faqText = faqList.map((f, i) => `${i + 1}. Q:${f.q}\n   A:${f.a}`).join("\n");
  const deptText = deptList
    .map((d, i) => `${i + 1}. 部署名:${d.name} / 扱う内容:${d.scope}`)
    .join("\n");

  const system = `あなたは医療施設の問い合わせ対応AIです。
ユーザーの質問に対し、まず下記FAQで答えられるか判定してください。

# 判定ルール
- FAQで明確に答えられる場合: "matched": true とし "answer" に回答文を入れる。
- FAQに該当が無い/推測が必要な場合: "matched": false とし、下記の部署一覧から
  最も適切な担当部署を1つ選び "dept" にその部署名を正確に入れる。
  どこにも当てはまらない場合は、最も汎用的な受け皿部署を選ぶこと。

必ず次のJSON形式のみで出力（前置き・コードブロック禁止）:
{"matched": true/false, "answer": "回答文（matchedがtrueのとき）", "dept": "部署名（matchedがfalseのとき）"}

# FAQ
${faqText}

# 部署一覧
${deptText}`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 500,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const raw = msg.content[0]?.text || "";
  const parsed = tryParseJson(raw);
  if (!parsed) return { matched: false, answer: "", dept: "" };
  return parsed;
}

// ===== LINE 返信 =====
async function replyToLine(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

// ===== 署名検証 =====
function validateSignature(body, signature) {
  const hash = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

// ===== メインハンドラ =====
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const signature = event.headers["x-line-signature"];
  if (!validateSignature(event.body, signature)) {
    return { statusCode: 401, body: "Invalid signature" };
  }

  const body = JSON.parse(event.body);
  const events = body.events || [];

  // LINEには先に200を返す方が安全だが、reply tokenは1回限りなので
  // ここでは同期処理（Haikuは速いのでタイムアウト圏内に収まりやすい）
  for (const ev of events) {
    if (ev.type !== "message" || ev.message.type !== "text") continue;

    const userMessage = ev.message.text;
    const userId = ev.source?.userId || "(不明)";
    let replyText;

    try {
      const token = await getAccessToken();
      const faqList = await readFaqSheet(token);
      const deptList = await readDeptSheet(token);
      const result = await askClaude(faqList, deptList, userMessage);

      if (result.matched && result.answer) {
        replyText = result.answer;
      } else {
        replyText =
          "申し訳ございません。その内容はお調べして担当者よりご連絡いたします。お急ぎの場合はお電話ください。";

        // Claudeが推定した部署名から、部署マスタの送信先を引く
        const dept = deptList.find((d) => d.name === result.dept) || deptList[0] || null;
        const deptName = dept ? dept.name : "(未振り分け)";
        const deptEmail = dept ? dept.email : "";

        // 未回答ログに記録 → 該当部署へメール通知
        await appendLog(token, userId, userMessage, deptName, deptEmail);
        await notifyByMail(deptEmail, deptName, userId, userMessage);
      }
    } catch (e) {
      console.error("ERROR:", e);
      replyText = "申し訳ございません。ただいま混み合っております。少し時間をおいてお試しください。";
    }

    await replyToLine(ev.replyToken, replyText);
  }

  return { statusCode: 200, body: "OK" };
};
