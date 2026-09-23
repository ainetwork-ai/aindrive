/**
 * /oauth/authorize — OAuth consent screen for remote-MCP clients.
 * Validates the request server-side, sends anonymous users through /login
 * (returning here), then renders the Approve/Deny form (./consent-form.tsx),
 * which POSTs to /api/oauth/authorize. See app/mcp/README.md.
 */
import { redirect } from "next/navigation";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { validateAuthorize, type AuthorizeParams } from "@/lib/oauth";
import { clampScope } from "@/lib/mcp-tokens";
import { ConsentForm } from "./consent-form";

export const dynamic = "force-dynamic";

const KEYS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "scope", "state", "resource"] as const;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white border border-drive-border rounded-2xl p-6 shadow-drive">{children}</div>
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const params: AuthorizeParams = {};
  for (const k of KEYS) {
    const v = sp[k];
    params[k] = typeof v === "string" ? v : null;
  }

  const v = validateAuthorize(params);
  if (!v.ok) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Can&apos;t connect this app</h1>
        <p className="mt-3 text-sm text-drive-muted">{v.error}</p>
      </Shell>
    );
  }

  const user = await getUser();
  if (!user) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, x]) => x) as [string, string][]);
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);
  }

  const drive = getDrive(v.value.driveId);
  const ceiling = drive ? clampScope(drive.id, user.id, "write") : null;
  if (!drive || !ceiling) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">No access to this drive</h1>
        <p className="mt-3 text-sm text-drive-muted">
          Signed in as {user.email}, who isn&apos;t a member of this drive. Ask the owner to invite you, or sign in with another account.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <ConsentForm
        params={params}
        clientName={v.value.client.client_name}
        redirectHost={new URL(v.value.redirectUri).host || v.value.redirectUri}
        driveName={drive.name}
        userEmail={user.email}
        canWrite={ceiling === "write"}
        requestedScope={v.value.requestedScope}
      />
    </Shell>
  );
}
