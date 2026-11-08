import assert from "node:assert/strict";
import test from "node:test";
import type { CompoundLayoutInput, CompoundLayoutResult } from "./viewer/compound-layout.js";
import {
  createCompoundLayoutClient,
  type CompoundLayoutWorker,
} from "./viewer/compound-layout-client.js";
import type {
  CompoundLayoutWorkerRequest,
  CompoundLayoutWorkerResponse,
} from "./viewer/compound-layout-worker.js";

const INPUT: CompoundLayoutInput = {
  rootId: "workspace:test",
  blocks: [{
    id: "workspace:test",
    parentId: null,
    type: "workspace",
    children: [],
  }],
  connections: [],
  limits: { maxBlocks: 800, maxEdges: 1_600 },
};

const RESULT: CompoundLayoutResult = {
  nodes: [],
  edges: [],
  stats: {
    inputBlocks: 1,
    renderedBlocks: 1,
    omittedBlocks: 0,
    inputEdges: 0,
    renderedEdges: 0,
    omittedEdges: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheEntries: 0,
  },
};

class FakeErrorEvent extends Event implements ErrorEvent {
  readonly colno = 0;
  readonly error: unknown = undefined;
  readonly filename = "";
  readonly lineno = 0;
  readonly message = "worker failed";
}

class FakeWorker implements CompoundLayoutWorker {
  onmessage: ((event: MessageEvent<CompoundLayoutWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: CompoundLayoutWorkerRequest[] = [];
  terminated = false;

  postMessage(request: CompoundLayoutWorkerRequest): void {
    this.requests.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: CompoundLayoutWorkerResponse): void {
    this.onmessage?.(new MessageEvent("message", { data: response }));
  }

  fail(): void {
    this.onerror?.(new FakeErrorEvent("error"));
  }
}

function workerFactory() {
  const workers: FakeWorker[] = [];
  return {
    workers,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function captureErrors(promise: Promise<unknown>): string[] {
  const errors: string[] = [];
  void promise.catch((error: unknown) => {
    errors.push(error instanceof Error ? error.message : "unknown error");
  });
  return errors;
}

test("a timeout replaces the worker and retries with reduced limits", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const pending = client.layout(INPUT);

  context.mock.timers.tick(2_000);
  await flushPromises();

  assert.equal(factory.workers.length, 2);
  assert.equal(factory.workers[0]?.terminated, true);
  assert.deepEqual(factory.workers[1]?.requests[0]?.input.limits, {
    maxBlocks: 400,
    maxEdges: 800,
  });
  factory.workers[1]?.respond({ kind: "layout-complete", generation: 2, result: RESULT });
  await pending;
});

test("repeated timeouts step down to a layout without dependency edges and still resolve", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const pending = client.layout(INPUT);

  context.mock.timers.tick(2_000);
  await flushPromises();
  context.mock.timers.tick(2_000);
  await flushPromises();
  context.mock.timers.tick(1_500);
  await flushPromises();

  const limits = factory.workers.flatMap((worker) => worker.requests).map((request) => request.input.limits);
  assert.deepEqual(limits, [
    { maxBlocks: 800, maxEdges: 1_600 },
    { maxBlocks: 400, maxEdges: 800 },
    { maxBlocks: 150, maxEdges: 300 },
    { maxBlocks: 60, maxEdges: 0 },
  ]);
  factory.workers[3]?.respond({ kind: "layout-complete", generation: 4, result: RESULT });
  assert.equal(await pending, RESULT);
});

test("fallback limits never exceed the limits the caller asked for", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const pending = client.layout({ ...INPUT, limits: { maxBlocks: 100, maxEdges: 120 } });

  context.mock.timers.tick(2_000);
  await flushPromises();
  context.mock.timers.tick(2_000);
  await flushPromises();

  const limits = factory.workers.flatMap((worker) => worker.requests).map((request) => request.input.limits);
  assert.deepEqual(limits, [
    { maxBlocks: 100, maxEdges: 120 },
    { maxBlocks: 100, maxEdges: 120 },
    { maxBlocks: 100, maxEdges: 120 },
  ]);
  factory.workers[2]?.respond({ kind: "layout-complete", generation: 3, result: RESULT });
  await pending;
});

test("a timeout of the final edge-free layout rejects instead of retrying forever", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const pending = client.layout(INPUT);
  const errors = captureErrors(pending);

  for (const waitMs of [2_000, 2_000, 1_500, 5_000]) {
    context.mock.timers.tick(waitMs);
    await flushPromises();
  }

  await assert.rejects(pending, /exceeded its time limit/);
  assert.deepEqual(errors, ["Compound layout exceeded its time limit."]);
  assert.equal(factory.workers.flatMap((worker) => worker.requests).length, 4);
});

