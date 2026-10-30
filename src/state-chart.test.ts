import assert from "node:assert/strict";
import test from "node:test";
import {
  detectStateChart,
  layoutStateChart,
  type ChartPoint,
  type StateChartEdge,
  type StateChartNode,
} from "./state-chart.js";

function segments(points: readonly ChartPoint[]): readonly (readonly [ChartPoint, ChartPoint])[] {
  return points.slice(1).flatMap((point, index) => {
    const previous = points[index];
    return previous === undefined ? [] : [[previous, point] as const];
  });
}

function segmentCrossesNodeInterior(start: ChartPoint, end: ChartPoint, node: StateChartNode): boolean {
  if (start.x === end.x) {
    return start.x > node.x && start.x < node.x + node.width
      && Math.max(start.y, end.y) > node.y
      && Math.min(start.y, end.y) < node.y + node.height;
  }
  return start.y > node.y && start.y < node.y + node.height
    && Math.max(start.x, end.x) > node.x
    && Math.min(start.x, end.x) < node.x + node.width;
}

function assertEdgesAvoidOtherNodes(edges: readonly StateChartEdge[], nodes: readonly StateChartNode[]): void {
  for (const edge of edges) {
    for (const node of nodes) {
      if (node.id === edge.source || node.id === edge.target) continue;
      for (const [start, end] of segments(edge.points)) {
        assert.equal(segmentCrossesNodeInterior(start, end, node), false, `${edge.id} crosses ${node.id}`);
      }
    }
  }
}

function collinearOverlap(
  left: readonly [ChartPoint, ChartPoint],
  right: readonly [ChartPoint, ChartPoint],
): number {
  const [leftStart, leftEnd] = left;
  const [rightStart, rightEnd] = right;
  if (leftStart.x === leftEnd.x && rightStart.x === rightEnd.x && leftStart.x === rightStart.x) {
    return Math.min(Math.max(leftStart.y, leftEnd.y), Math.max(rightStart.y, rightEnd.y))
      - Math.max(Math.min(leftStart.y, leftEnd.y), Math.min(rightStart.y, rightEnd.y));
  }
  if (leftStart.y === leftEnd.y && rightStart.y === rightEnd.y && leftStart.y === rightStart.y) {
    return Math.min(Math.max(leftStart.x, leftEnd.x), Math.max(rightStart.x, rightEnd.x))
      - Math.max(Math.min(leftStart.x, leftEnd.x), Math.min(rightStart.x, rightEnd.x));
  }
  return 0;
}

function assertEdgesDoNotShareSegments(edges: readonly StateChartEdge[]): void {
  for (const [index, edge] of edges.entries()) {
    for (const other of edges.slice(index + 1)) {
      for (const segment of segments(edge.points)) {
        for (const otherSegment of segments(other.points)) {
          assert.ok(collinearOverlap(segment, otherSegment) <= 0, `${edge.id} shares a path with ${other.id}`);
        }
      }
    }
  }
}

function segmentsCross(
  left: readonly [ChartPoint, ChartPoint],
  right: readonly [ChartPoint, ChartPoint],
): boolean {
  const [leftStart, leftEnd] = left;
  const [rightStart, rightEnd] = right;
  const leftVertical = leftStart.x === leftEnd.x;
  const rightVertical = rightStart.x === rightEnd.x;
  if (leftVertical === rightVertical) return false;
  const vertical = leftVertical ? left : right;
  const horizontal = leftVertical ? right : left;
  const x = vertical[0].x;
  const y = horizontal[0].y;
  return x > Math.min(horizontal[0].x, horizontal[1].x)
    && x < Math.max(horizontal[0].x, horizontal[1].x)
    && y > Math.min(vertical[0].y, vertical[1].y)
    && y < Math.max(vertical[0].y, vertical[1].y);
}

function assertEdgesDoNotCross(edges: readonly StateChartEdge[]): void {
  for (const [index, edge] of edges.entries()) {
    for (const other of edges.slice(index + 1)) {
      for (const segment of segments(edge.points)) {
        for (const otherSegment of segments(other.points)) {
          assert.equal(segmentsCross(segment, otherSegment), false, `${edge.id} crosses ${other.id}`);
        }
      }
    }
  }
}

