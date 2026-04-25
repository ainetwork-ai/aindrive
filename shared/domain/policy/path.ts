/**
 * Path semantics shared between cap-policy decisions and UI agent picking.
 * Same shape as Willow's path-prefix areas.
 */

export function pathCovers(prefix: string, target: string): boolean {
  if (prefix === "" || prefix === target) return true;
  return target.startsWith(prefix + "/");
}
