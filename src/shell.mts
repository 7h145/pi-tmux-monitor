// @ts-nocheck
import { relative, resolve } from "node:path";
// Tmux expands formats in start-directory arguments, even when argv is literal.
export const formatLiteral = (value) => String(value).replaceAll("#", "##");
export const quote = (value) =>
  "'" + String(value).replaceAll("'", "'\\''") + "'";
export function attachmentCommand(socket, cwd, sessionId) {
  if (!/^\$\d+$/.test(sessionId)) throw Error("Invalid attachment session");
  const path = socket;
  if (/\p{C}/u.test(path))
    throw Error("Socket path cannot be displayed safely");
  return `tmux -S ${quote(relative(resolve(cwd), path) || path)} attach -t ${quote(sessionId)}`;
}
