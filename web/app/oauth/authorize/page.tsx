/**
 * /oauth/authorize — OAuth consent screen for remote-MCP clients and for
 * account grants ("Sign in with aindrive", no `resource`).
 * lib/oauth-authorize.ts decides the step: an invalid request renders its
 * error; an anonymous visitor signs in (AIN SSO when it is on) and comes back
 * to this same request; a trusted first-party client gets its code without
 * this screen; everyone else sees the Approve/Deny form (./consent-form.tsx),
 * which POSTs to /api/oauth/authorize. See app/mcp/README.md.
 */
import { redirect } from "next/navigation";
import { getDrive } from "@/lib/drives";
import { authorizeParamsFrom, authorizeStep } from "@/lib/oauth-authorize";
import { clampScope } from "@/lib/mcp-tokens";
import { AccountConsentForm, ConsentForm } from "./consent-form";

export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen min-h-dvh flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white border border-drive-border rounded-2xl p-6 shadow-drive">{children}</div>
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = authorizeParamsFrom(await searchParams);
  const step = await authorizeStep(params);
  if (step.kind === "invalid") {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Can&apos;t connect this app</h1>
        <p className="mt-3 text-sm text-drive-muted">{step.error}</p>
      </Shell>
    );
  }
  if (step.kind === "redirect") redirect(step.location);
  const { user, value } = step;

  const redirectHost = (() => { const u = new URL(value.redirectUri); return u.host ? `${u.protocol}//${u.host}` : value.redirectUri; })();

  if (value.driveId === null) {
    return (
      <Shell>
        <AccountConsentForm
          params={params}
          clientName={value.client.client_name}
          redirectHost={redirectHost}
          userEmail={user.email}
          scopes={value.accountScopes}
        />
      </Shell>
    );
  }

  const drive = getDrive(value.driveId);
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
        clientName={value.client.client_name}
        redirectHost={redirectHost}
        driveName={drive.name}
        userEmail={user.email}
        canWrite={ceiling === "write"}
        requestedScope={value.requestedScope}
      />
    </Shell>
  );
}
