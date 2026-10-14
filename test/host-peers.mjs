// Use the existing Pi install, never a second runtime copy. Override for another
// host: PI_MONITOR_HOST_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent.
import { registerHooks, createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(
  (process.env.PI_MONITOR_HOST_ROOT ??
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent") +
    "/package.json",
);
const urls = {
  "@earendil-works/pi-coding-agent": pathToFileURL(
    (process.env.PI_MONITOR_HOST_ROOT ??
      "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent") +
      "/dist/index.js",
  ).href,
  "@earendil-works/pi-tui": pathToFileURL(
    require.resolve("@earendil-works/pi-tui"),
  ).href,
};
registerHooks({
  resolve(specifier, context, next) {
    if (urls[specifier]) return { url: urls[specifier], shortCircuit: true };
    return next(specifier, context);
  },
});
