import { getCloudflareContext } from "@opennextjs/cloudflare";

const CF_URL = process.env.CF_WORKER_URL!;
const CF_TOKEN = process.env.CF_WORKER_TOKEN!;
const ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const i = dataUrl.indexOf(",");
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  // Use Buffer (nodejs_compat) to avoid atob typing issues during build
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

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

export async function OPTIONS(req: Request) {
  return new Response(null, { headers: cors(req.headers.get("origin")) });
}

export async function GET(req: Request) {
  const h = req.headers.get("origin");
  const q = new URL(req.url).searchParams.get("domain");
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

async function handle(origin: string, req: Request, h: string | null) {
  // Call the Cloudflare Worker to get sections (with base64 screenshots)
  const res = await fetch(`${CF_URL}?url=${encodeURIComponent(origin)}`, {
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
    cf: { cacheTtl: 0, cacheEverything: false } as any,
  });

  if (!res.ok) {
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json", ...cors(h) },
    });
  }

  const payload = (await res.json()) as {
    sections: Array<{
      id?: string;
      role?: string;
      bbox?: number[];
      image: string; // data URL
      confidence?: number;
    }>;
  };

  // Persist images to Object Storage and return stable URLs
  const { env } = getCloudflareContext() as any;
  const bucket = (env as any).CLOUD_FILES as any;

  const jobId = crypto.randomUUID();
  const siteOrigin = new URL(req.url).origin; // e.g., https://ncp-gen.webflow.io
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ""; // e.g., /ncp

  const sections = await Promise.all(
    (payload.sections || []).map(async (s, idx) => {
      const bytes = dataUrlToBytes(s.image);
      const key = `jobs/${jobId}/${s.id || `section_${idx}`}.webp`;
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: "image/webp" },
      });
      const url = `${siteOrigin}${basePath}/api/images/${key}`;
      return { ...s, image: url };
    })
  );

  return new Response(JSON.stringify({ jobId, origin, sections }), {
    headers: { "content-type": "application/json", ...cors(h) },
  });
}
