import type { DisplayBlock } from "./model.js";
import type { SourceDefinition } from "./map-source.js";

export type DefinitionTarget =
  | { readonly kind: "block"; readonly blockId: string }
  | { readonly kind: "definition"; readonly definition: SourceDefinition };

/** A unique declaration, or the existing module jump when no symbol has that name. */
export function resolveSourceDefinition(
  word: string,
  blocks: Iterable<DisplayBlock>,
  inspectedBlockId: string | null,
  definitions: readonly SourceDefinition[],
): DefinitionTarget | null {
  if (word === "") return null;
  const allBlocks = [...blocks];
  const modules = allBlocks.filter((block) => block.type === "module" && block.label === word && block.id !== inspectedBlockId);
  const symbols = definitions.filter((definition) => definition.name === word);
  if (symbols.length > 1) return null;
  const symbol = symbols[0];
  if (symbol !== undefined) {
    const source = allBlocks.find((block) => block.id === symbol.blockId)?.sourcePath;
    if (source === undefined || source === null || modules.some((block) => block.sourcePath !== source)) return null;
    return { kind: "definition", definition: symbol };
  }
  const module = modules.length === 1 ? modules[0] : undefined;
  return module === undefined ? null : { kind: "block", blockId: module.id };
}
