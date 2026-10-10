// Client-safe reader for ainize Projects (ainize-node docs/PROJECTS.md), used
// by the git panel's Deployments block. Everything here degrades silently: a
// 404 (no project), CORS refusal or network error answers null / [] — the
// panel then says the repo deploys on its next push, or shows nothing — never an
// error. There is no "connect" step: a push of a repo with `ainize.json` binds it
// (lib/git-project-hooks.ts autoBindProject).

export type AinizeProject = {
  id: string;
  org?: string;
  repoName?: string;
  repo: string;
  branch: string;
  kind: string;
  status: string;
  url?: string | null;
  /** The project's page on ainize (`${ainizeUrl}/projects/<id>` when absent). */
  pageUrl?: string | null;
  lastDeployment?: AinizeDeployment | null;
};

export type DeploymentStatus = "queued" | "building" | "ready" | "error";
export type AinizeDeployment = {
  id: string;
  projectId?: string;
  sha: string;
  ref?: string;
  status: DeploymentStatus;
  startedAt?: string | number | null;
  finishedAt?: string | number | null;
  ms?: number | null;
  exitCode?: number | null;
  error?: string | null;
  logUrl?: string | null;
  outputUrl?: string | null;
};

export const projectByRepoUrl = (ainizeUrl: string, cloneUrl: string) =>
  `${ainizeUrl}/api/projects/by-repo?repo=${encodeURIComponent(cloneUrl)}`;
export const projectDeploymentsUrl = (ainizeUrl: string, projectId: string) =>
  `${ainizeUrl}/api/projects/${encodeURIComponent(projectId)}/deployments`;
export const deploymentLogUrl = (ainizeUrl: string, d: AinizeDeployment) =>
  d.logUrl || `${ainizeUrl}/api/deployments/${encodeURIComponent(d.id)}/log`;
/** Where "Open in ainize" goes: the bound project's page, never the landing page. */
export const projectPageUrl = (ainizeUrl: string, p: Pick<AinizeProject, "id" | "pageUrl">) =>
  p.pageUrl || `${ainizeUrl}/projects/${encodeURIComponent(p.id)}`;

async function getJson<T>(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal, mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}

/** The project bound to a repo URL, or null (none / unreachable). */
export function fetchProjectByRepo(ainizeUrl: string, cloneUrl: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
  return getJson<AinizeProject>(projectByRepoUrl(ainizeUrl, cloneUrl), fetchImpl, signal);
}

/** Newest-first deployments of a project; [] when unreachable. Accepts a bare array or `{ deployments }`. */
export async function fetchDeployments(ainizeUrl: string, projectId: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal, limit = 5): Promise<AinizeDeployment[]> {
  const j = await getJson<AinizeDeployment[] | { deployments: AinizeDeployment[] }>(projectDeploymentsUrl(ainizeUrl, projectId), fetchImpl, signal);
  const list = Array.isArray(j) ? j : Array.isArray(j?.deployments) ? j.deployments : [];
  return list.filter((d) => d && typeof d.id === "string").slice(0, limit);
}

/** When the deployment happened, for a relative label: finishedAt, else startedAt. */
export function deploymentTime(d: AinizeDeployment): string {
  const t = d.finishedAt ?? d.startedAt;
  if (t === null || t === undefined) return "";
  return typeof t === "number" ? new Date(t).toISOString() : String(t);
}