test("detects Rust enum transitions and the explicit default state", () => {
  const chart = detectStateChart({
    path: "src/job.rs",
    content: `
enum Noise { A, B }

enum JobState {
    #[default]
    Queued,
    Running { attempt: u8 },
    Complete,
}

fn advance(state: JobState) -> JobState {
    match state {
        JobState::Queued => JobState::Running { attempt: 1 },
        JobState::Running { .. } => JobState::Complete,
        JobState::Complete => JobState::Complete,
    }
}
`,
  });

  assert.equal(chart.machines.length, 1);
  const machine = chart.machines[0];
  assert.equal(machine?.label, "JobState");
  assert.deepEqual(machine?.states.map((state) => [state.label, state.initial]), [
    ["Queued", true],
    ["Running", false],
    ["Complete", false],
  ]);
  assert.deepEqual(machine?.transitions.map((transition) => [transition.source, transition.target]), [
    ["JobState::Queued", "JobState::Running"],
    ["JobState::Running", "JobState::Complete"],
    ["JobState::Complete", "JobState::Complete"],
  ]);
  assert.equal(machine?.transitions[0]?.line, 12);
});

test("detects TypeScript enum switch returns and assignments", () => {
  const chart = detectStateChart({
    path: "src/session.ts",
    content: `enum Session {
  SignedOut = "signed-out",
  SigningIn = "signing-in",
  Ready = "ready",
}

function next(state: Session): Session {
  switch (state) {
    case Session.SignedOut:
      return Session.SigningIn;
    case Session.SigningIn:
      state = Session.Ready;
      return state;
    default:
      return Session.SignedOut;
  }
}`,
  });

  assert.deepEqual(chart.machines[0]?.transitions.map((transition) => [transition.source, transition.target]), [
    ["Session::SignedOut", "Session::SigningIn"],
    ["Session::SigningIn", "Session::Ready"],
  ]);
  assert.ok(chart.machines[0]?.states.every((state) => !state.initial));
});

test("ignores unsupported files, declarations without evidence, strings, comments, and cross-enum targets", () => {
  assert.deepEqual(detectStateChart({ path: "README.md", content: "enum State { A, B }" }).machines, []);

  const chart = detectStateChart({
    path: "src/ignored.ts",
    content: `
enum Idle { A, B }
enum First { A, B }
enum Second { C, D }
type StringState = "open" | "closed";
// switch (x) { case First.A: return First.B; }
const example = "case First.A: return First.B";
switch (value) {
  case First.A:
    return Second.C;
}
`,
  });

  assert.deepEqual(chart.machines, []);
});

test("handles Rust block comments, string escapes, guarded arms, and payload variants", () => {
  const chart = detectStateChart({
    path: "src/player.rs",
    content: `enum Player {
  Idle,
  Playing(String),
  Paused,
}
/* match value { Player::Idle => Player::Paused } */
fn next(value: Player, resume: bool) -> Player {
  let label = "Player::Idle \\"ignored\\"";
  match value {
    Player::Playing(_) if resume => Player::Playing(label),
    Player::Playing(_) => Player::Paused,
    Player::Idle => Player::Playing(label),
    Player::Paused => Player::Idle,
  }
}`,
  });

  assert.deepEqual(chart.machines[0]?.transitions.map((transition) => transition.label), [
    "if resume",
    "transition",
    "transition",
    "transition",
  ]);
});

test("keeps a Rust lifetime from masking the rest of the file and ignores enum mentions that are not transitions", () => {
  const chart = detectStateChart({
    path: "src/lifetime.rs",
    content: `enum Mode { A, B, C }
fn next<'a>(value: Mode, label: &str) -> Mode {
  match value {
    Mode::A => { let compared = Mode::C; Mode::B },
    Mode::B => { if label.is_empty() { return Mode::C; } Mode::B },
    Mode::C => value,
  }
}`,
  });

  assert.deepEqual(chart.machines[0]?.transitions.map((transition) => [transition.source, transition.target]), [
    ["Mode::A", "Mode::B"],
    ["Mode::B", "Mode::C"],
    ["Mode::B", "Mode::B"],
  ]);
});

