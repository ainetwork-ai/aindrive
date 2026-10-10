"use client";
// The ainize project bound to a repo, read once per folder from the browser
// (GET /api/projects/by-repo, then /api/projects/:id/deployments; lib/ainize-projects.ts)
// and shared by everything that links to ainize: the panel's Deployments block,
// the Run row's "Open in ainize", and the per-file run output. Refetched when
// HEAD moves (a push just landed) and every 15 s while a deployment is
// queued/building. Every failure degrades to "no project".
import { useEffect, useState } from "react";
import { fetchDeployments, fetchProjectByRepo, projectPageUrl, type AinizeDeployment, type AinizeProject } from "@/lib/ainize-projects";

export type AinizeProjectState = {
  /** undefined = loading, null = no project bound (yet) */
  project: AinizeProject | null | undefined;
  deployments: AinizeDeployment[];
  active: boolean;
  /** The project's page on ainize, or null while there is none — links are hidden then. */
  projectUrl: string | null;
};

export const NO_PROJECT: AinizeProjectState = { project: null, deployments: [], active: false, projectUrl: null };

export function useAinizeProject(ainizeUrl: string | null, cloneUrl: string | null, headSha: string | null, enabled: boolean): AinizeProjectState {
  const [state, setState] = useState<AinizeProjectState>({ project: undefined, deployments: [], active: false, projectUrl: null });
  useEffect(() => {
    if (!enabled || !ainizeUrl || !cloneUrl) { setState(NO_PROJECT); return; }
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    setState({ project: undefined, deployments: [], active: false, projectUrl: null });
    const load = async () => {
      const p = await fetchProjectByRepo(ainizeUrl, cloneUrl, fetch, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (!p) { setState(NO_PROJECT); return; }
      const list = await fetchDeployments(ainizeUrl, p.id, fetch, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const deployments = list.length ? list : p.lastDeployment ? [p.lastDeployment] : [];
      const active = deployments.some((d) => d.status === "queued" || d.status === "building");
      setState({ project: p, deployments, active, projectUrl: projectPageUrl(ainizeUrl, p) });
      if (active) timer = setTimeout(load, 15_000);
    };
    load();
    return () => { ctrl.abort(); if (timer) clearTimeout(timer); };
  }, [ainizeUrl, cloneUrl, headSha, enabled]);
  return state;
}
