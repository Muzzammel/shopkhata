/**
 * The path to return to after signing in. Only a path on this site is ever
 * returned: the candidate is resolved the way the browser will resolve it and
 * must stay on the same origin. A prefix check is not enough — browsers treat
 * "/\host" like "//host", which leaves the site.
 */
export function safeReturnPath(next: string | null | undefined, origin: string): string {
  if (!next || !next.startsWith("/") || /[\\\u0000-\u001f]/.test(next)) return "/";
  try {
    const url = new URL(next, origin);
    return url.origin === new URL(origin).origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}
