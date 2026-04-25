import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { isAddress, verifyMessage } from "viem";
import { db } from "@/lib/db";
import { getWallet, setWalletCookie } from "@/lib/wallet";
import { getDriveNamespace } from "@/lib/drives";
import { issueShareCap } from "@/lib/willow/cap-issue";

const Body = z.object({
  txHash: z.string().min(2),
  payerAddress: z.string().refine((v) => isAddress(v), "invalid address").optional(),
  signature: z.string().optional(),
});

type ShareRow = {
  id: string;
  drive_id: string;
  path: string;
  role: string;
  price_usdc: number | null;
  payment_chain: string | null;
};

const DEV_BYPASS = process.env.AINDRIVE_DEV_BYPASS_X402 === "1";

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });

  const share = db.prepare(
    "SELECT id, drive_id, path, role, price_usdc, payment_chain FROM shares WHERE token = ?"
  ).get(token) as ShareRow | undefined;
  if (!share) return NextResponse.json({ error: "share not found" }, { status: 404 });
  if (!share.price_usdc) return NextResponse.json({ error: "share is free, no payment needed" }, { status: 400 });

  // Determine payer wallet: from cookie OR explicit payerAddress + verified signature.
  // In dev bypass mode, fall back to a deterministic demo wallet so the paywall flow
  // can be exercised without ever connecting a real wallet.
  let payer = await getWallet();
  if (!payer && body.data.payerAddress && body.data.signature) {
    const msg = `aindrive payment for ${token}: ${body.data.txHash}`;
    const ok = await verifyMessage({
      address: body.data.payerAddress as `0x${string}`,
      message: msg,
      signature: body.data.signature as `0x${string}`,
    });
    if (ok) payer = body.data.payerAddress.toLowerCase();
  }
  if (!payer && DEV_BYPASS) {
    payer = "0xdemodemodemodemodemodemodemodemodemo0000";
  }
  if (!payer) {
    return NextResponse.json({ error: "no payer wallet identified" }, { status: 400 });
  }

  // Verify payment via facilitator (skipped in dev bypass mode)
  if (!DEV_BYPASS) {
    const facilitator = process.env.AINDRIVE_X402_FACILITATOR || "https://x402.org/facilitator";
    try {
      const verifyRes = await fetch(`${facilitator}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          txHash: body.data.txHash,
          network: share.payment_chain || "base-sepolia",
          expectedAmount: share.price_usdc,
          expectedAsset: "USDC",
          expectedRecipient: process.env.AINDRIVE_PAYOUT_WALLET,
          payer,
        }),
      });
      if (!verifyRes.ok) {
        return NextResponse.json({ error: "payment verification failed" }, { status: 402 });
      }
    } catch (e) {
      return NextResponse.json({ error: `facilitator unreachable: ${(e as Error).message}` }, { status: 502 });
    }
  } else {
    console.log(`[x402 DEV BYPASS] accepting payment ${body.data.txHash} from ${payer} for ${token}`);
  }

  // INSERT folder_access (idempotent on UNIQUE conflict). Role copies from the share definition.
  try {
    db.prepare(
      "INSERT INTO folder_access (id, drive_id, path, wallet_address, added_by, payment_tx, role) VALUES (?, ?, ?, ?, 'payment', ?, ?)"
    ).run(nanoid(12), share.drive_id, share.path, payer, body.data.txHash, share.role);
  } catch (e) {
    if (!/UNIQUE/i.test((e as Error).message)) throw e;
    // already had access — upgrade role if share grants more
    db.prepare(
      "UPDATE folder_access SET role = ? WHERE drive_id = ? AND path = ? AND wallet_address = ?"
    ).run(share.role, share.drive_id, share.path, payer);
  }

  // Bind this wallet to the visitor's session so subsequent requests authorize them.
  await setWalletCookie(payer);

  // Issue Meadowcap cap (portable access proof)
  let capBase64: string | null = null;
  const ns = getDriveNamespace(share.drive_id);
  if (ns) {
    try {
      const issued = await issueShareCap({
        namespacePub: ns.pub,
        namespaceSecret: ns.secret,
        pathPrefix: share.path,
        accessMode: "read",
      });
      capBase64 = issued.capBase64;
    } catch (e) {
      console.warn("cap issuance failed:", (e as Error).message);
    }
  }

  return NextResponse.json({
    ok: true,
    payer,
    driveId: share.drive_id,
    path: share.path,
    cap: capBase64,
  });
}
