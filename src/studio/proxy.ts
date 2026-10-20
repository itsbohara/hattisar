export const STUDIO_CSS_PATH = "/_hs/static/studio.css";
export const STUDIO_JS_PATH = "/_hs/static/studio.js";

const INJECTED_TAGS = `<link rel="stylesheet" href="${STUDIO_CSS_PATH}"><script src="${STUDIO_JS_PATH}" defer></script>`;

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export function injectStudioAssets(html: string): string {
  const at = html.indexOf("</head>");
  return at === -1 ? html : `${html.slice(0, at)}${INJECTED_TAGS}${html.slice(at)}`;
}

function withoutHopByHop(headers: Headers): Headers {
  const result = new Headers(headers);
  const listed = headers.get("connection")?.split(",") ?? [];
  for (const name of [...HOP_BY_HOP, ...listed]) result.delete(name.trim());
  return result;
}

function upstreamRequestHeaders(incoming: Headers, overrides: Headers): Headers {
  const headers = withoutHopByHop(incoming);
  headers.delete("host");
  // Uncompressed responses let HTML be rewritten without a decode/re-encode step.
  headers.set("accept-encoding", "identity");
  for (const [name, value] of overrides) headers.set(name, value);
  return headers;
}

function downstreamResponseHeaders(upstream: Response): Headers {
  const headers = withoutHopByHop(upstream.headers);
  // fetch has already decoded any compressed body, so these would describe bytes we no longer send.
  if (headers.has("content-encoding")) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  return headers;
}

export async function proxyToStudio(
  studioUrl: string,
  request: Request,
  overrides: Headers = new Headers(),
): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(`${url.pathname}${url.search}`, studioUrl);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: upstreamRequestHeaders(request.headers, overrides),
      body: hasBody ? request.body : undefined,
      duplex: "half",
      redirect: "manual",
      signal: request.signal,
    });
  } catch {
    return Response.json({ message: "Studio is unreachable" }, { status: 502 });
  }

  const headers = downstreamResponseHeaders(upstream);
  const isHtml = headers.get("content-type")?.startsWith("text/html") ?? false;
  if (!isHtml || upstream.body === null) {
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  headers.delete("content-length");
  const html = injectStudioAssets(await upstream.text());
  return new Response(html, { status: upstream.status, headers });
}
