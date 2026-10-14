import { access } from "node:fs/promises";

export async function compositorSource({
  source = process.env.PI_MONITOR_COMPOSITOR ??
    "/root/.local/share/pi/agent/packages/git/github.com/7h145/pi-footer-compositor/pi-footer-compositor.ts",
  required = process.env.PI_MONITOR_REQUIRE_COMPOSITOR === "1",
} = {}) {
  try {
    await access(source);
    return source;
  } catch (error) {
    if (error.code === "ENOENT" && !required) return null;
    throw new Error(`Compositor test dependency unavailable: ${source}`, {
      cause: error,
    });
  }
}
