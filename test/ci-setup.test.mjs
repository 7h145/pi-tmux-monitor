import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  cp,
  rm,
  realpath,
  symlink,
  readlink,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { compositorSource } from "./compositor-source.mjs";
const exec = promisify(execFile);

test("missing compositor can skip locally but is an error when required", async () => {
  const root = await mkdtemp("/tmp/monitor-ci-source-");
  try {
    const source = join(root, "pi-footer-compositor.ts");
    assert.equal(await compositorSource({ source, required: false }), null);
    await assert.rejects(
      compositorSource({ source, required: true }),
      /Compositor test dependency unavailable/,
    );
    await writeFile(source, "export default () => {};\n");
    assert.equal(await compositorSource({ source, required: true }), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("peer setup resolves a hoisted host, is repeatable and preserves a different existing peer", async () => {
  const root = await mkdtemp("/tmp/monitor-ci-peers-");
  try {
    const host = join(
      root,
      "host/node_modules/@earendil-works/pi-coding-agent",
    );
    const tui = join(root, "host/node_modules/@earendil-works/pi-tui");
    const project = join(root, "project");
    const setup = join(project, "test/setup-peers.mjs");
    const peers = join(project, "node_modules/@earendil-works");
    await mkdir(host, { recursive: true });
    await mkdir(tui);
    await mkdir(join(project, "test"), { recursive: true });
    await writeFile(
      join(host, "package.json"),
      '{"name":"@earendil-works/pi-coding-agent"}',
    );
    await writeFile(
      join(tui, "package.json"),
      '{"name":"@earendil-works/pi-tui"}',
    );
    await cp(new URL("./setup-peers.mjs", import.meta.url), setup);
    const run = () =>
      exec(process.execPath, [setup], {
        env: { ...process.env, PI_MONITOR_HOST_ROOT: host },
        timeout: 2000,
      });
    await run();
    await run();
    assert.equal(
      await realpath(join(peers, "pi-coding-agent")),
      await realpath(host),
    );
    assert.equal(await realpath(join(peers, "pi-tui")), await realpath(tui));
    const other = join(root, "other");
    await mkdir(other);
    await rm(join(peers, "pi-coding-agent"));
    await symlink(other, join(peers, "pi-coding-agent"));
    await assert.rejects(run());
    assert.equal(await readlink(join(peers, "pi-coding-agent")), other);
    await assert.rejects(
      exec(process.execPath, [setup], {
        env: { ...process.env, PI_MONITOR_HOST_ROOT: "relative/host" },
        timeout: 2000,
      }),
      /Set PI_MONITOR_HOST_ROOT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
