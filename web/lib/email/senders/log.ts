// Dev-only sender: prints the message (incl. the OTP code) to the server
// console instead of sending real email. Select via EMAIL_PROVIDER=log for
// LOCAL development where no SMTP creds exist. NOT silent — it surfaces the
// code in logs — and refuses to run in production so prod can't accidentally
// stop delivering reset codes.
import type { MailMessage, MailSender } from "../sender";

export const logSender: MailSender = {
  async send({ to, subject, text, html }: MailMessage): Promise<void> {
    if (process.env.NODE_ENV === "production") {
      throw new Error("EMAIL_PROVIDER=log is dev-only — set EMAIL_PROVIDER=smtp + SMTP_* in production");
    }
    // eslint-disable-next-line no-console
    console.log(`\n[email:log] DEV email (not sent)\n  to: ${to}\n  subject: ${subject}\n  body: ${text ?? html ?? "(empty)"}\n`);
  },
};
