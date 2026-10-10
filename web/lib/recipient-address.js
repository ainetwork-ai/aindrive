// A recipient address selects a grant target, never a login identity. Only
// active, signed provisioning from the configured issuer supplies aliases.
import { db } from './db.js';
import { z } from 'zod';
export function normalizedRecipientEmail(value) {
  if (typeof value !== 'string') return null;
  const email=value.trim().toLowerCase();
  if (!z.string().email().max(320).safeParse(email).success || /@(sso|wallet)\.aindrive\.local$/.test(email)) return null;
  return email;
}
export function recipientForEmail(value) {
  const email=normalizedRecipientEmail(value);
  if (!email) return {userId:null,ambiguous:false};
  const ids=new Set(db.prepare('SELECT id FROM users WHERE lower(email)=?').all(email).map(r=>r.id));
  const issuer=(process.env.AINDRIVE_SSO_ISSUER || '').trim();
  if (issuer && (process.env.AINDRIVE_SSO_CLIENT_ID || '').trim()) {
    for(const r of db.prepare(`SELECT DISTINCT m.user_id FROM sso_memberships m
      JOIN sso_identities i ON i.issuer=m.issuer AND i.subject=m.subject AND i.user_id=m.user_id
      JOIN users u ON u.id=m.user_id
      WHERE m.issuer=? AND m.status='active' AND m.work_email=?`).all(issuer,email)) ids.add(r.user_id);
  }
  return {userId:ids.size===1?[...ids][0]:null,ambiguous:ids.size>1};
}
