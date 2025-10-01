import type { NextConfig } from "next";


const nextConfig: NextConfig = {
  basePath: "/ncp",
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH || '/ncp',
};

export default nextConfig;
// added by create cloudflare to enable calling `getCloudflareContext()` in `next dev`
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
