// ncp/src/app/api/scrape/route.ts
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Env vars expected in Webflow Cloud:
 * - CF_WORKER_URL: e.g. https://ncp-sectionizer.diegotest.workers.dev
 * - CF_WORKER_TOKEN: Bearer token for the Worker
 * - ALLOWED_ORIGINS: comma-separated list of site origins allowed to call this API
 * - NEXT_PUBLIC_BASE_PATH: your mount path (e.g. "/ncp")
 * - WORKER_MAX (optional): default max sections requested from Worker
 * - MAX_SECTIONS (optional): hard cap for sections after Worker returns
 * - UPLOAD_CONCURRENCY (optional): how many sections to upload in parallel (default 2)
 * - ABSOLUTE_IMAGE_URLS (optional): "1" to return absolute URLs; default relative (same-origin)
 * - PUBLIC_SITE_ORIGIN (optional): override public origin (proto+host) if needed
 *
 * Notes:
 * - This version emits **relative** URLs for images by default, e.g. "/ncp/api/images/...".
 *   That keeps downloads same-origin and avoids CORS errors in the browser.
 * - If you need absolute links, set ABSOLUTE_IMAGE_URLS=1 (uses PUBLIC_SITE_ORIGIN if provided).
 * - When the query has `&b64=1` and your Worker returns `image_b64/images_b64`,
 *   those fields are preserved in the response (in addition to the stored image URLs).
 */

const CF_URL = process.env.CF_WORKER_URL!;
const CF_TOKEN = process.env.CF_WORKER_TOKEN!;
const ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_WORKER_MAX = Number(process.env.WORKER_MAX || 6);
const DEFAULT_MAX_SECTIONS = Number(process.env.MAX_SECTIONS || DEFAULT_WORKER_MAX);
const UPLOAD_CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY || 2);

// --------- tiny utils ---------
function cors(o: string | null) {
  const ok = o && ORIGINS.includes(o);
  return {
    "access-control-allow-origin": ok ? o! : "null",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}
function norm(input: string) {
  const u = new URL(input.startsWith("http") ? input : `https://${input}`);
  if (!/^https?:$/.test(u.protocol)) throw new Error("bad protocol");
  return u.origin;
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
// Compute the public origin from headers, with optional env override
function publicOrigin(req: Request) {
  const forced = process.env.PUBLIC_SITE_ORIGIN;
  if (forced) return forced.replace(/\/+$/, "");
  const h = req.headers;
  const proto = h.get("x-forwarded-proto") || "https";
  const host = h.get("x-forwarded-host") || new URL(req.url).host;
  return `${proto}://${host}`;
}
// SAFE decoder: returns null for bad/undefined inputs
function safeDataUrlToBytes(maybeDataUrl: unknown): Uint8Array | null {
  if (typeof maybeDataUrl !== "string") return null;
  const i = maybeDataUrl.indexOf(",");
  if (i < 0) return null;
  const b64 = maybeDataUrl.slice(i + 1);
  try {
    const buf = Buffer.from(b64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return null;
  }
}
// Extract raw base64 (no prefix) from a data URL; returns null if not a data URL string
function safeBase64FromDataUrl(maybeDataUrl: unknown): string | null {
  if (typeof maybeDataUrl !== "string") return null;
  const i = maybeDataUrl.indexOf(",");
  return i >= 0 ? maybeDataUrl.slice(i + 1) : null;
}
async function pMap<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const ret: R[] = new Array(items.length);
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const cur = i++;
      ret[cur] = await worker(items[cur], cur);
    }
  });
  await Promise.all(runners);
  return ret;
}

// --------- HTTP verbs ---------
export async function OPTIONS(req: Request) {
  return new Response(null, { headers: cors(req.headers.get("origin")) });
}

