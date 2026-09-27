import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--enable-features=WebRTC-H264WithOpenH264FFmpeg",
        // Expose 127.0.0.1 host candidates so same-machine multi-context e2e can connect
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        "--enforce-webrtc-ip-permission-check",
      ],
    },
  },
  webServer: [
    {
      command: "pnpm --filter @ztc/server exec tsx src/index.ts",
      url: "http://127.0.0.1:8787/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @ztc/client exec vite --host 127.0.0.1 --port 5173",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
