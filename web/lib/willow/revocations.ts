// Removed devices, kept centrally (plan 4 review I1): a revocation lives in the drive
// stores where the device was known when it was removed, and here, so the device can
// never get a new certificate or put one into a drive it joins later.
import { db } from "@/lib/db.js";

let ready = false;
function table() {
  if (ready) return;
  db.exec(`CREATE TABLE IF NOT EXISTS willow_revocations (
    user_id TEXT NOT NULL,
    device_key TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (user_id, device_key)
  )`);
  ready = true;
}

export function isRevoked(userId: string, deviceKeyHex: string): boolean {
  table();
  return !!db.prepare("SELECT 1 FROM willow_revocations WHERE user_id = ? AND device_key = ?").get(userId, deviceKeyHex);
}

export function recordRevocation(userId: string, deviceKeyHex: string, at: bigint): boolean {
  table();
  return db.prepare("INSERT OR IGNORE INTO willow_revocations (user_id, device_key, at) VALUES (?, ?, ?)").run(userId, deviceKeyHex, at.toString()).changes > 0;
}
