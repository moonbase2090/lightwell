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

test("a timeout replaces the worker and retries once with reduced limits", async (context) => {
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

test("a second timeout rejects instead of starting another layout attempt", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const factory = workerFactory();
  const client = createCompoundLayoutClient(factory.createWorker);
  const pending = client.layout(INPUT);

  context.mock.timers.tick(2_000);
  await flushPromises();
  context.mock.timers.tick(2_000);

  await assert.rejects(pending, /exceeded its two-second limit/);
  assert.equal(factory.workers.flatMap((worker) => worker.requests).length, 2);
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
