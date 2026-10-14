// @ts-nocheck
import { Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";

// Notifications are plain Text, not Markdown components. Render before sending
// them, allowing for Pi's one-column padding on each side of the notice.
export const noticeWidth = () =>
  Math.max(1, (process.stdout.columns ?? 80) - 2);
export const literalCell = (value) => String(value).replace(/\p{C}/gu, "�");
export function tableCell(value) {
  const code = (text) => {
    if (!text) return "";
    const fence = "`".repeat(
      1 + Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)),
    );
    return /^ +$/.test(text)
      ? `${fence}${text}${fence}`
      : `${fence} ${text} ${fence}`;
  };
  // Code spans keep metadata literal, including links/math. Put escaped pipes
  // between spans so preceding backslashes cannot turn them into separators.
  return literalCell(value).split("|").map(code).join("\\|");
}

export function renderTable(ctx, headers, rows, width = noticeWidth()) {
  const strong = (text) => ctx.ui.theme.style(text, { fg: "text", bold: true });
  const muted = (text) => ctx.ui.theme.fg("muted", text);
  // A cramped multi-column table is harder to read than labelled fields. This
  // also avoids Markdown's raw-source fallback when borders cannot fit.
  if (width < 7 * headers.length + 1) {
    return rows
      .map((row) =>
        new Text(
          headers
            .map(
              (header, i) =>
                `${strong(literalCell(header) + ":")} ${muted(literalCell(row[i]))}`,
            )
            .join("\n"),
          0,
          0,
        )
          .render(width)
          // A two-column character cannot fit a one-column terminal.
          .map((line) => truncateToWidth(line, width, "…"))
          .join("\n"),
      )
      .join("\n\n");
  }
  const sourceRows = [headers, ...rows].map(
    (row) => `| ${row.map(tableCell).join(" | ")} |`,
  );
  sourceRows.splice(1, 0, `| ${headers.map(() => "---").join(" | ")} |`);
  const markdown = sourceRows.join("\n");
  return new Markdown(
    markdown,
    0,
    0,
    { ...getMarkdownTheme(), bold: strong, code: muted },
    { color: muted },
    { renderLatex: false, preserveBackslashEscapes: false },
  )
    .render(width)
    .join("\n");
}
