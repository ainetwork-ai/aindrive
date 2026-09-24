/**
 * The name an app gives itself when it starts a sign-in pairing
 * (/api/auth/cli/start `client_name`). Only words the approval page, so it is
 * trimmed to one short printable line — no control characters, no markup
 * room, nothing that could pass for part of the page's own text.
 */
export function clientNameOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "")
    .trim()
    .slice(0, 40);
  return name || null;
}
