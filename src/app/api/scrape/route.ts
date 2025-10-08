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
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const i = dataUrl.indexOf(",");
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  // nodejs_compat enables Buffer in the Cloud worker
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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

    // Build Worker URL:
    // - map ?domain=<...> -> ?url=<...>
    // - forward ALL other query params (mode, tile, tileH, tileMax, vw, vh, hcap, q, budget, px, max, raw, etc.)
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

    // If raw mode requested, proxy the Worker response as-is
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
        image?: string;        // single data URL
        images?: string[];     // tiles as data URLs
        confidence?: number;
      }>;
      meta?: any;
    };

    const list = (payload.sections || []).slice(0, maxSections);

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
    const siteOrigin = new URL(req.url).origin; // e.g. https://ncp-gen.webflow.io
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ""; // e.g. /ncp

    type In = { id?: string; role?: string; bbox?: number[]; image?: string; images?: string[]; confidence?: number; };
    type Out = { id?: string; role?: string; bbox?: number[]; image?: string; images?: string[]; confidence?: number; };

    const sections = await pMap<In, Out>(
      list as In[],
      UPLOAD_CONCURRENCY,
      async (s, idx) => {
        const safeId = s.id || `section_${idx}`;

        // If the Worker returned tiled images:
        if (Array.isArray(s.images) && s.images.length) {
          const urls: string[] = [];
          // Upload tiles sequentially per section to keep memory/CPU lower
          for (let t = 0; t < s.images.length; t++) {
            const bytes = dataUrlToBytes(s.images[t]);
            const key = `jobs/${jobId}/${safeId}/tile_${String(t).padStart(2, "0")}.jpg`;
            await bucket.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
            urls.push(`${siteOrigin}${basePath}/api/images/${key}`);
          }
          return { ...s, images: urls };
        }

        // Else, single image
        if (s.image) {
          const bytes = dataUrlToBytes(s.image);
          const key = `jobs/${jobId}/${safeId}.jpg`;
          await bucket.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
          const url = `${siteOrigin}${basePath}/api/images/${key}`;
          return { ...s, image: url };
        }

        // Nothing to persist; pass through minimal shape
        return { id: safeId, role: s.role, bbox: s.bbox, confidence: s.confidence };
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
