import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { helperPath, reporterPath, packageRoot } from "../src/launch.mjs";
test("manifest resources, host peers and companion skill validate with Pi loader", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.version, "0.1.0");
  assert.deepEqual(manifest.pi.extensions, ["./pi-tmux-monitor.ts"]);
  assert.deepEqual(manifest.pi.skills, ["./skills/pi-tmux-monitor"]);
  assert.equal(
    manifest.peerDependencies["@earendil-works/pi-coding-agent"],
    "*",
  );
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
  assert.equal(manifest.dependencies, undefined);
  await access(helperPath);
  await access(reporterPath);
  const result = loadSkillsFromDir({
    dir: fileURLToPath(new URL("../skills/pi-tmux-monitor", import.meta.url)),
    source: "test",
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, "pi-tmux-monitor");
  assert.equal(
    result.skills[0].baseDir,
    packageRoot + "/skills/pi-tmux-monitor",
  );
});
