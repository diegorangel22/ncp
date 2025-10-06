import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function GET() {
  const out: Record<string, any> = {
    ok: true,
    time: new Date().toISOString(),
    basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
    workerUrlSet: Boolean(process.env.CF_WORKER_URL),
    tokenSet: Boolean(process.env.CF_WORKER_TOKEN),
  };

  try {
    const { env } = getCloudflareContext() as any;
    const keys = Object.keys(env || {});
    out.envBindingKeys = keys;                 // 👈 see what bindings exist
    out.hasCLOUD_FILES = keys.includes("CLOUD_FILES");

    const bucket = (env as any).CLOUD_FILES as any;
    if (!bucket) {
      out.storageWriteRead = false;
      out.storageError = "CLOUD_FILES binding not present";
    } else {
      const key = `health/${crypto.randomUUID()}.txt`;
      const bytes = new TextEncoder().encode("ok");
      await bucket.put(key, bytes, { httpMetadata: { contentType: "text/plain" } });
      const got = await bucket.get(key);
      out.storageWriteRead = Boolean(got);
    }
  } catch (e: any) {
    out.storageWriteRead = false;
    out.storageError = String(e?.message || e);
  }

  return new Response(JSON.stringify(out), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
