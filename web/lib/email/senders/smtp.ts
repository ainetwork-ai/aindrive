// Self-hosted / provider SMTP transport (nodemailer). Reads SMTP_* from env.
// Reuses the same credentials as a2a-slack-notion (dev@ainetwork.ai via Gmail
// SMTP) — copy those values into web/.env.production; no new setup needed.
import nodemailer, { type Transporter } from "nodemailer";
import type { MailMessage, MailSender } from "../sender";

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  // Fail fast on missing creds — a silent no-mail SMTP would let reset codes
  // vanish without error. Surface a 500 at send time instead.
  if (!user || !pass) {
    throw new Error("SMTP_USER and SMTP_PASS must be set to send mail");
  }

  // Port 465 = implicit TLS; 587 = STARTTLS upgrade.
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return transporter;
}

export const smtpSender: MailSender = {
  async send({ to, subject, html, text }: MailMessage): Promise<void> {
    const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
    if (!from) throw new Error("EMAIL_FROM (or SMTP_USER) must be set to send mail");
    await getTransporter().sendMail({ from, to, subject, html, text });
  },
};
