import type { DisplayBlock } from "./model.js";

/**
 * Module block that a word in the inspected source names, or null.
 *
 * Only module labels are matched, since the map has no symbol index. A word
 * that names several modules is ambiguous, and the module being inspected is
 * never its own definition.
 */
export function resolveModuleDefinition(
  word: string,
  blocks: Iterable<DisplayBlock>,
  inspectedBlockId: string | null,
): DisplayBlock | null {
  if (word === "") return null;
  const matches = [...blocks].filter((block) => block.type === "module" && block.label === word && block.id !== inspectedBlockId);
  return matches.length === 1 ? matches[0]! : null;
}
