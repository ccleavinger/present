export type Route = { view: "list" } | { view: "editor"; id: string; branch?: string } | { view: "share"; id: string; token: string };

export function parseRoute(hash = window.location.hash): Route {
  try {
    const [path, query = ""] = hash.split("?", 2);
    const share = path.match(/^#\/share\/([^/]+)\/([^/]+)$/);
    if (share) return { view: "share", id: decodeURIComponent(share[1]), token: decodeURIComponent(share[2]) };
    const editor = path.match(/^#\/deck\/([^/]+)$/);
    if (editor) return { view: "editor", id: decodeURIComponent(editor[1]), branch: new URLSearchParams(query).get("branch") ?? undefined };
  } catch { /* Malformed links fall back to the library. */ }
  return { view: "list" };
}

export function sameRoute(left: Route, right: Route): boolean {
  return left.view === right.view && (left.view === "list" || left.view === "editor" && right.view === "editor" && left.id === right.id && left.branch === right.branch || left.view === "share" && right.view === "share" && left.id === right.id && left.token === right.token);
}

export function deckHash(id: string, branch?: string): string {
  return `#/deck/${encodeURIComponent(id)}${branch ? `?${new URLSearchParams({ branch })}` : ""}`;
}

export function shareLinkUrl(deckId: string, token: string, base = window.location.href): string {
  const url = new URL(base);
  url.hash = `/share/${encodeURIComponent(deckId)}/${encodeURIComponent(token)}`;
  return url.href;
}
