import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { workspaceReferences } from "../src/workspaces.mts";
import { statusText } from "../src/commands.mts";
import { DEFAULTS } from "../src/config.mts";
const name = (prefix, rest = "0") => "pi-workspace-" + prefix.padEnd(64, rest);
const pane = (i, names) => ({
  paneId: `%${i}`,
  windowId: `@${i}`,
  windowIndex: "3",
  paneIndex: "1",
  state: "running",
  workload: { kind: "service", label: `job-${i}` },
  sessions: names.map((name, j) => ({ id: `$${j}`, name })),
});
const ctx = { ui: { theme: { fg: (_, s) => s, style: (s) => s } } };
const data = (slots) => ({
  identity: { version: "0.3.0" },
  config: DEFAULTS,
  slots,
  health: "healthy",
  inventoryAgeMs: 0,
});
test("generated workspaces get bare seven-character references and one mapping each", () => {
  const a = name("abcd123"),
    b = name("beef456");
  const rows = [pane(1, [a]), pane(2, [a]), pane(3, [b])];
  const { references, mappings } = workspaceReferences(rows);
  assert.equal(references.get(a), "abcd123");
  assert.equal(references.get(b), "beef456");
  assert.deepEqual(mappings, [
    { reference: "abcd123", name: a },
    { reference: "beef456", name: b },
  ]);
  const text = stripTerminalSequences(statusText(ctx, data(rows), 240));
  assert.equal(text.split(a).length - 1, 1);
  assert.equal(text.split(b).length - 1, 1);
  assert.ok(text.includes("abcd123 / @1 (3.1)"), text);
  assert.ok(text.includes("[abcd123]: " + a));
});
test("extend only colliding references and keep them stable across row orders", () => {
  const a = name("abcdef01"),
    b = name("abcdef02"),
    c = name("1234567");
  const rows = [pane(1, [a]), pane(2, [b]), pane(3, [c]), pane(4, [a])];
  const first = workspaceReferences(rows).references;
  assert.equal(first.get(a), "abcdef01");
  assert.equal(first.get(b), "abcdef02");
  assert.equal(first.get(c), "1234567");
  const second = workspaceReferences([...rows].reverse()).references;
  for (const n of [a, b, c]) assert.equal(first.get(n), second.get(n));
});
test("deep hash collisions and literal-name collisions are disambiguated", () => {
  const a = name("abcdef010"),
    b = name("abcdef011");
  const refs = workspaceReferences([pane(1, [a, b, "abcdef010"])]).references;
  assert.equal(refs.get(a), "abcdef0100");
  assert.equal(refs.get(b), "abcdef011");
  assert.equal(refs.get("abcdef010"), "abcdef010");
});
test("linked sessions map every distinct generated name once without changing IDs", () => {
  const a = name("aaaaaaa"),
    b = name("bbbbbbb");
  const rows = [pane(7, [a, b]), pane(8, [b, a])];
  const text = stripTerminalSequences(statusText(ctx, data(rows), 240));
  assert.ok(text.includes("aaaaaaa, bbbbbbb / @7 (3.1)"));
  assert.ok(text.includes("bbbbbbb, aaaaaaa / @8 (3.1)"));
  assert.equal(text.split(a).length - 1, 1);
  assert.equal(text.split(b).length - 1, 1);
  assert.ok(text.includes("%7"));
  assert.ok(text.includes("%8"));
});
test("custom names and metadata stay literal; missing identities stay unavailable", () => {
  const names = [
    "custom-name",
    "custom-deadbeef",
    "pi-workspace-not-a-hash",
    "[x](https://bad) $HOME | `q`",
    "\x1b[31mbad",
  ];
  const rows = [pane(1, names), { ...pane(2, []), sessions: [{}] }];
  const { references, mappings } = workspaceReferences(rows);
  for (const n of names) assert.equal(references.get(n), n);
  assert.deepEqual(mappings, []);
  const text = stripTerminalSequences(statusText(ctx, data(rows), 240));
  assert.ok(text.includes("custom-name"));
  assert.ok(text.includes("custom-deadbeef"));
  assert.ok(text.includes("unavailable / @2 (3.1)"));
  assert.ok(!text.includes("\x1b[31m"));
  assert.ok(text.includes("�"));
});
