import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, access, cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tmux } from "../src/tmux.mts";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { helperPath, reporterPath, packageRoot } from "../src/launch.mts";
test("manifest resources, host peers and companion skill validate with Pi loader", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.version, "0.1.1");
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
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

test("standalone helper runs beneath node_modules without a compiler or runtime peers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "monitor-package-"));
  const installed = join(dir, "node_modules", "pi-tmux-monitor");
  const socket = join(dir, "socket"),
    tmux = new Tmux(socket);
  const exec = promisify(execFile);
  try {
    await mkdir(join(installed, "scripts"), { recursive: true });
    await cp(new URL("../src", import.meta.url), join(installed, "src"), {
      recursive: true,
    });
    await cp(
      new URL("../package.json", import.meta.url),
      join(installed, "package.json"),
    );
    const helper = join(installed, "scripts", "pi-tmux-monitor.mjs");
    await cp(
      new URL("../scripts/pi-tmux-monitor.mjs", import.meta.url),
      helper,
    );
    const help = await exec(process.execPath, [helper, "--help"]);
    assert.ok(help.stdout.includes("pi-tmux-monitor launch"));
    assert.equal(help.stderr, "");
    const result = await exec(process.execPath, [
      helper,
      "launch",
      "--socket",
      socket,
      "--session",
      "package-test",
      "--window",
      "command",
      "--owner",
      "test-owner",
      "--ancestors-json",
      "[]",
      "--cwd",
      dir,
      "--heartbeat-interval-ms",
      "50",
      "--tmux-timeout-ms",
      "1000",
      "--",
      "true",
    ]);
    assert.equal(result.stderr, "");
    const { paneId, jobId } = JSON.parse(result.stdout);
    let record;
    for (let i = 0; i < 100; i++) {
      record = await tmux.record("job", paneId);
      if (record?.phase !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(record?.jobId, jobId);
    assert.equal(record.phase, "success");
    assert.equal(record.exitCode, 0);
  } finally {
    await tmux.call("kill-server").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
