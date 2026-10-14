import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderTable, literalCell, noticeWidth } from "../src/tables.mts";

const theme = (color) => ({
  fg: (_, text) => `\x1b[${color}m${text}\x1b[39m`,
  style: (text) => `\x1b[1;${color}m${text}\x1b[22;39m`,
});
const ctx = { ui: { theme: theme(32) } };

test("rendered table preserves literal metadata, not markup, links, math or ANSI", () => {
  const values = [
    "_",
    "*",
    "|",
    "`",
    "a``b`",
    "\\|",
    "\\\\|",
    "x|y|z",
    "[click](https://example.invalid)",
    "http://example.invalid",
    "$$x$$",
    "\\(x\\)",
    "<b>raw</b>",
    "\x1b[31m\nlabel\t",
    "漢字🙂",
    "",
  ];
  const rendered = renderTable(
    ctx,
    ["Value"],
    values.map((value) => [value]),
    180,
  );
  const plain = stripTerminalSequences(rendered);
  assert.ok(plain.includes("┌"));
  assert.ok(!plain.includes("| --- |"));
  assert.ok(!rendered.includes("\x1b]8;"));
  const cells = plain
    .split("\n")
    .filter((line) => line.startsWith("│ "))
    .slice(1)
    .map((line) => line.slice(2, line.lastIndexOf(" │")).trim());
  assert.deepEqual(
    cells,
    values.map((value) => literalCell(value).trim()),
  );
});

test("table wraps without dropping rows or fields and stacks below its usable width", () => {
  const headers = [
    "Pane",
    "Location",
    "Label",
    "Kind",
    "State",
    "Glyph",
    "Meaning",
  ];
  const rows = [
    ["%10", "東京 / @1 (0.0)", "🙂", "batch", "active", "A", "Known work"],
    [
      "%11",
      "local / @2 (1.0)",
      "retained",
      "batch",
      "success",
      "+",
      "Known exit",
    ],
  ];
  for (const width of [1, 10, 22, 30, 45, 49, 50, 51, 60, 78, 100, 140, 240]) {
    const rendered = renderTable(ctx, headers, rows, width);
    const plain = stripTerminalSequences(rendered);
    assert.ok(
      rendered.split("\n").every((line) => visibleWidth(line) <= width),
      `width ${width}`,
    );
    assert.ok(!plain.includes("| ---"), `width ${width}`);
    if (width >= 10 && width < 50) {
      assert.equal(
        plain.split("\n").filter((line) => line.startsWith("Pane:")).length,
        2,
      );
      assert.equal(
        plain.split("\n").filter((line) => line.startsWith("Glyph:")).length,
        2,
      );
      assert.ok(plain.includes("%10") && plain.includes("%11"));
      assert.ok(plain.includes("🙂"));
    }
    if (width >= 50) assert.ok(plain.includes("┌") && plain.includes("└"));
  }
});

test("table uses the invocation theme for body and headers", () => {
  const first = renderTable(
    ctx,
    ["State", "Glyph", "Meaning"],
    [["idle", "_", "Waiting"]],
    100,
  );
  const second = renderTable(
    { ui: { theme: theme(35) } },
    ["State", "Glyph", "Meaning"],
    [["idle", "_", "Waiting"]],
    100,
  );
  assert.equal(stripTerminalSequences(first), stripTerminalSequences(second));
  assert.ok(first.includes("\x1b[32m"));
  assert.ok(second.includes("\x1b[35m"));
  assert.notEqual(first, second);
});

test("notice width leaves room for Pi Text padding and has a non-TTY default", () => {
  const saved = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  try {
    for (const [columns, expected] of [
      [100, 98],
      [45, 43],
      [1, 1],
      [undefined, 78],
    ]) {
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: columns,
      });
      assert.equal(noticeWidth(), expected);
    }
  } finally {
    if (saved) Object.defineProperty(process.stdout, "columns", saved);
    else delete process.stdout.columns;
  }
});
