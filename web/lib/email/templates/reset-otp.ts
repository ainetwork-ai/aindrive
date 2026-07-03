// Password-reset OTP email (plain HTML string + plaintext). aindrive branding;
// structure mirrors a2a-slack-notion's otp-code template so the ainetwork
// transactional mail looks consistent.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderResetOtpEmail({
  code,
  expiresInMinutes,
}: {
  code: string;
  expiresInMinutes: number;
}): { subject: string; html: string; text: string } {
  const safeCode = escapeHtml(code);
  const subject = "aindrive 비밀번호 재설정 코드";

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>aindrive 비밀번호 재설정</title>
  </head>
  <body style="background-color:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;margin:0;padding:0;">
    <div style="max-width:560px;margin:0 auto;padding:40px 20px;">
      <div style="background-color:#ffffff;border-radius:12px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <h1 style="color:#111827;font-size:20px;font-weight:600;margin:0 0 16px;">비밀번호 재설정</h1>
        <p style="color:#4b5563;font-size:15px;line-height:1.6;margin:0 0 16px;">아래 6자리 코드를 입력해 비밀번호를 재설정하세요.</p>
        <div style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px 24px;margin:24px 0;text-align:center;">
          <p style="color:#111827;font-size:32px;font-weight:700;letter-spacing:12px;margin:0;font-family:'SF Mono','Menlo','Monaco',monospace;">${safeCode}</p>
          <p style="color:#6b7280;font-size:13px;margin:8px 0 0;">이 코드는 ${expiresInMinutes}분 동안 유효합니다.</p>
        </div>
        <p style="color:#4b5563;font-size:15px;line-height:1.6;margin:0 0 16px;">본인이 요청하지 않았다면 이 이메일을 무시하세요. 비밀번호는 그대로 유지됩니다. 코드를 다른 사람과 공유하지 마세요.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 16px;" />
        <p style="color:#9ca3af;font-size:12px;line-height:1.6;margin:0;">aindrive · 계정 보안 메일</p>
      </div>
    </div>
  </body>
</html>`;

  const text = [
    "aindrive 비밀번호 재설정",
    "",
    "아래 6자리 코드를 입력해 비밀번호를 재설정하세요.",
    "",
    `재설정 코드: ${code}`,
    `이 코드는 ${expiresInMinutes}분 동안 유효합니다.`,
    "",
    "본인이 요청하지 않았다면 이 이메일을 무시하세요. 코드를 다른 사람과 공유하지 마세요.",
    "",
    "aindrive · 계정 보안 메일",
  ].join("\n");

  return { subject, html, text };
}