export async function GET(req: Request) {
  const h = req.headers.get("origin");
  const u = new URL(req.url);

  // Quick liveness/diagnostics
  if (u.searchParams.get("ping") === "1") {
    const envKeys = Object.keys(process.env || {});
    return new Response(
      JSON.stringify({
        ok: true,
        basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
        workerUrlSet: !!CF_URL,
        tokenSet: !!CF_TOKEN,
        envKeys,
      }),
      { headers: { "content-type": "application/json", ...cors(h) } }
    );
  }

  const q = u.searchParams.get("domain");
  if (!q) return new Response("Missing domain", { status: 400, headers: cors(h) });
  return handle(norm(q), req, h);
}

export async function POST(req: Request) {
  const h = req.headers.get("origin");
  if (!h || !ORIGINS.includes(h)) {
    return new Response(JSON.stringify({ error: "Origin not allowed" }), {
      status: 403,
      headers: { "content-type": "application/json", ...cors(h) },
    });
  }

  type Body = { domain?: string };
  let domain: string | undefined;
  try {
    const body = (await req.json()) as Body;
    domain = body.domain;
  } catch {
    domain = undefined;
  }

  if (!domain) {
    return new Response(JSON.stringify({ error: "Missing domain" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors(h) },
    });
  }
  return handle(norm(domain), req, h);
}

