import assert from "node:assert/strict";
import test from "node:test";
import { detectStateChart, layoutStateChart } from "./state-chart.js";

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
      return state;
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

test("keeps Rust lifetimes and ignores enum mentions that are not transitions", () => {
  const chart = detectStateChart({
    path: "src/lifetime.rs",
    content: `enum Mode { A, B, C }
fn next<'a>(value: Mode, label: &'a str) -> Mode {
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
    Mode::A => Mode::B,
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
