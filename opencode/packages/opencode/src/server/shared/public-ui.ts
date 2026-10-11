import { Flag } from "@opencode-ai/core/flag/flag"

// Static UI assets the browser fetches without app-managed credentials, e.g.
// the manifest link in <head>. These bypass auth so the page can install/render
// the manifest icons even when a server password is configured.
export const PUBLIC_UI_PATHS = new Set<string>([
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

// OPENCODE_PUBLIC_UI serves the whole static web UI without auth, for embedders
// (e.g. an IDE webview iframe) that cannot send Basic auth for page assets. The
// app then authenticates its API calls itself via `?auth_token=`. Only the
// router-middleware routes (UI catch-all and /doc) reach this check; /doc stays guarded.
export function isPublicUIPath(method: string, pathname: string) {
  if (method !== "GET") return false
  if (Flag.OPENCODE_PUBLIC_UI) return pathname !== "/doc"
  return PUBLIC_UI_PATHS.has(pathname)
}
