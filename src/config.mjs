import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { STATES } from "./protocol.mjs";
export const DEFAULT_THEME = {
  overflow: "…",
  states: Object.fromEntries(
    STATES.map((s, i) => [
      s,
      {
        glyph: ["_", "R", "S", "+", "!", "?", ":"][i],
        fg: ["dim", "accent", "muted", "success", "error", "warning", "dim"][i],
      },
    ]),
  ),
};
export const DEFAULTS = {
  schemaVersion: 1,
  scope: "descendants",
  includeUnregistered: true,
  socketPath: null,
  ownedSessions: [],
  pollIntervalMs: 2000,
  heartbeatIntervalMs: 5000,
  staleAfterMs: 15000,
  tmuxTimeoutMs: 1000,
  summaryOrder: [
    "failed",
    "active",
    "idle",
    "service",
    "success",
    "unknown",
    "unregistered",
  ],
  partialOrder: [
    "failed",
    "active",
    "unknown",
    "unregistered",
    "service",
    "idle",
    "success",
  ],
  activeTheme: "default",
  themes: { default: DEFAULT_THEME },
};
const fg = new Set(
  "accent border borderAccent borderMuted success error warning muted dim text thinkingText scrollbarTrack scrollbarThumb searchMatchText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh thinkingMax bashMode".split(
    " ",
  ),
);
const plain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
function safe(x) {
  if (x && typeof x === "object")
    for (const k of Object.keys(x)) {
      if (["__proto__", "constructor", "prototype"].includes(k))
        throw new Error("Unsafe key");
      safe(x[k]);
    }
}
export function merge(a, b) {
  const out = Object.assign(Object.create(null), a);
  for (const [k, v] of Object.entries(b))
    out[k] = plain(v) && plain(a[k]) ? merge(a[k], v) : v;
  return out;
}
const keys = (x, allowed) => {
  if (!plain(x) || Object.keys(x).some((k) => !allowed.includes(k)))
    throw new Error("Unknown key or invalid object");
};
function glyph(g) {
  if (
    typeof g !== "string" ||
    [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(g)]
      .length !== 1 ||
    /[\p{C}\p{N}\s]/u.test(g) ||
    visibleWidth(g) !== 1
  )
    throw new Error("Invalid glyph");
}
export function validate(config) {
  keys(config, Object.keys(DEFAULTS));
  safe(config);
  if (
    config.schemaVersion !== 1 ||
    !["children", "descendants", "server"].includes(config.scope) ||
    typeof config.includeUnregistered !== "boolean" ||
    !(
      config.socketPath === null ||
      (typeof config.socketPath === "string" && config.socketPath.length > 0)
    ) ||
    typeof config.activeTheme !== "string" ||
    !Array.isArray(config.ownedSessions) ||
    !config.ownedSessions.every(
      (s) => typeof s === "string" && s.length && !/\p{C}/u.test(s),
    )
  )
    throw new Error("Invalid config");
  for (const k of [
    "pollIntervalMs",
    "heartbeatIntervalMs",
    "staleAfterMs",
    "tmuxTimeoutMs",
  ])
    if (
      !Number.isSafeInteger(config[k]) ||
      config[k] <= 0 ||
      config[k] > 2147483647
    )
      throw new Error("Invalid timing");
  if (config.staleAfterMs < 3 * config.heartbeatIntervalMs)
    throw new Error("Stale threshold must cover three heartbeats");
  for (const k of ["summaryOrder", "partialOrder"])
    if (
      !Array.isArray(config[k]) ||
      config[k].length !== STATES.length ||
      new Set(config[k]).size !== STATES.length ||
      !config[k].every((s) => STATES.includes(s))
    )
      throw new Error("Invalid order");
  if (!plain(config.themes)) throw new Error("Invalid themes");
  for (const t of Object.values(config.themes)) {
    keys(t, ["overflow", "states"]);
    glyph(t.overflow);
    keys(t.states, STATES);
    const glyphs = [t.overflow];
    for (const s of STATES) {
      const v = t.states[s];
      keys(v, ["glyph", "fg"]);
      glyph(v.glyph);
      if (!(v.fg === null || fg.has(v.fg)))
        throw new Error("Invalid foreground");
      glyphs.push(v.glyph);
    }
    if (new Set(glyphs).size !== glyphs.length)
      throw new Error("Duplicate glyph");
  }
  return config;
}
export function applyLayer(lower, layer, file) {
  safe(layer);
  keys(layer, Object.keys(DEFAULTS));
  let candidate = merge(lower, layer);
  if (
    Object.hasOwn(layer, "socketPath") &&
    typeof layer.socketPath === "string"
  )
    candidate.socketPath = resolve(dirname(file), layer.socketPath);
  if (plain(candidate.themes))
    candidate.themes = Object.fromEntries(
      Object.entries(candidate.themes).map(([n, t]) => [
        n,
        merge(DEFAULT_THEME, t),
      ]),
    );
  return validate(candidate);
}
export async function loadConfig(
  agentDir,
  cwd,
  trusted,
  diagnostic = (_message) => {},
) {
  let config = structuredClone(DEFAULTS);
  for (const file of [
    resolve(agentDir, "pi-tmux-monitor.json"),
    ...(trusted ? [resolve(cwd, ".pi/pi-tmux-monitor.json")] : []),
  ]) {
    try {
      config = applyLayer(
        config,
        JSON.parse(await readFile(file, "utf8")),
        file,
      );
    } catch (e) {
      if (e.code !== "ENOENT")
        diagnostic(`Rejected monitor configuration: ${file}`);
    }
  }
  if (!Object.hasOwn(config.themes, config.activeTheme)) {
    diagnostic("Unknown active monitor theme; using default");
    config.activeTheme = "default";
  }
  return config;
}
