function hostOf(url: string | null): string | undefined {
  if (url === null || !URL.canParse(url)) return undefined;
  return new URL(url).host || undefined;
}

// `host` is the request URL's host, which @hono/node-server builds from the Host header.
// Origin wins when present: a foreign Origin is not rescued by a matching Referer.
export function isSameOrigin(headers: Headers, host: string): boolean {
  const source = hostOf(headers.get("origin") ?? headers.get("referer"));
  return source !== undefined && source === host.toLowerCase();
}
