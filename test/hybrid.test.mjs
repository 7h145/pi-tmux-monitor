import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { DEFAULTS, applyLayer } from "../src/config.mts";
import { format, fullSummary } from "../src/formatter.mts";
const theme = {
  fg: (color, text) => `\x1b[${color === "dim" ? 90 : 32}m${text}\x1b[39m`,
};
const states = {
  A: "active",
  R: "running",
  "+": "success",
  "!": "failed",
  "?": "unknown",
  _: "idle",
  ":": "unregistered",
};
const slots = (text) => [...text].map((glyph) => ({ state: states[glyph] }));
const plain = (r) => stripTerminalSequences(r.text ?? r);
for (const [input, output, mode] of [
  ["+++++", "+++++", "strip"],
  ["++++++", "+6", "hybrid"],
  ["ARR!!++++R?RA", "ARR|!2+4|R?RA", "hybrid"],
  ["!!++++R?RA", "!2+4|R?RA", "hybrid"],
  ["ARR!!++++", "ARR|!2+4", "hybrid"],
  ["!!!!!!A++++++", "!6|A|+6", "hybrid"],
  ["+++A+++", "+++A+++", "strip"],
  ["RRRRRR", "RRRRRR", "strip"],
])
  test(`hybrid ${input} -> ${output}`, () => {
    const result = format(slots(input), DEFAULTS, theme, 100);
    assert.equal(plain(result), output);
    assert.equal(result.mode, mode);
    assert.equal(
      plain(format(slots(input), DEFAULTS, theme, visibleWidth(output))),
      output,
    );
  });
test("dense notation, whole-set fallback and partial counts use full populations", () => {
  assert.equal(
    plain(fullSummary(slots("!!R++++++"), DEFAULTS, theme)),
    "!2R+6",
  );
  const rows = slots("AAAAARRRRR!!!!!!++++++?????");
  assert.equal(format(rows, DEFAULTS, theme, 12).mode, "summary");
  assert.equal(plain(format(rows, DEFAULTS, theme, 12)), "!6A5R5+6?5");
  assert.equal(plain(format(rows, DEFAULTS, theme, 5)), "!6A5…");
  assert.equal(plain(format(rows, DEFAULTS, theme, 4)), "!6…");
  assert.equal(plain(format(rows, DEFAULTS, theme, 1)), "…");
  const huge = Array.from({ length: 1000 }, () => ({ state: "active" }));
  huge.push({ state: "idle" });
  assert.equal(plain(format(huge, DEFAULTS, theme, 3)), "…");
});
test("uncertainty does not expand groups, change counts or duplicate tokens", () => {
  const rows = slots("ARR!!++++R");
  const baseline = format(rows, DEFAULTS, theme, 100);
  rows[3] = { state: "unknown", presentationState: "failed", uncertain: true };
  const lost = format(rows, DEFAULTS, theme, 100);
  assert.equal(plain(lost), plain(baseline));
  assert.equal(lost.mode, "hybrid");
  assert.ok(lost.text.includes("\x1b[90m!2\x1b[39m"));
  assert.equal((plain(lost).match(/!/g) || []).length, 1);
  rows[3].uncertain = false;
  rows[3].state = "failed";
  assert.equal(format(rows, DEFAULTS, theme, 100).text, baseline.text);
  rows[3].presentationState = "active";
  assert.equal(format(rows, DEFAULTS, theme, 100).mode, "strip");
});
test("themed separator inherits, merges and must be distinct single-column text", () => {
  const inherited = applyLayer(
    DEFAULTS,
    {
      activeTheme: "custom",
      themes: { custom: { states: { active: { fg: null } } } },
    },
    "/c.json",
  );
  assert.equal(inherited.themes.custom.summarySeparator, "|");
  const config = applyLayer(
    inherited,
    { themes: { custom: { summarySeparator: "/" } } },
    "/c.json",
  );
  assert.equal(plain(format(slots("A++++++R"), config, theme, 100)), "A/+6/R");
  for (const separator of ["+", "…", "2", " ", "||", "界", "\x1b", "\n"])
    assert.throws(() =>
      applyLayer(
        DEFAULTS,
        { themes: { default: { summarySeparator: separator } } },
        "/c.json",
      ),
    );
  assert.throws(() =>
    applyLayer(
      DEFAULTS,
      { themes: { default: { states: { active: { glyph: "|" } } } } },
      "/c.json",
    ),
  );
});
test("hybrid and all fallbacks respect every budget and configured orders", () => {
  const custom = applyLayer(
    DEFAULTS,
    {
      summaryOrder: [...DEFAULTS.summaryOrder].reverse(),
      themes: { default: { summarySeparator: "/" } },
    },
    "/c.json",
  );
  assert.equal(
    plain(format(slots("A!!++++R"), custom, theme, 100)),
    "A/+4!2/R",
  );
  for (const config of [DEFAULTS, custom])
    for (const input of [
      "",
      "A",
      "A!!!!!!R++++++?",
      "ARR!!++++R?RA",
      "AAAAARRRRR!!!!!!++++++?????",
    ])
      for (let width = 0; width < 160; width++) {
        const result = format(slots(input), config, theme, width);
        assert.ok(
          visibleWidth(result.text) <= width,
          JSON.stringify({ input, width, result }),
        );
        assert.ok(!plain(result).includes(" "));
        if (result.mode === "summary")
          assert.equal(
            plain(result),
            plain(fullSummary(slots(input), config, theme)),
          );
      }
});