test("ignores TypeScript enum comparisons inside a switch case", () => {
  const chart = detectStateChart({
    path: "src/mode.ts",
    content: `enum Mode { A, B, C }
switch (state) {
  case Mode.A:
    if (other === Mode.B) console.log(other);
    return Mode.C;
}`,
  });

  assert.deepEqual(chart.machines[0]?.transitions.map((transition) => transition.target), ["Mode::C"]);
});

test("detects assignment to the matched Rust state and merges duplicate transitions", () => {
  const chart = detectStateChart({
    path: "src/mode.rs",
    content: `enum Mode { A, B }
fn next(mut value: Mode) -> Mode {
  match value {
    Mode::A => { value = Mode::B; value },
    Mode::A => { value = Mode::B; value },
    Mode::B => Mode::B,
  }
}`,
  });

  assert.deepEqual(chart.machines[0]?.transitions.map((transition) => [transition.source, transition.target]), [
    ["Mode::A", "Mode::B"],
    ["Mode::B", "Mode::B"],
  ]);
});

test("bounds large charts with explicit summary states and transition counts", () => {
  const variants = Array.from({ length: 125 }, (_, index) => `S${index}`);
  const arms = Array.from({ length: 124 }, (_, index) => `Big::S${index} => Big::S${index + 1},`);
  const chart = detectStateChart({
    path: "src/big.rs",
    content: `enum Big { ${variants.join(",")} }\nfn next(value: Big) -> Big { match value { ${arms.join("\n")} Big::S124 => Big::S124, } }`,
  });

  const machine = chart.machines[0];
  assert.equal(machine?.states.length, 121);
  assert.equal(machine?.states.at(-1)?.kind, "summary");
  assert.equal(machine?.states.at(-1)?.label, "+5 states");
  assert.equal(machine?.transitions.length, 119);
  assert.equal(chart.omittedStates, 5);
  assert.equal(chart.omittedTransitions, 6);
});

test("caps transition evidence independently of the state cap", () => {
  const arms = Array.from({ length: 245 }, (_, index) => `Mode::A if event_${index} => Mode::B,`);
  const chart = detectStateChart({
    path: "src/events.rs",
    content: `enum Mode { A, B }\nfn next(value: Mode) -> Mode { match value { ${arms.join("\n")} } }`,
  });

  assert.equal(chart.machines[0]?.transitions.length, 240);
  assert.equal(chart.omittedStates, 0);
  assert.equal(chart.omittedTransitions, 5);
});

test("omitted counts include machines after a budget is exhausted", () => {
  const arms = Array.from({ length: 245 }, (_, index) => `Mode::A if event_${index} => Mode::B,`);
  const chart = detectStateChart({
    path: "src/events.rs",
    content: `enum Mode { A, B }
fn next(value: Mode) -> Mode { match value { ${arms.join("\n")} } }
enum Later { X, Y }
fn later(value: Later) -> Later { match value { Later::X => Later::Y, } }`,
  });

  assert.equal(chart.machines.length, 1);
  assert.equal(chart.omittedStates, 2);
  assert.equal(chart.omittedTransitions, 6);
});

test("ranks an acyclic chain into rows and keeps a strongly connected cycle together", () => {
  const chain = layoutStateChart(detectStateChart({
    path: "src/chain.rs",
    content: `enum Chain { A, B, C }
fn next(value: Chain) -> Chain { match value {
  Chain::A => Chain::B,
  Chain::B => Chain::C,
} }`,
  }));
  const chainY = new Map(chain.nodes.map((node) => [node.label, node.y]));
  assert.ok((chainY.get("A") ?? 0) < (chainY.get("B") ?? 0));
  assert.ok((chainY.get("B") ?? 0) < (chainY.get("C") ?? 0));

  const cycle = layoutStateChart(detectStateChart({
    path: "src/cycle.rs",
    content: `enum Cycle { A, B, C }
fn next(value: Cycle) -> Cycle { match value {
  Cycle::A => Cycle::B,
  Cycle::B => Cycle::C,
  Cycle::C => Cycle::A,
} }`,
  }));
  assert.deepEqual(new Set(cycle.nodes.map((node) => node.y)).size, 1);
});

