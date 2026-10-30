export interface StateChartSource {
  readonly path: string;
  readonly content: string;
}

export type StateChartLanguage = "rust" | "typescript";

export interface StateChartState {
  readonly kind: "state" | "summary";
  readonly id: string;
  readonly label: string;
  readonly line: number | null;
  readonly initial: boolean;
}

export interface StateChartTransition {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label: string;
  readonly line: number;
}

export interface StateMachine {
  readonly id: string;
  readonly label: string;
  readonly language: StateChartLanguage;
  readonly states: readonly StateChartState[];
  readonly transitions: readonly StateChartTransition[];
}

export interface StateChart {
  readonly sourcePath: string;
  readonly machines: readonly StateMachine[];
  readonly omittedStates: number;
  readonly omittedTransitions: number;
}

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

export interface StateChartRegion {
  readonly id: string;
  readonly label: string;
  readonly language: StateChartLanguage;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface StateChartNode extends StateChartState {
  readonly machineId: string;
  readonly terminal: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface StateChartEdge extends StateChartTransition {
  readonly points: readonly ChartPoint[];
  readonly labelX: number;
  readonly labelY: number;
}

export interface StateChartLayout {
  readonly width: number;
  readonly height: number;
  readonly regions: readonly StateChartRegion[];
  readonly nodes: readonly StateChartNode[];
  readonly edges: readonly StateChartEdge[];
}

interface EnumDeclaration {
  readonly name: string;
  readonly language: StateChartLanguage;
  readonly states: readonly StateChartState[];
}

interface Range {
  readonly start: number;
  readonly end: number;
}

const MAX_STATES = 120;
const MAX_TRANSITIONS = 240;
const NODE_WIDTH = 180;
const NODE_HEIGHT = 56;
const COLUMN_GAP = 32;
const ROW_GAP = 72;
const REGION_X = 24;
const REGION_TOP = 44;
const REGION_PADDING = 24;
const REGION_GAP = 32;

function languageFor(path: string): StateChartLanguage | null {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".rs")) return "rust";
  if ([".ts", ".tsx", ".js", ".jsx"].some((extension) => normalized.endsWith(extension))) return "typescript";
  return null;
}

