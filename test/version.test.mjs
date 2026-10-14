import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  loadInstallationIdentity,
  installationLabel,
} from "../src/version.mts";
const exec = promisify(execFile);
const manifest = (root) =>
  writeFile(
    join(root, "package.json"),
    '{"name":"pi-tmux-monitor","version":"0.1.0"}',
  );
async function fixture(fn) {
  const root = await mkdtemp("/tmp/monitor-identity-");
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function repository(root) {
  await exec("git", ["init", "-q", root]);
  await exec("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
    "--allow-empty",
  ]);
  return (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
}

test("own installation version and optional Git label, including safe unversioned output", () => {
  assert.equal(
    installationLabel({ version: "0.1.0", commit: "abc1234" }),
    "tmux-monitor v0.1.0 (abc1234)",
  );
  assert.equal(installationLabel({ version: "0.1.0" }), "tmux-monitor v0.1.0");
  assert.equal(installationLabel({}), "tmux-monitor");
  assert.equal(
    installationLabel({ version: "bad\x1b", commit: "abc1234" }),
    "tmux-monitor",
  );
  assert.equal(
    installationLabel({ version: "0.1.0", commit: "unavailable" }),
    "tmux-monitor v0.1.0",
  );
});

test("package subdirectories cannot borrow a parent repository or invalid manifest", async () =>
  fixture(async (root) => {
    await repository(root);
    const nested = join(root, "package");
    await mkdir(nested);
    await manifest(nested);
    let calls = 0;
    assert.deepEqual(
      await loadInstallationIdentity(nested, async () => {
        calls++;
        return "a".repeat(40);
      }),
      { version: "0.1.0" },
    );
    assert.equal(calls, 0);
    for (const pkg of [
      { name: "wrong", version: "0.1.0" },
      { name: "pi-tmux-monitor", version: "bad" },
      { name: "pi-tmux-monitor" },
    ]) {
      await writeFile(join(nested, "package.json"), JSON.stringify(pkg));
      assert.deepEqual(await loadInstallationIdentity(nested), {});
    }
    await writeFile(join(nested, "package.json"), "x".repeat(65537));
    assert.deepEqual(await loadInstallationIdentity(nested), {});
  }));

test("own Git identity survives symlink/worktree installs and ignores repository overrides", async () =>
  fixture(async (root) => {
    const parent = join(root, "parent"),
      product = join(parent, "product"),
      linked = join(root, "symlink");
    await mkdir(product, { recursive: true });
    await repository(parent);
    await manifest(product);
    const head = await repository(product);
    await symlink(product, linked);
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    };
    Object.assign(process.env, {
      GIT_DIR: join(parent, ".git"),
      GIT_WORK_TREE: parent,
      GIT_CONFIG_COUNT: "invalid",
    });
    try {
      assert.deepEqual(await loadInstallationIdentity(linked), {
        version: "0.1.0",
        commit: head.slice(0, 7),
      });
    } finally {
      for (const [key, value] of Object.entries(saved))
        value === undefined
          ? delete process.env[key]
          : (process.env[key] = value);
    }
    const worktree = join(root, "worktree");
    await exec("git", [
      "-C",
      product,
      "worktree",
      "add",
      "--detach",
      worktree,
      "HEAD",
    ]);
    await manifest(worktree);
    assert.deepEqual(await loadInstallationIdentity(worktree), {
      version: "0.1.0",
      commit: head.slice(0, 7),
    });
  }));

test("missing Git, malformed output and bounded timeout silently omit optional commit", async () =>
  fixture(async (root) => {
    await manifest(root);
    await mkdir(join(root, ".git"));
    for (const output of [
      "",
      "abc1234",
      "A".repeat(40),
      "secret\n" + "a".repeat(40),
    ]) {
      assert.deepEqual(
        await loadInstallationIdentity(root, async () => output),
        { version: "0.1.0" },
      );
    }
    assert.deepEqual(
      await loadInstallationIdentity(root, async () => {
        throw Error("unavailable");
      }),
      { version: "0.1.0" },
    );
    const path = process.env.PATH;
    const bin = join(root, "bin");
    await mkdir(bin);
    try {
      process.env.PATH = bin;
      assert.deepEqual(await loadInstallationIdentity(root), {
        version: "0.1.0",
      });
      const git = join(bin, "git");
      await writeFile(
        git,
        `#!${process.execPath}\nsetTimeout(()=>process.stdout.write('${"a".repeat(40)}'),2000);`,
      );
      await chmod(git, 0o755);
      const start = performance.now();
      assert.deepEqual(await loadInstallationIdentity(root), {
        version: "0.1.0",
      });
      assert.ok(performance.now() - start < 1800);
    } finally {
      process.env.PATH = path;
    }
  }));
