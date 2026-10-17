// @ts-nocheck
// Display-only references. Never use these abbreviations as tmux targets.
const workspaceId = (name) => /^pi-workspace-([a-f0-9]{64})$/.exec(name)?.[1];

export function workspaceReferences(slots) {
  const names = [
    ...new Set(
      slots.flatMap((pane) =>
        (pane.sessions ?? [])
          .map((session) => session.name)
          .filter((name) => typeof name === "string"),
      ),
    ),
  ];
  const generated = names.filter((name) => workspaceId(name));
  const literal = new Set(names.filter((name) => !workspaceId(name)));
  const references = new Map(names.map((name) => [name, name]));
  const mappings = [];
  for (const name of generated) {
    const id = workspaceId(name);
    let size = 7;
    while (
      size < id.length &&
      (literal.has(id.slice(0, size)) ||
        generated.some(
          (other) =>
            other !== name && workspaceId(other).startsWith(id.slice(0, size)),
        ))
    )
      size++;
    const reference = id.slice(0, size);
    references.set(name, reference);
    mappings.push({ reference, name });
  }
  return { references, mappings };
}
