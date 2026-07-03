// Transactional email sending — a tiny interface so the transport (SMTP now,
// anything later) is swappable, and callers never touch nodemailer directly.
// Config values (SMTP_*) are reused from the ainetwork dev@ainetwork.ai mailbox
// (Gmail SMTP), same as the a2a-slack-notion project.

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export interface MailSender {
  send(msg: MailMessage): Promise<void>;
}
