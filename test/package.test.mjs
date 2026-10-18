import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readFile,
  writeFile,
  access,
  cp,
  mkdtemp,
  mkdir,
  rm,
} from "node:fs/promises";
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
  assert.equal(manifest.version, "0.3.0");
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.equal(manifest.license, "MIT");
  assert.equal(lock.packages[""].license, manifest.license);
  assert.ok(manifest.files.includes("LICENSE"));
  const license = await readFile(new URL("../LICENSE", import.meta.url), "utf8");
  assert.match(license, /^MIT License\n/);
  assert.match(
    license,
    /Copyright \(c\) 2026 thias <github\.attic@typedef\.net>\n/,
  );
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.deepEqual(manifest.pi.extensions, ["./pi-tmux-monitor.ts"]);
  assert.deepEqual(manifest.pi.skills, ["./skills/pi-tmux-monitor"]);
  assert.equal(
    manifest.peerDependencies["@earendil-works/pi-coding-agent"],
    "*",
  );
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
  assert.equal(manifest.dependencies, undefined);
  assert.ok(manifest.files.includes("docs"));
  for (const page of ["launching", "configuration", "development"])
    await access(new URL(`../docs/${page}.md`, import.meta.url));
  await access(helperPath);
  await access(reporterPath);
  const result = loadSkillsFromDir({
    dir: fileURLToPath(new URL("../skills/pi-tmux-monitor", import.meta.url)),
    source: "test",
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, "pi-tmux-monitor");
  const skillFile = new URL(
    "../skills/pi-tmux-monitor/SKILL.md",
    import.meta.url,
  );
  const skill = await readFile(skillFile, "utf8");
  assert.match(skill, /Fresh runner liveness alone means running/);
  for (const [, path, anchor] of skill.matchAll(
    /\]\(([^)#]+)(?:#([^)]*))?\)/g,
  )) {
    if (path.includes("://")) continue;
    const target = new URL(path, skillFile);
    await access(target);
    if (anchor) {
      const reference = await readFile(target, "utf8");
      const headings = [...reference.matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
        m[1]
          .toLowerCase()
          .replace(/[^a-z0-9 _-]/g, "")
          .replaceAll(" ", "-"),
      );
      assert.ok(
        headings.includes(anchor),
        `Unresolved skill link: ${path}#${anchor}`,
      );
    }
  }
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

test("global Pi package context and project-local package paths resolve their actual helper without touching the user installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "monitor-install-"));
  const host =
    process.env.PI_MONITOR_HOST_ROOT ??
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent";
  const hostManifest = JSON.parse(
    await readFile(join(host, "package.json"), "utf8"),
  );
  const exec = promisify(execFile);
  try {
    for (const local of [false, true]) {
      const agent = join(root, local ? "local-agent" : "global-agent"),
        cwd = join(root, local ? "local-project" : "global-project");
      const installed = local
        ? join(cwd, "node_modules/pi-tmux-monitor")
        : join(agent, "npm/node_modules/pi-tmux-monitor");
      await mkdir(agent, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await mkdir(installed, { recursive: true });
      for (const name of [
        "src",
        "scripts",
        "skills",
        "package.json",
        "pi-tmux-monitor.ts",
      ])
        await cp(
          new URL("../" + name, import.meta.url),
          join(installed, name),
          { recursive: true },
        );
      if (local) {
        await mkdir(join(cwd, ".pi"));
        await writeFile(
          join(cwd, ".pi/settings.json"),
          JSON.stringify({ packages: [{ source: installed, skills: [] }] }),
        );
        await writeFile(join(agent, "settings.json"), "{}");
      } else
        await writeFile(
          join(agent, "settings.json"),
          JSON.stringify({ packages: [{ source: installed, skills: [] }] }),
        );
      const probe = join(root, "probe.ts");
      await writeFile(
        probe,
        `export default function(pi){pi.on('session_start',()=>{let count=0;const timer=setInterval(()=>{if(process.env.PI_TMUX_MONITOR_HELPER || ++count>150){clearInterval(timer);console.error('INSTALL_HELPER='+process.env.PI_TMUX_MONITOR_HELPER);}},10);});}`,
      );
      const env = {
        ...process.env,
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      };
      delete env.PI_TMUX_MONITOR_HELPER;
      delete env.PI_TMUX_MONITOR_OWNER;
      delete env.PI_TMUX_MONITOR_ANCESTORS;
      delete env.TMUX;
      delete env.TMUX_PANE;
      const running = exec(
        process.execPath,
        [
          join(host, hostManifest.bin.pi),
          "--mode",
          "rpc",
          "--offline",
          "--no-session",
          "--no-context-files",
          "--no-skills",
          local ? "--approve" : "--no-approve",
          "-e",
          probe,
        ],
        { cwd, env, timeout: 10000 },
      );
      let diagnostics = "";
      running.child.stderr.on("data", (chunk) => {
        diagnostics += chunk;
        if (diagnostics.includes("INSTALL_HELPER=")) running.child.stdin.end();
      });
      const result = await running;
      assert.ok(
        result.stderr.includes(
          "INSTALL_HELPER=" + join(installed, "scripts/pi-tmux-monitor.mjs"),
        ),
        JSON.stringify({ local, stderr: result.stderr, stdout: result.stdout }),
      );
      const helper = join(installed, "scripts/pi-tmux-monitor.mjs");
      const info = JSON.parse(
        (
          await exec(process.execPath, [helper, "inspect", "--cwd", cwd], {
            cwd,
            env,
          })
        ).stdout,
      );
      assert.equal(info.state, "absent");
      assert.equal(info.socket, join(cwd, ".agents/run/tmux-socket"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
