// @ts-nocheck
import { visibleWidth } from "@earendil-works/pi-tui";
// Pure presentation: slots (creation order), resolved config, current Pi theme,
// allocated columns -> {text, mode}. See README's formatter contract.
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
      singleton: counts[s] === 1,
    }));
}
function join(tokens) {
  return tokens
    .map(
      (t, i) =>
        (i && !(t.singleton && tokens[i - 1].singleton) ? " " : "") + t.text,
    )
    .join("");
}
export function fullSummary(slots, config, theme) {
  return join(summaryTokens(slots, config, theme));
}
export function format(slots, config, theme, columns) {
  const budget = Math.max(0, Math.floor(columns));
  if (!slots.length || !budget) return { text: "", mode: "hidden" };
  const strip = slots.map((s) => slotGlyph(s, config, theme)).join("");
  if (visibleWidth(strip) <= budget) return { text: strip, mode: "strip" };
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
