import { visibleWidth } from "@earendil-works/pi-tui";
// Pure presentation: slots (creation order), resolved config, current Pi theme,
// allocated columns -> {text, mode}. See README's formatter contract.
const style = (state, config, theme) => {
  const s = config.themes[config.activeTheme].states[state];
  return s.fg === null ? s.glyph : theme.fg(s.fg, s.glyph);
};
export function summaryTokens(
  slots,
  config,
  theme,
  order = config.summaryOrder,
) {
  const counts = Object.fromEntries(order.map((s) => [s, 0]));
  for (const slot of slots) counts[slot.state]++;
  return order
    .filter((s) => counts[s])
    .map((s) => ({
      text: style(s, config, theme) + (counts[s] > 1 ? counts[s] : ""),
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
  const strip = slots.map((s) => style(s.state, config, theme)).join("");
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
