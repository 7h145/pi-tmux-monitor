// Link development types to the same host runtime used by the test loader.
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, realpath, symlink } from "node:fs/promises";

const host = process.env.PI_MONITOR_HOST_ROOT;
if (!host || !isAbsolute(host)) {
  throw Error(
    "Set PI_MONITOR_HOST_ROOT to an absolute coding-agent package directory",
  );
}
const require = createRequire(join(host, "package.json"));
const peers = {
  "pi-coding-agent": await realpath(host),
  "pi-tui": dirname(require.resolve("@earendil-works/pi-tui/package.json")),
};
const directory = fileURLToPath(
  new URL("../node_modules/@earendil-works/", import.meta.url),
);
await mkdir(directory, { recursive: true });
for (const [name, target] of Object.entries(peers)) {
  const link = join(directory, name);
  try {
    await symlink(target, link, "dir");
  } catch (error) {
    if (
      error.code !== "EEXIST" ||
      (await realpath(link)) !== (await realpath(target))
    ) {
      throw error;
    }
  }
}
