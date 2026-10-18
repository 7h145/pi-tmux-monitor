// @ts-nocheck
import { visibleWidth } from "@earendil-works/pi-tui";
// Pure presentation: slots (creation order), resolved config, current Pi theme,
// allocated columns -> {text, mode}. See docs/development.md for the contract.
export const presentationState = (slot) => slot.presentationState ?? slot.state;
const style = (state, config, theme, uncertain = false, count = 1) => {
  const s = config.themes[config.activeTheme].states[state];
  const fg = uncertain ? "dim" : s.fg;
  const text = s.glyph + (count > 1 ? count : "");
  return fg === null ? text : theme.fg(fg, text);
};
export function slotGlyph(slot, config, theme) {
  const state = presentationState(slot);
  return style(state, config, theme, slot.uncertain ?? state === "unknown");
}
export function summaryTokens(
  slots,
  config,
  theme,
  order = config.summaryOrder,
) {
  const counts = Object.fromEntries(order.map((s) => [s, 0]));
  const uncertain = new Set();
  for (const slot of slots) {
    const state = presentationState(slot);
    counts[state]++;
    if (slot.uncertain ?? state === "unknown") uncertain.add(state);
  }
  return order
    .filter((s) => counts[s])
    .map((s) => ({
      text: style(s, config, theme, uncertain.has(s), counts[s]),
    }));
}
const join = (tokens) => tokens.map((token) => token.text).join("");

// Group only consecutive outcome presentations; never reorder pane identities.
function hybrid(slots, config, theme) {
  const outcome = (slot) =>
    slot.compressionEligible !== false &&
    ["success", "failed"].includes(presentationState(slot));
  const parts = [];
  for (let i = 0; i < slots.length; ) {
    let end = i;
    while (end < slots.length && outcome(slots[end])) end++;
    if (end - i >= 6) {
      parts.push({
        text: fullSummary(slots.slice(i, end), config, theme),
        summary: true,
      });
      i = end;
    } else {
      parts.push({
        text: slotGlyph(slots[i++], config, theme),
        summary: false,
      });
    }
  }
  const separator = config.themes[config.activeTheme].summarySeparator;
  return {
    text: parts
      .map(
        (part, i) =>
          (i && (part.summary || parts[i - 1].summary) ? separator : "") +
          part.text,
      )
      .join(""),
    mode: parts.some((part) => part.summary) ? "hybrid" : "strip",
  };
}
export function fullSummary(slots, config, theme) {
  return join(summaryTokens(slots, config, theme));
}
export function format(slots, config, theme, columns) {
  const budget = Math.max(0, Math.floor(columns));
  if (!slots.length || !budget) return { text: "", mode: "hidden" };
  const candidate = hybrid(slots, config, theme);
  if (visibleWidth(candidate.text) <= budget) return candidate;
  const summary = fullSummary(slots, config, theme);
  if (visibleWidth(summary) <= budget)
    return { text: summary, mode: "summary" };
  const kept = [];
  for (const token of summaryTokens(
    slots,
    config,
    theme,
    config.partialOrder,
  )) {
    if (visibleWidth(join([...kept, token])) > budget - 1) break;
    kept.push(token);
  }
  return {
    text: join(kept) + config.themes[config.activeTheme].overflow,
    mode: "partial",
  };
}
