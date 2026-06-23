// ============================================
// LINE FAQ Bot — メール送信専用 GAS Web API
// 役割：NetlifyからPOSTを受け取り、指定された担当部署のアドレスへメールを送るだけ
// ============================================

// Netlifyと共有する合言葉（推測されにくい長い文字列にする）
// Netlify側の環境変数 GAS_SECRET と同じ値にすること
const SHARED_SECRET = "ここに長いランダム文字列を入れる_例_a8Kd92xQ";

// 万一 to が空で届いた場合のフォールバック送信先（代表窓口など）
const FALLBACK_ADDRESS = "daihyou@example.com";

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // 合言葉チェック（無関係なPOSTを弾く簡易認証）
    if (body.secret !== SHARED_SECRET) {
      return jsonResponse({ ok: false, error: "unauthorized" });
    }

    const to = body.to || FALLBACK_ADDRESS;       // 送信先（部署マスタのメール）
    const dept = body.dept || "(未振り分け)";       // 部署名
    const question = body.question || "(質問不明)";
    const userId = body.userId || "(不明)";
    const time = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

    const subject = "【LINE未回答】" + dept + "宛のお問い合わせ";
    const mailBody =
      "LINE公式アカウントに、FAQで自動回答できないお問い合わせが届きました。\n" +
      "AIが推定した担当部署：" + dept + "\n\n" +
      "──────────────\n" +
      "受信日時：" + time + "\n" +
      "ユーザーID：" + userId + "\n" +
      "質問内容：\n" + question + "\n" +
      "──────────────\n\n" +
      "シートの「LINE未回答ログ」に回答を記入し、採用フラグを立てると\n" +
      "次回から自動応答できるようになります。";

    MailApp.sendEmail(to, subject, mailBody);

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
