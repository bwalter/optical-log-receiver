/**
 * Version of this receiver. Bump it when senders start relying on a new receiver feature, and raise the minimum
 * version in the sender (`min` in the link it shows) accordingly.
 */
export const RECEIVER_VERSION = 1;

/** Set on the reload fetching the new version, so that a still outdated page does not reload forever. */
const RELOAD_PARAM = "reload";

/**
 * Checks the minimum version requested by the sender (`?min=N`). An outdated page reloads once from a new URL (which
 * bypasses the cached page).
 *
 * @returns "ok", "reloading", or an error message if the page stays outdated
 */
export function checkVersion(): "ok" | "reloading" | string {
  const url = new URL(location.href);
  const min = Number(url.searchParams.get("min") ?? 0);
  if (!Number.isFinite(min) || RECEIVER_VERSION >= min) return "ok";
  if (!navigator.onLine) {
    return `This page is outdated (v${RECEIVER_VERSION}, the sender needs v${min}). Go online and open the link again.`;
  }
  if (url.searchParams.has(RELOAD_PARAM)) {
    return `This page is outdated (v${RECEIVER_VERSION}, the sender needs v${min}) and no newer one is available yet.`;
  }
  url.searchParams.set(RELOAD_PARAM, Date.now().toString(36));
  location.replace(url);
  return "reloading";
}