test("a newer request rejects the older request and replaces its worker", async () => {
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const older = client.layout(INPUT);
  const olderErrors = captureErrors(older);
  const newer = client.layout(INPUT);

  await flushPromises();
  assert.deepEqual(olderErrors, ["Compound layout was replaced by a newer request."]);
  assert.equal(factory.workers.length, 2);
  assert.equal(factory.workers[0]?.terminated, true);
  factory.workers[1]?.respond({ kind: "layout-complete", generation: 2, result: RESULT });
  await newer;
});

test("a stale generation cannot settle the current request", async () => {
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const pending = client.layout(INPUT);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });

  factory.workers[0]?.respond({ kind: "layout-complete", generation: 0, result: RESULT });
  await flushPromises();
  assert.equal(settled, false);

  factory.workers[0]?.respond({ kind: "layout-complete", generation: 1, result: RESULT });
  assert.equal(await pending, RESULT);
});

test("a worker error replaces the failed worker and rejects the request", async () => {
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const pending = client.layout(INPUT);
  const errors = captureErrors(pending);

  factory.workers[0]?.fail();

  await flushPromises();
  assert.deepEqual(errors, ["Compound layout worker failed."]);
  assert.equal(factory.workers.length, 2);
  assert.equal(factory.workers[0]?.terminated, true);
});

test("dispose rejects pending work and prevents later worker creation", async () => {
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const pending = client.layout(INPUT);
  const pendingErrors = captureErrors(pending);

  client.dispose();

  await flushPromises();
  assert.deepEqual(pendingErrors, ["Compound layout client was disposed."]);
  assert.equal(factory.workers[0]?.terminated, true);
  const outcomes = captureErrors(client.layout(INPUT));
  await flushPromises();
  assert.deepEqual(outcomes, ["Compound layout client was disposed."]);
  assert.equal(factory.workers.length, 1);
  assert.equal(factory.workers[0]?.requests.length, 1);
});

test("a completed layout is reused after visiting another scope", async () => {
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const rootResult: CompoundLayoutResult = { ...RESULT, nodes: [{ kind: "block", id: "workspace:test", parentId: null, blockType: "workspace", hiddenDescendants: 0, bounds: { x: 0, y: 0, width: 222, height: 94 } }] };
  const first = client.layout(INPUT);
  factory.workers[0]?.respond({ kind: "layout-complete", generation: 1, result: rootResult });
  await first;
  const child = client.layout({ ...INPUT, rootId: "child" });
  factory.workers[0]?.respond({ kind: "layout-complete", generation: 2, result: RESULT });
  await child;
  const back = client.layout(structuredClone(INPUT));
  const errors = captureErrors(back);
  try {
    assert.equal(factory.workers[0]?.requests.length, 2);
    assert.deepEqual((await back).nodes, [{ kind: "block", id: "workspace:test", parentId: null, blockType: "workspace", hiddenDescendants: 0, bounds: { x: 0, y: 0, width: 222, height: 94 } }]);
    assert.deepEqual(errors, []);
  } finally { client.dispose(); }
});

test("a fallback result is cached under the original request limits", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const first = client.layout(INPUT);
  context.mock.timers.tick(2_000);
  await flushPromises();
  factory.workers[1]?.respond({ kind: "layout-complete", generation: 2, result: { ...RESULT, stats: { ...RESULT.stats, renderedBlocks: 60 } } });
  await first;
  const back = client.layout(INPUT);
  captureErrors(back);
  try {
    assert.equal(factory.workers[1]?.requests.length, 1);
    assert.equal((await back).stats.renderedBlocks, 60);
  } finally { client.dispose(); }
});

