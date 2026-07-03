// Mail entrypoint: pick the sender by EMAIL_PROVIDER and expose sendMail().
//   EMAIL_PROVIDER=smtp (default) → real SMTP (SMTP_* env)
//   EMAIL_PROVIDER=log            → dev console (no creds; throws in prod)
import type { MailMessage } from "./sender";
import { smtpSender } from "./senders/smtp";
import { logSender } from "./senders/log";

export type { MailMessage } from "./sender";

export function mailConfigured(): boolean {
  if ((process.env.EMAIL_PROVIDER || "smtp") === "log") return true;
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function sendMail(msg: MailMessage): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER || "smtp";
  const sender = provider === "log" ? logSender : smtpSender;
  await sender.send(msg);
}
