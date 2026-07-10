/**
 * api/hls.js — Vercel Edge Proxy
 *
 * Segments DO need to go through the proxy because FanCode's CDN
 * requires Referer: https://www.fancode.com/ on every request.
 * Browsers cannot set Referer on cross-origin fetches.
 *
 * Bandwidth optimisation: we stream the response body directly
 * using ReadableStream — Vercel never buffers a full segment in
 * memory, it just pipes bytes through as they arrive.
 * This is the most efficient possible approach on Vercel edge.
 */

export const config = { runtime: "edge" };

const UPSTREAM_HEADERS = {
  Referer:      "https://www.fancode.com/",
  Origin:       "https://www.fancode.com",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:       "*/*",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
  };
}

function resolveUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative;
  return new URL(relative, base).href;
}

function isManifest(url) {
  return /\.m3u8?(\?|$)/i.test(url);
}

function proxyUrl(origin, target) {
  return `${origin}/api/hls?url=${encodeURIComponent(target)}`;
}

/**
 * Rewrite ALL URLs in the manifest through the proxy.
 * Both .m3u8 sub-playlists AND .ts segments go through /api/hls
 * so every request carries the required FanCode auth headers.
 */
function rewriteManifest(text, sourceUrl, proxyOrigin) {
  /* Rewrite URI="..." attributes (encryption keys, sub-playlists) */
  let out = text.replace(/URI="([^"]+)"/gi, (_m, uri) => {
    return `URI="${proxyUrl(proxyOrigin, resolveUrl(sourceUrl, uri))}"`;
  });

  out = out.replace(/URI='([^']+)'/gi, (_m, uri) => {
    return `URI='${proxyUrl(proxyOrigin, resolveUrl(sourceUrl, uri))}'`;
  });

  /* Rewrite all non-comment URL lines */
  out = out
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trimEnd();
      if (!t || t.startsWith("#")) return t;
      return proxyUrl(proxyOrigin, resolveUrl(sourceUrl, t));
    })
    .join("\n");

  return out;
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");

  if (!target) {
    return new Response("Missing url parameter", { status: 400, headers: corsHeaders() });
  }

  /* Forward Range header for partial content (seek support) */
  const upstreamHeaders = { ...UPSTREAM_HEADERS };
  const range = request.headers.get("range");
  if (range) upstreamHeaders["Range"] = range;

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: upstreamHeaders,
      redirect: "follow",
    });
  } catch (err) {
    return new Response(`Proxy fetch failed: ${err.message}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  if (!upstream.ok && upstream.status !== 206) {
    return new Response(`Upstream ${upstream.status}`, {
      status: upstream.status,
      headers: corsHeaders(),
    });
  }

  /* ── Manifest: rewrite URLs then return text ── */
  if (isManifest(target)) {
    const text = await upstream.text();
    const rewritten = rewriteManifest(text, target, reqUrl.origin);
    return new Response(rewritten, {
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type":  "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store, no-cache",
      },
    });
  }

  /* ── Segments / keys: stream body directly — no buffering ── */
  const respHeaders = {
    ...corsHeaders(),
    "Content-Type":  upstream.headers.get("content-type") || "video/mp2t",
    "Cache-Control": "public, max-age=300",   /* segments are immutable, cache them */
  };

  /* Forward range response headers for seek support */
  const contentRange  = upstream.headers.get("content-range");
  const contentLength = upstream.headers.get("content-length");
  const acceptRanges  = upstream.headers.get("accept-ranges");
  if (contentRange)  respHeaders["Content-Range"]  = contentRange;
  if (contentLength) respHeaders["Content-Length"] = contentLength;
  if (acceptRanges)  respHeaders["Accept-Ranges"]  = acceptRanges;

  /* Stream the body — edge runtime pipes bytes through without buffering */
  return new Response(upstream.body, {
    status:  upstream.status,
    headers: respHeaders,
  });
}