test("routes shortcuts and cycle back-edges around non-endpoint states", () => {
  const shortcut = layoutStateChart(detectStateChart({
    path: "src/shortcut.rs",
    content: `enum Shortcut { A, B, C }
fn next(value: Shortcut) -> Shortcut { match value {
  Shortcut::A => { if direct { return Shortcut::C; } Shortcut::B },
  Shortcut::B => Shortcut::C,
} }`,
  }));
  assertEdgesAvoidOtherNodes(shortcut.edges, shortcut.nodes);
  assertEdgesDoNotShareSegments(shortcut.edges);
  assertEdgesDoNotCross(shortcut.edges);

  const cycle = layoutStateChart(detectStateChart({
    path: "src/cycle.rs",
    content: `enum Cycle { A, B, C }
fn next(value: Cycle) -> Cycle { match value {
  Cycle::A => Cycle::B,
  Cycle::B => Cycle::C,
  Cycle::C => Cycle::A,
} }`,
  }));
  assertEdgesAvoidOtherNodes(cycle.edges, cycle.nodes);
  assertEdgesDoNotShareSegments(cycle.edges);
  assertEdgesDoNotCross(cycle.edges);
});

test("routes two-way transitions on distinct paths", () => {
  const layout = layoutStateChart(detectStateChart({
    path: "src/two-way.rs",
    content: `enum Pair { A, B }
fn next(value: Pair) -> Pair { match value {
  Pair::A => Pair::B,
  Pair::B => Pair::A,
} }`,
  }));

  assertEdgesDoNotShareSegments(layout.edges);
  assertEdgesDoNotCross(layout.edges);
  const first = layout.edges[0];
  const second = layout.edges[1];
  assert.ok(first !== undefined && second !== undefined);
  assert.ok(Math.abs(first.labelX - second.labelX) >= 40 || Math.abs(first.labelY - second.labelY) >= 12);
});

test("routes a self-loop outside its state card", () => {
  const layout = layoutStateChart(detectStateChart({
    path: "src/self-loop.rs",
    content: `enum Loop { A }
fn next(value: Loop) -> Loop { match value { Loop::A => Loop::A, } }`,
  }));
  const node = layout.nodes[0];
  const edge = layout.edges[0];
  assert.ok(node !== undefined && edge !== undefined);
  assert.ok(edge.points.length >= 5);
  assert.ok(edge.points.some((point) => point.x > node.x + node.width || point.y < node.y));
});

test("lays out cycles and disconnected states deterministically without overlaps", () => {
  const chart = detectStateChart({
    path: "src/cycle.rs",
    content: `enum Cycle { A, B, C, D }
fn next(value: Cycle) -> Cycle { match value {
  Cycle::A => Cycle::B,
  Cycle::B => Cycle::A,
  Cycle::C => Cycle::D,
  Cycle::D => Cycle::D,
} }`,
  });
  const first = layoutStateChart(chart);
  const second = layoutStateChart(chart);

  assert.deepEqual(first, second);
  assert.ok(first.width > 0);
  assert.ok(first.height > 0);
  for (const [index, node] of first.nodes.entries()) {
    for (const other of first.nodes.slice(index + 1)) {
      const separated = node.x + node.width <= other.x
        || other.x + other.width <= node.x
        || node.y + node.height <= other.y
        || other.y + other.height <= node.y;
      assert.equal(separated, true, `${node.id} overlaps ${other.id}`);
    }
  }
  for (const edge of first.edges) {
    assert.ok(edge.points.length >= 2);
    for (let index = 1; index < edge.points.length; index += 1) {
      const previous = edge.points[index - 1];
      const current = edge.points[index];
      assert.ok(previous !== undefined && current !== undefined);
      assert.equal(previous.x === current.x || previous.y === current.y, true, `${edge.id} contains a diagonal segment`);
    }
  }
});

test("returns an empty bounded layout when no state machine is detected", () => {
  assert.deepEqual(layoutStateChart(detectStateChart({ path: "src/plain.ts", content: "export const value = 1;" })), {
    width: 0,
    height: 0,
    regions: [],
    nodes: [],
    edges: [],
  });
});