test("a cache hit supersedes pending work, including a queued timeout retry", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const first = client.layout(INPUT);
  factory.workers[0]?.respond({ kind: "layout-complete", generation: 1, result: { ...RESULT, stats: { ...RESULT.stats, renderedBlocks: 42 } } });
  await first;
  const child = client.layout({ ...INPUT, rootId: "child" });
  const errors = captureErrors(child);
  context.mock.timers.tick(2_000);
  const back = client.layout(INPUT);
  assert.equal((await back).stats.renderedBlocks, 42);
  await assert.rejects(child, /replaced by a newer request/);
  assert.deepEqual(errors, ["Compound layout was replaced by a newer request."]);
  assert.equal(factory.workers.length, 2);
  assert.deepEqual(factory.workers[1]?.requests, []);
  client.dispose();
  await assert.rejects(client.layout(INPUT), /disposed/);
});

test("a cached breadcrumb return cancels an in-flight scope layout", async () => {
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const first = client.layout(INPUT);
  factory.workers[0]?.respond({ kind: "layout-complete", generation: 1, result: { ...RESULT, stats: { ...RESULT.stats, renderedBlocks: 42 } } });
  await first;
  const child = client.layout({ ...INPUT, rootId: "child" });
  captureErrors(child);
  assert.equal((await client.layout(INPUT)).stats.renderedBlocks, 42);
  await assert.rejects(child, /replaced by a newer request/);
  assert.equal(factory.workers[0]?.terminated, true);
  assert.deepEqual(factory.workers[1]?.requests, []);
  client.dispose();
});

test("changed graph content and limits do not reuse a stale layout", async () => {
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const inputs = [
    INPUT,
    { ...INPUT, limits: { maxBlocks: 60, maxEdges: 0 } },
    { ...INPUT, blocks: INPUT.blocks.map((block) => ({ ...block, children: ["new-module"] })) },
    { ...INPUT, connections: [{ id: "dep", source: "workspace:test", target: "new-module" }] },
  ];
  for (const [index, input] of inputs.entries()) {
    const pending = client.layout(input);
    factory.workers[0]?.respond({ kind: "layout-complete", generation: index + 1, result: { ...RESULT, stats: { ...RESULT.stats, renderedBlocks: index + 10 } } });
    assert.equal((await pending).stats.renderedBlocks, index + 10);
  }
  assert.equal(factory.workers[0]?.requests.length, 4);
  assert.equal((await client.layout(INPUT)).stats.renderedBlocks, 10);
  client.dispose();
});

test("completed layouts are bounded and revisiting a layout refreshes its retention", async () => {
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  for (let index = 0; index < 8; index += 1) {
    const pending = client.layout({ ...INPUT, rootId: `root:${index}` });
    factory.workers[0]?.respond({ kind: "layout-complete", generation: index + 1, result: { ...RESULT, stats: { ...RESULT.stats, renderedBlocks: index + 10 } } });
    await pending;
  }
  assert.equal((await client.layout({ ...INPUT, rootId: "root:0" })).stats.renderedBlocks, 10);
  const ninth = client.layout({ ...INPUT, rootId: "root:8" });
  factory.workers[0]?.respond({ kind: "layout-complete", generation: 9, result: RESULT });
  await ninth;
  assert.equal((await client.layout({ ...INPUT, rootId: "root:0" })).stats.renderedBlocks, 10);
  const evicted = client.layout({ ...INPUT, rootId: "root:1" });
  assert.equal(factory.workers[0]?.requests.length, 10);
  factory.workers[0]?.respond({ kind: "layout-complete", generation: 10, result: { ...RESULT, stats: { ...RESULT.stats, renderedBlocks: 11 } } });
  assert.equal((await evicted).stats.renderedBlocks, 11);
  client.dispose();
});
