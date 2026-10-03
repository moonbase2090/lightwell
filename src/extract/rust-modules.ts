import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface RustModuleDeclaration {
  readonly name: string;
  readonly attributes: readonly string[];
  readonly pathAttribute: string | null;
  readonly inlineChildren: readonly RustModuleDeclaration[] | null;
}

interface Token {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function isIdentifierStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function skipQuoted(source: string, start: number, quote: string, prefixLength: number): number {
  let cursor = start + prefixLength;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    cursor += 1;
    if (char === quote) return cursor;
  }
  return cursor;
}

function skipRawString(source: string, start: number, quoteOffset: number): number {
  const quote = source.indexOf('"', start + quoteOffset);
  if (quote < 0) return source.length;
  const hashes = source.slice(start + quoteOffset, quote).length;
  const terminator = `"${"#".repeat(hashes)}`;
  const close = source.indexOf(terminator, quote + 1);
  return close < 0 ? source.length : close + terminator.length;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }
    if (source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      let depth = 1;
      cursor += 2;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      continue;
    }
    const rawStringPrefix = source.slice(cursor).match(/^(?:b)?r(#+)?"/);
    if (rawStringPrefix !== null) {
      const end = skipRawString(source, cursor, rawStringPrefix[0].length - (rawStringPrefix[1]?.length ?? 0) - 1);
      tokens.push({ value: "<literal>", start: cursor, end });
      cursor = end;
      continue;
    }
    if (char === '"' || (char === "b" && source[cursor + 1] === '"')) {
      const prefixLength = char === "b" ? 2 : 1;
      const end = skipQuoted(source, cursor, '"', prefixLength);
      tokens.push({ value: "<literal>", start: cursor, end });
      cursor = end;
      continue;
    }
    if (isIdentifierStart(char)) {
      const start = cursor;
      cursor += 1;
      while (isIdentifierPart(source[cursor])) cursor += 1;
      tokens.push({ value: source.slice(start, cursor), start, end: cursor });
      continue;
    }
    tokens.push({ value: char, start: cursor, end: cursor + 1 });
    cursor += 1;
  }
  return tokens;
}

function matchingClose(tokens: readonly Token[], openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1;
    if (tokens[index].value === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return tokens.length;
}

function parsePathAttribute(attributes: readonly string[]): string | null {
  for (const attribute of attributes) {
    const match = attribute.match(/^#\[\s*path\s*=\s*"([^"\\]+)"\s*\]$/);
    if (match !== null) return match[1];
  }
  return null;
}

function splitCfgArguments(source: string): string[] {
  const argumentsList: string[] = [];
  let depth = 0;
  let segmentStart = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      argumentsList.push(source.slice(segmentStart, index).trim());
      segmentStart = index + 1;
    }
  }
  const finalArgument = source.slice(segmentStart).trim();
  if (finalArgument.length > 0) argumentsList.push(finalArgument);
  return argumentsList;
}

function cfgRequiresTest(expression: string): boolean {
  const normalized = expression.trim();
  if (normalized === "test") return true;
  const call = normalized.match(/^(all|any|not)\((.*)\)$/s);
  if (call === null) return false;
  const argumentsList = splitCfgArguments(call[2]);
  if (call[1] === "all") return argumentsList.some(cfgRequiresTest);
  if (call[1] === "any") return argumentsList.length > 0 && argumentsList.every(cfgRequiresTest);
  return false;
}

function isTestOnly(attributes: readonly string[]): boolean {
  return attributes.some((attribute) => {
    const cfg = attribute.match(/^#\[\s*cfg\s*\((.*)\)\s*\]$/s)?.[1];
    return cfg !== undefined && cfgRequiresTest(cfg);
  });
}

function parseScope(source: string, tokens: readonly Token[], start: number, end: number): RustModuleDeclaration[] {
  const declarations: RustModuleDeclaration[] = [];
  let cursor = start;
  while (cursor < end) {
    const attributes: string[] = [];
    while (tokens[cursor]?.value === "#") {
      let bracketIndex = cursor + 1;
      if (tokens[bracketIndex]?.value === "!") bracketIndex += 1;
      if (tokens[bracketIndex]?.value !== "[") break;
      const closeIndex = matchingClose(tokens, bracketIndex, "[", "]");
      if (closeIndex >= end) break;
      attributes.push(source.slice(tokens[cursor].start, tokens[closeIndex].end));
      cursor = closeIndex + 1;
    }

    if (tokens[cursor]?.value === "pub") {
      cursor += 1;
      if (tokens[cursor]?.value === "(") cursor = matchingClose(tokens, cursor, "(", ")") + 1;
    }

    if (tokens[cursor]?.value === "mod" && isIdentifierStart(tokens[cursor + 1]?.value[0])) {
      const name = tokens[cursor + 1].value;
      const terminator = tokens[cursor + 2]?.value;
      if (terminator === ";") {
        if (!isTestOnly(attributes)) {
          declarations.push({ name, attributes, pathAttribute: parsePathAttribute(attributes), inlineChildren: null });
        }
        cursor += 3;
        continue;
      }
      if (terminator === "{") {
        const closeIndex = matchingClose(tokens, cursor + 2, "{", "}");
        if (!isTestOnly(attributes)) {
          declarations.push({
            name,
            attributes,
            pathAttribute: parsePathAttribute(attributes),
            inlineChildren: parseScope(source, tokens, cursor + 3, closeIndex),
          });
        }
        cursor = closeIndex + 1;
        continue;
      }
    }

    // Skip the rest of this item, including function bodies and grouped use paths.
    let itemEnded = false;
    while (cursor < end && !itemEnded) {
      const value = tokens[cursor].value;
      if (value === "(" || value === "[" || value === "{") {
        const close = matchingClose(tokens, cursor, value, value === "(" ? ")" : value === "[" ? "]" : "}");
        cursor = close + 1;
        if (value === "{" && tokens[cursor]?.value !== ";") itemEnded = true;
      } else if (value === ";") {
        cursor += 1;
        itemEnded = true;
      } else {
        cursor += 1;
      }
    }
  }
  return declarations;
}

export function rustModuleDeclarations(source: string): readonly RustModuleDeclaration[] {
  const tokens = tokenize(source);
  return parseScope(source, tokens, 0, tokens.length);
}

export function moduleDirectoryForSource(sourcePath: string): string {
  const basename = path.basename(sourcePath);
  if (basename === "mod.rs" || basename === "lib.rs" || basename === "main.rs" || basename === "bin.rs") {
    return path.dirname(sourcePath);
  }
  return path.join(path.dirname(sourcePath), path.basename(sourcePath, ".rs"));
}

export function resolveModuleSource(args: {
  readonly declaration: RustModuleDeclaration;
  readonly parentDirectory: string;
  readonly declarationDirectory: string;
}): string | null {
  const { declaration, parentDirectory } = args;
  if (declaration.pathAttribute !== null) {
    const candidate = path.resolve(args.declarationDirectory, declaration.pathAttribute);
    return existsSync(candidate) ? candidate : null;
  }
  const candidates = [
    path.join(parentDirectory, `${declaration.name}.rs`),
    path.join(parentDirectory, declaration.name, "mod.rs"),
  ];
  return candidates.find(existsSync) ?? null;
}

export function readModuleSource(sourcePath: string): string {
  return readFileSync(sourcePath, "utf8");
}
