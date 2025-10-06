import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function GET(_req: Request, ctx: any) {
  const raw = ctx?.params?.key;
  const parts = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const key = parts.join("/"); // jobs/<jobId>/<section>.webp
  if (!key) return new Response("Bad Request", { status: 400 });

  const { env } = getCloudflareContext() as any;
  const bucket = (env as any).CLOUD_FILES as any;

  const obj = await bucket.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
