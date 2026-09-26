/**
 * The Mac app (desktop/ in this repo): where its .dmg lives. Bump with each
 * desktop release — the tag and file names are what desktop/scripts/build-mac.mjs
 * and .github/workflows/desktop.yml produce.
 */
export const DESKTOP_VERSION = "0.2.1";
/** The one server the app pairs with (desktop/src/main.js DEFAULT_SERVER) — a
 *  self-hosted deployment offers the terminal instead. */
export const DESKTOP_SERVER = "https://aindrive.ainetwork.ai";

export function desktopAppServes(publicUrl: string): boolean {
  return publicUrl.replace(/\/+$/, "") === DESKTOP_SERVER;
}
export const DESKTOP_ARCHS = ["arm64", "x64"] as const;
export type DesktopArch = (typeof DESKTOP_ARCHS)[number];

export function desktopDmgUrl(arch: DesktopArch): string {
  return `https://github.com/ainetwork-ai/aindrive/releases/download/desktop-v${DESKTOP_VERSION}/aindrive-${DESKTOP_VERSION}-mac-${arch}.dmg`;
}