function maskNonCode(source: string, language: StateChartLanguage): string {
  const chars = [...source];
  let mode: "code" | "line-comment" | "block-comment" | "string" = "code";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index] ?? "";
    const next = chars[index + 1] ?? "";
    if (mode === "code") {
      if (current === "/" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        mode = "line-comment";
      } else if (current === "/" && next === "*") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        mode = "block-comment";
      } else if (current === "'" && language === "rust"
        && /[A-Za-z_]/.test(next) && chars[index + 2] !== "'") {
        continue;
      } else if (current === "\"" || current === "'" || current === "`") {
        quote = current;
        chars[index] = " ";
        mode = "string";
      }
      continue;
    }
    if (mode === "line-comment") {
      if (current === "\n") mode = "code";
      else chars[index] = " ";
      continue;
    }
    if (mode === "block-comment") {
      if (current === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        mode = "code";
      } else if (current !== "\n") {
        chars[index] = " ";
      }
      continue;
    }
    if (current === "\n") continue;
    chars[index] = " ";
    if (escaped) {
      escaped = false;
    } else if (current === "\\") {
      escaped = true;
    } else if (current === quote) {
      mode = "code";
    }
  }
  return chars.join("");
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function closingBrace(source: string, opening: number): number | null {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function topLevelRanges(source: string, delimiter: string): readonly Range[] {
  const ranges: Range[] = [];
  let start = 0;
  let braceDepth = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    switch (source[index]) {
      case "{": braceDepth += 1; break;
      case "}": braceDepth -= 1; break;
      case "(": parenthesisDepth += 1; break;
      case ")": parenthesisDepth -= 1; break;
      case "[": bracketDepth += 1; break;
      case "]": bracketDepth -= 1; break;
      default: break;
    }
    if (source[index] === delimiter && braceDepth === 0 && parenthesisDepth === 0 && bracketDepth === 0) {
      ranges.push({ start, end: index });
      start = index + 1;
    }
  }
  if (source.slice(start).trim().length > 0) ranges.push({ start, end: source.length });
  return ranges;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function enumDeclarations(source: string, language: StateChartLanguage): readonly EnumDeclaration[] {
  const declarations: EnumDeclaration[] = [];
  const pattern = /\benum\s+([A-Za-z_][A-Za-z0-9_]*)[^\{]*\{/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const opening = (match.index ?? 0) + match[0].lastIndexOf("{");
    const closing = closingBrace(source, opening);
    if (name === undefined || closing === null) continue;
    const bodyStart = opening + 1;
    const body = source.slice(bodyStart, closing);
    const states: StateChartState[] = [];
    for (const range of topLevelRanges(body, ",")) {
      const item = body.slice(range.start, range.end);
      const withoutAttributes = item.replace(/#\s*\[[^\]]*\]/g, " ").trimStart();
      const variant = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(withoutAttributes)?.[1];
      if (variant === undefined) continue;
      states.push({
        kind: "state",
        id: `${name}::${variant}`,
        label: variant,
        line: lineAt(source, bodyStart + range.start + item.indexOf(variant)),
        initial: language === "rust" && /#\s*\[\s*default\s*\]/.test(item),
      });
    }
    declarations.push({ name, language, states });
    pattern.lastIndex = closing + 1;
  }
  return declarations;
}

function rustTransitions(source: string, declaration: EnumDeclaration): readonly StateChartTransition[] {
  const transitions: StateChartTransition[] = [];
  const matchPattern = /\bmatch\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  const enumPattern = escapePattern(declaration.name);
  const sourcePattern = new RegExp(`\\b${enumPattern}\\s*::\\s*([A-Za-z_][A-Za-z0-9_]*)`);
  const stateIds = new Set(declaration.states.map((state) => state.id));
  for (const match of source.matchAll(matchPattern)) {
    const subject = match[1];
    if (subject === undefined) continue;
    const opening = (match.index ?? 0) + match[0].lastIndexOf("{");
    const closing = closingBrace(source, opening);
    if (closing === null) continue;
    const bodyStart = opening + 1;
    const body = source.slice(bodyStart, closing);
    for (const range of topLevelRanges(body, ",")) {
      const arm = body.slice(range.start, range.end);
      const arrow = arm.indexOf("=>");
      if (arrow < 0) continue;
      const left = arm.slice(0, arrow);
      const sourceVariant = sourcePattern.exec(left)?.[1];
      const sourceId = sourceVariant === undefined ? "" : `${declaration.name}::${sourceVariant}`;
      if (!stateIds.has(sourceId)) continue;
      const guard = /\bif\s+(.+)$/.exec(left.trim())?.[0].replace(/\s+/g, " ").slice(0, 32) ?? "transition";
      const right = arm.slice(arrow + 2);
      const candidates = new Set<string>();
      const direct = new RegExp(`^\\s*${enumPattern}\\s*::\\s*([A-Za-z_][A-Za-z0-9_]*)`).exec(right)?.[1];
      if (direct !== undefined) candidates.add(direct);
      const returned = new RegExp(`\\breturn\\s+${enumPattern}\\s*::\\s*([A-Za-z_][A-Za-z0-9_]*)`, "g");
      for (const target of right.matchAll(returned)) {
        if (target[1] !== undefined) candidates.add(target[1]);
      }
      const assigned = new RegExp(`\\b${escapePattern(subject)}\\s*=\\s*${enumPattern}\\s*::\\s*([A-Za-z_][A-Za-z0-9_]*)`, "g");
      for (const target of right.matchAll(assigned)) {
        if (target[1] !== undefined) candidates.add(target[1]);
      }
      const tail = new RegExp(`${enumPattern}\\s*::\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\}?\\s*$`).exec(right)?.[1];
      if (tail !== undefined) candidates.add(tail);
      for (const target of candidates) {
        const targetId = `${declaration.name}::${target}`;
        if (!stateIds.has(targetId)) continue;
        transitions.push({
          id: `${declaration.name}:${transitions.length}`,
          source: sourceId,
          target: targetId,
          label: guard,
          line: lineAt(source, bodyStart + range.start),
        });
      }
    }
    matchPattern.lastIndex = closing + 1;
  }
  return transitions;
}

function typescriptTransitions(source: string, declaration: EnumDeclaration): readonly StateChartTransition[] {
  const transitions: StateChartTransition[] = [];
  const switchPattern = /\bswitch\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*\{/g;
  const enumPattern = escapePattern(declaration.name);
  const casePattern = new RegExp(`\\bcase\\s+${enumPattern}\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*:`, "g");
  const stateIds = new Set(declaration.states.map((state) => state.id));
  for (const match of source.matchAll(switchPattern)) {
    const subject = match[1];
    if (subject === undefined) continue;
    const opening = (match.index ?? 0) + match[0].lastIndexOf("{");
    const closing = closingBrace(source, opening);
    if (closing === null) continue;
    const bodyStart = opening + 1;
    const body = source.slice(bodyStart, closing);
    const cases = [...body.matchAll(casePattern)];
    for (let index = 0; index < cases.length; index += 1) {
      const current = cases[index];
      const variant = current?.[1];
      const sourceId = variant === undefined ? "" : `${declaration.name}::${variant}`;
      if (current === undefined || !stateIds.has(sourceId)) continue;
      const segmentStart = (current.index ?? 0) + current[0].length;
      const segmentEnd = cases[index + 1]?.index ?? body.length;
      const segment = body.slice(segmentStart, segmentEnd).split(/\bdefault\s*:/, 1)[0] ?? "";
      const candidates = new Set<string>();
      const returned = new RegExp(`\\breturn\\s+${enumPattern}\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)`, "g");
      for (const target of segment.matchAll(returned)) {
        if (target[1] !== undefined) candidates.add(target[1]);
      }
      const assigned = new RegExp(`\\b${escapePattern(subject)}\\s*=\\s*${enumPattern}\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)`, "g");
      for (const target of segment.matchAll(assigned)) {
        if (target[1] !== undefined) candidates.add(target[1]);
      }
      for (const target of candidates) {
        const targetId = `${declaration.name}::${target}`;
        if (!stateIds.has(targetId)) continue;
        transitions.push({
          id: `${declaration.name}:${transitions.length}`,
          source: sourceId,
          target: targetId,
          label: "transition",
          line: lineAt(source, bodyStart + (current.index ?? 0)),
        });
      }
    }
    switchPattern.lastIndex = closing + 1;
  }
  return transitions;
}

function uniqueTransitions(transitions: readonly StateChartTransition[]): readonly StateChartTransition[] {
  const seen = new Set<string>();
  return transitions.filter((transition) => {
    const key = `${transition.source}\0${transition.target}\0${transition.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function detectStateChart(input: StateChartSource): StateChart {
  const language = languageFor(input.path);
  if (language === null) return { sourcePath: input.path, machines: [], omittedStates: 0, omittedTransitions: 0 };
  const source = maskNonCode(input.content, language);
  const machines: StateMachine[] = [];
  let stateBudget = MAX_STATES;
  let transitionBudget = MAX_TRANSITIONS;
  let omittedStates = 0;
  let omittedTransitions = 0;
  for (const declaration of enumDeclarations(source, language)) {
    const detected = uniqueTransitions(language === "rust"
      ? rustTransitions(source, declaration)
      : typescriptTransitions(source, declaration));
    if (detected.length === 0) continue;
    const keptStates = declaration.states.slice(0, stateBudget);
    const keptIds = new Set(keptStates.map((state) => state.id));
    const eligibleTransitions = detected.filter((transition) => keptIds.has(transition.source) && keptIds.has(transition.target));
    const keptTransitions = eligibleTransitions.slice(0, transitionBudget);
    const declarationOmittedStates = declaration.states.length - keptStates.length;
    omittedStates += declarationOmittedStates;
    omittedTransitions += detected.length - keptTransitions.length;
    const states = declarationOmittedStates === 0 ? keptStates : [
      ...keptStates,
      {
        kind: "summary" as const,
        id: `${declaration.name}::__summary`,
        label: `+${declarationOmittedStates} states`,
        line: null,
        initial: false,
      },
    ];
    machines.push({
      id: declaration.name,
      label: declaration.name,
      language,
      states,
      transitions: keptTransitions,
    });
    stateBudget -= keptStates.length;
    transitionBudget -= keptTransitions.length;
    if (stateBudget === 0 || transitionBudget === 0) break;
  }
  return { sourcePath: input.path, machines, omittedStates, omittedTransitions };
}

function stronglyConnectedComponents(states: readonly StateChartState[], transitions: readonly StateChartTransition[]): readonly (readonly string[])[] {
  const adjacency = new Map(states.map((state) => [state.id, [] as string[]]));
  for (const transition of transitions) adjacency.get(transition.source)?.push(transition.target);
  const indexById = new Map<string, number>();
  const lowById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (id: string): void => {
    indexById.set(id, nextIndex);
    lowById.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of adjacency.get(id) ?? []) {
      if (!indexById.has(target)) {
        visit(target);
        lowById.set(id, Math.min(lowById.get(id) ?? 0, lowById.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lowById.set(id, Math.min(lowById.get(id) ?? 0, indexById.get(target) ?? 0));
      }
    }
    if (lowById.get(id) !== indexById.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    components.push(component.reverse());
  };

  for (const state of states) {
    if (!indexById.has(state.id)) visit(state.id);
  }
  return components;
}

function ranksFor(states: readonly StateChartState[], transitions: readonly StateChartTransition[]): ReadonlyMap<string, number> {
  const components = stronglyConnectedComponents(states, transitions);
  const componentByState = new Map<string, number>();
  components.forEach((component, index) => component.forEach((id) => componentByState.set(id, index)));
  const outgoing = components.map(() => new Set<number>());
  const indegree = components.map(() => 0);
  for (const transition of transitions) {
    const source = componentByState.get(transition.source);
    const target = componentByState.get(transition.target);
    if (source === undefined || target === undefined || source === target || outgoing[source]?.has(target)) continue;
    outgoing[source]?.add(target);
    indegree[target] = (indegree[target] ?? 0) + 1;
  }
  const queue = indegree.flatMap((degree, index) => degree === 0 ? [index] : []);
  const componentRanks = components.map(() => 0);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const source = queue[cursor];
    if (source === undefined) continue;
    for (const target of outgoing[source] ?? []) {
      componentRanks[target] = Math.max(componentRanks[target] ?? 0, (componentRanks[source] ?? 0) + 1);
      indegree[target] = (indegree[target] ?? 1) - 1;
      if (indegree[target] === 0) queue.push(target);
    }
  }
  return new Map(states.map((state) => [state.id, componentRanks[componentByState.get(state.id) ?? 0] ?? 0]));
}

function routeEdge(source: StateChartNode, target: StateChartNode): readonly ChartPoint[] {
  if (source.id === target.id) {
    const right = source.x + source.width;
    return [
      { x: right, y: source.y + source.height / 2 },
      { x: right + 22, y: source.y + source.height / 2 },
      { x: right + 22, y: source.y - 16 },
      { x: source.x + source.width / 2, y: source.y - 16 },
      { x: source.x + source.width / 2, y: source.y },
    ];
  }
  if (source.y === target.y) {
    const leftToRight = source.x < target.x;
    return [
      { x: leftToRight ? source.x + source.width : source.x, y: source.y + source.height / 2 },
      { x: leftToRight ? target.x : target.x + target.width, y: target.y + target.height / 2 },
    ];
  }
  const start = { x: source.x + source.width / 2, y: source.y + source.height };
  const end = { x: target.x + target.width / 2, y: target.y };
  const middleY = start.y + (end.y - start.y) / 2;
  return [start, { x: start.x, y: middleY }, { x: end.x, y: middleY }, end];
}

export function layoutStateChart(chart: StateChart): StateChartLayout {
  if (chart.machines.length === 0) return { width: 0, height: 0, regions: [], nodes: [], edges: [] };
  const regions: StateChartRegion[] = [];
  const nodes: StateChartNode[] = [];
  const edges: StateChartEdge[] = [];
  let regionY = 24;
  let chartWidth = 0;
  for (const machine of chart.machines) {
    const ranks = ranksFor(machine.states, machine.transitions);
    const rows = new Map<number, StateChartState[]>();
    for (const state of machine.states) {
      const rank = ranks.get(state.id) ?? 0;
      const row = rows.get(rank) ?? [];
      row.push(state);
      rows.set(rank, row);
    }
    const rowEntries = [...rows.entries()].sort(([left], [right]) => left - right);
    const widest = Math.max(...rowEntries.map(([, row]) => row.length));
    const regionWidth = REGION_PADDING * 2 + widest * NODE_WIDTH + Math.max(0, widest - 1) * COLUMN_GAP;
    const regionHeight = REGION_TOP + REGION_PADDING + rowEntries.length * NODE_HEIGHT + Math.max(0, rowEntries.length - 1) * ROW_GAP;
    const region: StateChartRegion = {
      id: machine.id,
      label: machine.label,
      language: machine.language,
      x: REGION_X,
      y: regionY,
      width: regionWidth,
      height: regionHeight,
    };
    regions.push(region);
    const outgoing = new Set(machine.transitions.map((transition) => transition.source));
    rowEntries.forEach(([, row], rowIndex) => {
      row.forEach((state, columnIndex) => {
        nodes.push({
          ...state,
          machineId: machine.id,
          terminal: state.kind === "state" && !outgoing.has(state.id),
          x: region.x + REGION_PADDING + columnIndex * (NODE_WIDTH + COLUMN_GAP),
          y: region.y + REGION_TOP + rowIndex * (NODE_HEIGHT + ROW_GAP),
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        });
      });
    });
    const nodeById = new Map(nodes.filter((node) => node.machineId === machine.id).map((node) => [node.id, node]));
    for (const transition of machine.transitions) {
      const source = nodeById.get(transition.source);
      const target = nodeById.get(transition.target);
      if (source === undefined || target === undefined) continue;
      const points = routeEdge(source, target);
      const middle = points[Math.floor(points.length / 2)] ?? points[0] ?? { x: 0, y: 0 };
      edges.push({ ...transition, points, labelX: middle.x + 5, labelY: middle.y - 5 });
    }
    regionY += regionHeight + REGION_GAP;
    chartWidth = Math.max(chartWidth, region.x + region.width + 24);
  }
  return {
    width: chartWidth,
    height: regionY - REGION_GAP + 24,
    regions,
    nodes,
    edges,
  };
}