// --------- main handler ---------
async function handle(origin: string, req: Request, h: string | null) {
  try {
    const u = new URL(req.url);

    // Allow raw proxy (skip storage) for debugging
    const raw = u.searchParams.get("raw") === "1";

    // Compute limits; let query override defaults (clamped 1..12)
    const qMax = Number(u.searchParams.get("max") || "");
    const workerMax = clamp(qMax || DEFAULT_WORKER_MAX, 1, 12);
    const maxSections = clamp(
      Number(process.env.MAX_SECTIONS || DEFAULT_MAX_SECTIONS || workerMax),
      1,
      workerMax
    );

    // Opt-in: include base64 in the proxied response as well
    const includeB64 = u.searchParams.get("b64") === "1";

    // Build Worker URL:
    // - map ?domain=<...> -> ?url=<...>
    // - forward ALL other query params (sections, vw, vh, hcap, q, budget, px, max, b64, etc.)
    const worker = new URL(CF_URL);
    worker.searchParams.set("url", origin);
    for (const [k, v] of u.searchParams) {
      if (k === "domain") continue;
      worker.searchParams.set(k, v);
    }
    // Ensure max is present
    if (!worker.searchParams.get("max")) worker.searchParams.set("max", String(workerMax));

    // Call the Worker
    const wres = await fetch(worker.toString(), {
      headers: { Authorization: `Bearer ${CF_TOKEN}` },
      cf: { cacheTtl: 0, cacheEverything: false } as any,
    });

    // If raw mode requested, proxy the Worker response as-is (includes *_b64 if &b64=1)
    if (raw) {
      const body = await wres.text();
      return new Response(body, {
        status: wres.status,
        headers: { "content-type": "application/json", ...cors(h) },
      });
    }

    // Otherwise, parse JSON and persist images/tiles to Object Storage
    if (!wres.ok) {
      const text = await wres.text();
      return new Response(text, {
        status: wres.status,
        headers: { "content-type": "application/json", ...cors(h) },
      });
    }

    const payload = (await wres.json()) as {
      sections?: Array<{
        id?: string;
        role?: string;
        bbox?: number[];
        image?: unknown;            // single data URL
        images?: unknown[];         // tiles as data URLs
        // Optional: Worker-provided base64 if &b64=1
        image_b64?: unknown;
        images_b64?: unknown[];
        confidence?: number;
        label?: string;
      }>;
      meta?: any;
    };

    const list = Array.isArray(payload.sections) ? payload.sections.slice(0, maxSections) : [];

    // Storage binding
    const { env } = getCloudflareContext() as any;
    const bucket = (env as any).CLOUD_FILES as {
      put: (key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }) => Promise<void>;
    };
    if (!bucket) {
      return new Response(
        JSON.stringify({ error: "Storage binding CLOUD_FILES is missing" }),
        { status: 500, headers: { "content-type": "application/json", ...cors(h) } }
      );
    }

    const jobId = crypto.randomUUID();
    const siteOrigin = publicOrigin(req);
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ""; // e.g. /ncp
    const absolute = process.env.ABSOLUTE_IMAGE_URLS === "1";

    type In = {
      id?: string;
      role?: string;
      bbox?: number[];
      image?: unknown;
      images?: unknown[];
      image_b64?: unknown;
      images_b64?: unknown[];
      confidence?: number;
      label?: string;
    };
    type Out = {
      id?: string;
      role?: string;
      bbox?: number[];
      image?: string;
      images?: string[];
      // Optional passthrough if includeB64=1
      image_b64?: string;
      images_b64?: string[];
      confidence?: number;
      label?: string;
    };

    const sections = await pMap<In, Out>(
      list as In[],
      UPLOAD_CONCURRENCY,
      async (s, idx) => {
        const safeId = s.id || `section_${idx}`;
        const meta = cleanSectionMeta(s);

        // Helper to build final URL (relative by default)
        const buildUrl = (key: string) => {
          const relativeUrl = `${basePath}/api/images/${key}`;
          return absolute ? `${siteOrigin}${relativeUrl}` : relativeUrl;
        };

        // Tiled images (array)
        if (Array.isArray(s.images) && s.images.length) {
          const urls: string[] = [];
          for (let t = 0; t < s.images.length; t++) {
            const bytes = safeDataUrlToBytes(s.images[t]);
            if (!bytes) continue; // skip invalid/missing tiles safely
            const key = `jobs/${jobId}/${safeId}/tile_${String(t).padStart(2, "0")}.jpg`;
            await bucket.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
            urls.push(buildUrl(key));
          }

          const out: Out = { ...meta, images: urls };

          // Preserve base64 if requested: prefer Worker-supplied images_b64, else derive from data URLs
          if (includeB64) {
            if (Array.isArray(s.images_b64) && s.images_b64.length) {
              out.images_b64 = s.images_b64.filter((x): x is string => typeof x === "string");
            } else {
              const b64s: string[] = [];
              for (const img of s.images) {
                const b64 = safeBase64FromDataUrl(img);
                if (b64) b64s.push(b64);
              }
              if (b64s.length) out.images_b64 = b64s;
            }
          }

          return out;
        }

        // Single image
        const bytes = safeDataUrlToBytes(s.image);
        if (bytes) {
          const key = `jobs/${jobId}/${safeId}.jpg`;
          await bucket.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
          const url = buildUrl(key);

          const out: Out = { ...meta, image: url };

          if (includeB64) {
            if (typeof s.image_b64 === "string") {
              out.image_b64 = s.image_b64;
            } else {
              const b64 = safeBase64FromDataUrl(s.image);
              if (b64) out.image_b64 = b64;
            }
          }

          return out;
        }

        // Nothing valid to persist; still pass through base64 if we have it
        const out: Out = { ...meta };
        if (includeB64) {
          if (typeof s.image_b64 === "string") out.image_b64 = s.image_b64;
          if (Array.isArray(s.images_b64))
            out.images_b64 = s.images_b64.filter((x): x is string => typeof x === "string");
        }
        return out;
      }
    );

    return new Response(JSON.stringify({ jobId, origin, sections, meta: payload.meta || {} }), {
      headers: { "content-type": "application/json", ...cors(h) },
    });
  } catch (e: any) {
    const msg = String(e?.message || e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "content-type": "application/json", ...cors(h) },
    });
  }
}

// Keep only serializable metadata from an incoming section
function cleanSectionMeta(s: any) {
  const out: any = {};
  if (s && typeof s === "object") {
    if (s.id) out.id = String(s.id);
    if (s.role) out.role = String(s.role);
    if (Array.isArray(s.bbox)) out.bbox = s.bbox.slice(0, 4);
    if (typeof s.confidence === "number") out.confidence = s.confidence;
    if (s.label) out.label = String(s.label);
  }
  return out;
}
