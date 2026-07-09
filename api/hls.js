/**
 * api/hls.js — Vercel Edge Proxy (bandwidth-optimised)
 *
 * BEFORE: Every .ts segment was piped through Vercel → 99% of bandwidth.
 * AFTER:  Only .m3u8 manifest files are proxied (tiny text).
 *         Segment URLs are rewritten to point DIRECTLY to FanCode's CDN
 *         so the browser downloads video bytes straight from the source —
 *         zero segment bandwidth through Vercel.
 *
 * How it works:
 *  1. Browser requests  /api/hls?url=<master.m3u8>
 *  2. Vercel fetches the manifest with FanCode headers (needed for auth)
 *  3. Vercel rewrites any nested .m3u8 URLs → back through /api/hls
 *     (so sub-playlists also get the right headers)
 *  4. Vercel rewrites all .ts / .aac / segment URLs → DIRECT CDN URLs
 *     (browser fetches these itself, Vercel never sees the bytes)
 *  5. Returns the rewritten manifest to the browser
 *
 * Result: Vercel only handles small text files (~5–20 KB each).
 *         A 1-hour stream generates ~5 MB through Vercel instead of ~3 GB.
 */

export const config = { runtime: "edge" };

const UPSTREAM_HEADERS = {
  Referer: "https://www.fancode.com/",
  Origin:  "https://www.fancode.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "*/*",
};

/* ── URL helpers ─────────────────────────────────────────────── */

function resolveUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative;
  return new URL(relative, base).href;
}

function isManifest(url) {
  return /\.m3u8?(\?|$)/i.test(url);
}

/* ── Manifest rewriter ───────────────────────────────────────── */
/**
 * Walk every line and URI= attribute in the M3U8 text.
 *  - Nested .m3u8 references  → still go through /api/hls (need auth headers)
 *  - Everything else (.ts, .aac, .mp4, segments) → direct CDN URL
 */
function rewriteManifest(text, sourceUrl, proxyOrigin) {
  const base = sourceUrl;

  /* Rewrite URI="..." attributes (used for encryption keys, sub-playlists) */
  let out = text.replace(/URI="([^"]+)"/gi, (_m, uri) => {
    const resolved = resolveUrl(base, uri);
    /* Encryption key requests also need the auth headers → proxy them */
    if (isManifest(resolved) || /\/key|\.key/i.test(resolved)) {
      return `URI="${proxyOrigin}/api/hls?url=${encodeURIComponent(resolved)}"`;
    }
    /* Everything else goes direct */
    return `URI="${resolved}"`;
  });

  out = out.replace(/URI='([^']+)'/gi, (_m, uri) => {
    const resolved = resolveUrl(base, uri);
    if (isManifest(resolved) || /\/key|\.key/i.test(resolved)) {
      return `URI='${proxyOrigin}/api/hls?url=${encodeURIComponent(resolved)}'`;
    }
    return `URI='${resolved}'`;
  });

  /* Rewrite non-comment lines (segment URLs, sub-playlist URLs) */
  out = out
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith("#")) return trimmed;

      const resolved = resolveUrl(base, trimmed);

      if (isManifest(resolved)) {
        /* Sub-playlist (.m3u8) → proxy so we can add auth headers */
        return `${proxyOrigin}/api/hls?url=${encodeURIComponent(resolved)}`;
      }

      /* Segment (.ts, .aac, .mp4, etc.) → DIRECT to CDN, bypasses Vercel */
      return resolved;
    })
    .join("\n");

  return out;
}

/* ── Handler ─────────────────────────────────────────────────── */
export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");

  if (!target) {
    return new Response("Missing url parameter", { status: 400, headers: corsHeaders() });
  }

  /* Only proxy manifest files — reject segment requests outright.
     If somehow a .ts lands here, tell the browser to fetch it directly. */
  if (!isManifest(target) && !/\/key|\.key/i.test(target)) {
    return Response.redirect(target, 302);
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: UPSTREAM_HEADERS,
      redirect: "follow",
    });
  } catch (err) {
    return new Response(`Proxy fetch failed: ${err.message}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  if (!upstream.ok) {
    return new Response(`Upstream ${upstream.status}`, {
      status: upstream.status,
      headers: corsHeaders(),
    });
  }

  const text = await upstream.text();

  /* If the response doesn't look like an M3U8, pass it through as-is */
  if (!text.trimStart().startsWith("#EXTM3U") && !text.trimStart().startsWith("#EXT")) {
    return new Response(text, {
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  }

  const rewritten = rewriteManifest(text, target, reqUrl.origin);

  return new Response(rewritten, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store, no-cache",
    },
  });
}

/* ── CORS ────────────────────────────────────────────────────── */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
  };
}
