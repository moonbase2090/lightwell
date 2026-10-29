import { compoundLayoutEnabled } from "../feature-flags.js";
import type { CompoundLayoutInput, CompoundLayoutResult } from "./compound-layout.js";
import type { CompoundLayoutWorkerRequest, CompoundLayoutWorkerResponse } from "./compound-layout-worker.js";

const LAYOUT_TIMEOUT_MS = 2_000;
const RETRY_BLOCK_LIMIT = 400;

export interface CompoundLayoutClient {
  layout(input: CompoundLayoutInput): Promise<CompoundLayoutResult>;
  dispose(): void;
}

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

export function createCompoundLayoutFeature(flag: string | undefined): CompoundLayoutFeature {
  if (!compoundLayoutEnabled(flag)) return { kind: "disabled" };
  return { kind: "enabled", client: createCompoundLayoutClient() };
}

function createCompoundLayoutClient(): CompoundLayoutClient {
  let generation = 0;
  let worker = newLayoutWorker();
  let pending: PendingRequest | null = null;

  const replaceWorker = () => {
    worker.terminate();
    worker = newLayoutWorker();
  };

  const run = (input: CompoundLayoutInput): Promise<CompoundLayoutResult> => {
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
        reject(new Error("Compound layout exceeded its two-second limit."));
      }, LAYOUT_TIMEOUT_MS);
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
      try {
        return await run(input);
      } catch (error: unknown) {
        if (!(error instanceof Error) || !error.message.includes("two-second limit")) throw error;
        return run({
          ...input,
          limits: {
            maxBlocks: Math.min(input.limits.maxBlocks, RETRY_BLOCK_LIMIT),
            maxEdges: Math.min(input.limits.maxEdges, RETRY_BLOCK_LIMIT * 2),
          },
        });
      }
    },
    dispose() {
      if (pending !== null) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Compound layout client was disposed."));
        pending = null;
      }
      worker.terminate();
    },
  };
}

function newLayoutWorker(): Worker {
  return new Worker(new URL("./compound-layout-worker.ts", import.meta.url), { type: "module" });
}
