import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
const exec = promisify(execFile);

async function fixture(mode, check) {
  const cwd = await mkdtemp("/tmp/monitor-runner-");
  const resultPath = join(cwd, "records.json"),
    ackPath = join(cwd, "startup.json");
  const argv =
    mode === "unavailable"
      ? ["/no-such-monitor-executable"]
      : mode === "spawn-error"
        ? [join(cwd, "broken")]
        : [
            process.execPath,
            "-e",
            "process.stdout.write('workload-out\\n');process.stderr.write('workload-err\\n');setTimeout(()=>process.exit(7),100)",
          ];
  if (mode === "spawn-error")
    await writeFile(argv[0], "#!/no-such-monitor-interpreter\n", {
      mode: 0o700,
    });
  const plan = {
    cwd,
    argv,
    ackPath,
    owner: "owner",
    ancestors: ["owner"],
    jobId: "job",
    runtime: "command",
    kind: "batch",
    heartbeat: 5,
    timeout: 1000,
  };
  const source = `
    import { Tmux } from ${JSON.stringify(new URL("../src/tmux.mts", import.meta.url).href)};
    import { run } from ${JSON.stringify(new URL("../src/runner.mjs", import.meta.url).href)};
    import { writeFile } from 'node:fs/promises';
    const records = [], mode = ${JSON.stringify(mode)};
    let writes = 0, identities = 0, jobReads = 0;
    Tmux.prototype.ownIdentity = async () => 'original';
    Tmux.prototype.identity = async () => mode === 'replaced' && ++identities > 1 ? 'replacement' : 'original';
    Tmux.prototype.record = async (type) => mode === 'recover' ?
      type === 'pi' ? {instanceId:'previous'} : ++jobReads === 1 ? {jobId:'previous'} : null : null;
    Tmux.prototype.removeOwned = async () => { throw Error('cleanup rejected'); };
    Tmux.prototype.write = async (type, target, record) => {
      writes++;
      if (mode === 'recover' && writes <= 3) throw Error('write rejected');
      if (mode === 'pending' && writes === 2)
        await new Promise((_, reject) => process.once('beforeExit', () => reject(Error('write rejected'))));
      records.push(structuredClone(record));
    };
    const code = await run(${JSON.stringify(plan)}, {...process.env, TMUX:'/fake,1,0', TMUX_PANE:'%1'});
    await writeFile(${JSON.stringify(resultPath)}, JSON.stringify(records));
    process.exitCode = code;
  `;
  try {
    let result;
    try {
      await exec(
        process.execPath,
        [
          "--import",
          new URL("./host-peers.mjs", import.meta.url).href,
          "--input-type=module",
          "-e",
          source,
        ],
        { timeout: 10000 },
      );
      assert.fail("fixture must retain the requested failure exit code");
    } catch (error) {
      assert.equal(
        error.code,
        ["unavailable", "spawn-error"].includes(mode) ? 127 : 7,
        error.stderr,
      );
      result = error;
    }
    await check({
      ...result,
      records: JSON.parse(await readFile(resultPath, "utf8")),
      ack: JSON.parse(await readFile(ackPath, "utf8")),
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("runner background failures are recorded without mixing into workload stdout/stderr or changing its exit", () =>
  fixture("recover", ({ stdout, stderr, records, ack }) => {
    assert.equal(stdout, "workload-out\n");
    assert.equal(stderr, "workload-err\n");
    assert.equal(ack.state, "ready");
    const final = records.at(-1);
    assert.equal(final.phase, "failed");
    assert.equal(final.exitCode, 7);
    assert.deepEqual(final.diagnostics.sort(), [
      "job-cleanup-failed",
      "reporter-cleanup-failed",
      "write-failed",
    ]);
  }));

test("a queued final write includes diagnostics from an earlier in-flight failure", () =>
  fixture("pending", ({ stdout, stderr, records }) => {
    assert.equal(stdout, "workload-out\n");
    assert.equal(stderr, "workload-err\n");
    assert.equal(records.at(-1).phase, "failed");
    assert.equal(records.at(-1).exitCode, 7);
    assert.deepEqual(records.at(-1).diagnostics, ["write-failed"]);
  }));

test("server replacement stops runner reporting but not the workload and adds no stderr warning", () =>
  fixture("replaced", ({ stdout, stderr, records, ack }) => {
    assert.equal(stdout, "workload-out\n");
    assert.equal(stderr, "workload-err\n");
    assert.equal(ack.state, "ready");
    assert.equal(records.length, 1);
    assert.equal(records[0].phase, "running");
  }));

for (const mode of ["unavailable", "spawn-error"]) {
  test(`requested runner startup failure still returns acknowledgement, stderr and exit (${mode})`, () =>
    fixture(mode, ({ stdout, stderr, records, ack }) => {
      assert.equal(stdout, "");
      assert.match(
        stderr,
        mode === "unavailable"
          ? /Server-side working directory/
          : /Monitored command could not start/,
      );
      assert.equal(ack.state, "unavailable");
      assert.match(ack.reason, /unavailable|could not start/);
      assert.equal(records.at(-1).phase, "failed");
      assert.equal(records.at(-1).exitCode, 127);
    }));
}
