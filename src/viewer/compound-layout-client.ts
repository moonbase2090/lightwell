import { compoundLayoutEnabled } from "../feature-flags.js";
import type { CompoundLayoutInput, CompoundLayoutResult } from "./compound-layout.js";
import type { CompoundLayoutWorkerRequest, CompoundLayoutWorkerResponse } from "./compound-layout-worker.js";

const LAYOUT_TIMEOUT_MS = 2_000;

/**
 * Smaller layouts to try, in order, when the previous attempt times out. Layout time grows with the
 * number of dependency edges, so the last tier drops them: the map always appears, with blocks only.
 */
const FALLBACK_TIERS: readonly { readonly maxBlocks: number; readonly maxEdges: number; readonly timeoutMs: number }[] = [
  { maxBlocks: 400, maxEdges: 800, timeoutMs: 2_000 },
  { maxBlocks: 150, maxEdges: 300, timeoutMs: 1_500 },
  { maxBlocks: 60, maxEdges: 0, timeoutMs: 5_000 },
];

export interface CompoundLayoutClient {
  layout(input: CompoundLayoutInput): Promise<CompoundLayoutResult>;
  dispose(): void;
}

export interface CompoundLayoutWorker {
  onmessage: ((event: MessageEvent<CompoundLayoutWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: CompoundLayoutWorkerRequest): void;
  terminate(): void;
}

export type CompoundLayoutWorkerFactory = () => CompoundLayoutWorker;

export type CompoundLayoutFeature = {
  readonly kind: "disabled";
} | {
  readonly kind: "enabled";
  readonly client: CompoundLayoutClient;
};

interface PendingRequest {
  readonly generation: number;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class CompoundLayoutTimeoutError extends Error {
  constructor() {
    super("Compound layout exceeded its time limit.");
    this.name = "CompoundLayoutTimeoutError";
  }
}

export function createCompoundLayoutFeature(flag: string | undefined): CompoundLayoutFeature {
  if (!compoundLayoutEnabled(flag)) return { kind: "disabled" };
  return { kind: "enabled", client: createCompoundLayoutClient() };
}

export function createCompoundLayoutClient(
  createWorker: CompoundLayoutWorkerFactory = newLayoutWorker,
): CompoundLayoutClient {
  let generation = 0;
  let worker = createWorker();
  let pending: PendingRequest | null = null;
  let disposed = false;

  const replaceWorker = () => {
    worker.terminate();
    if (!disposed) worker = createWorker();
  };

  const run = (input: CompoundLayoutInput, timeoutMs: number): Promise<CompoundLayoutResult> => {
    if (disposed) return Promise.reject(new Error("Compound layout client was disposed."));
    generation += 1;
    const requestGeneration = generation;
    if (pending !== null) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Compound layout was replaced by a newer request."));
      pending = null;
      replaceWorker();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending?.generation !== requestGeneration) return;
        pending = null;
        replaceWorker();
        reject(new CompoundLayoutTimeoutError());
      }, timeoutMs);
      pending = { generation: requestGeneration, reject, timer };
      worker.onmessage = (event: MessageEvent<CompoundLayoutWorkerResponse>) => {
        if (event.data.generation !== requestGeneration || pending?.generation !== requestGeneration) return;
        clearTimeout(timer);
        pending = null;
        switch (event.data.kind) {
          case "layout-complete":
            resolve(event.data.result);
            break;
          case "layout-failed":
            reject(new Error(event.data.message));
            break;
          default: {
            const exhaustive: never = event.data;
            reject(new Error(`Unexpected compound layout response: ${String(exhaustive)}`));
          }
        }
      };
      worker.onerror = () => {
        if (pending?.generation !== requestGeneration) return;
        clearTimeout(timer);
        pending = null;
        replaceWorker();
        reject(new Error("Compound layout worker failed."));
      };
      const request: CompoundLayoutWorkerRequest = { kind: "layout", generation: requestGeneration, input };
      worker.postMessage(request);
    });
  };

  return {
    async layout(input) {
      let attemptInput = input;
      let timeoutMs = LAYOUT_TIMEOUT_MS;
      for (let tier = 0; ; tier += 1) {
        try {
          return await run(attemptInput, timeoutMs);
        } catch (error: unknown) {
          const next = FALLBACK_TIERS[tier];
          if (!(error instanceof CompoundLayoutTimeoutError) || next === undefined) throw error;
          attemptInput = {
            ...input,
            limits: {
              maxBlocks: Math.min(input.limits.maxBlocks, next.maxBlocks),
              maxEdges: Math.min(input.limits.maxEdges, next.maxEdges),
            },
          };
          timeoutMs = next.timeoutMs;
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pending !== null) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Compound layout client was disposed."));
        pending = null;
      }
      worker.terminate();
    },
  };
}

function newLayoutWorker(): CompoundLayoutWorker {
  return new Worker(new URL("./compound-layout-worker.ts", import.meta.url), { type: "module" });
}
