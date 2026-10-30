/// <reference lib="webworker" />

import ElkConstructor from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import {
  createCompoundLayoutEngine,
  type CompoundLayoutInput,
  type CompoundLayoutResult,
} from "./compound-layout.js";

export interface CompoundLayoutWorkerRequest {
  readonly kind: "layout";
  readonly generation: number;
  readonly input: CompoundLayoutInput;
}

export type CompoundLayoutWorkerResponse = {
  readonly kind: "layout-complete";
  readonly generation: number;
  readonly result: CompoundLayoutResult;
} | {
  readonly kind: "layout-failed";
  readonly generation: number;
  readonly message: string;
};

const elk = new ElkConstructor({ workerFactory: () => new ElkWorker() });
const engine = createCompoundLayoutEngine(elk);

self.addEventListener("message", (event: MessageEvent<CompoundLayoutWorkerRequest>) => {
  if (event.data.kind !== "layout") return;
  const { generation, input } = event.data;
  void engine.layout(input).then(
    (result) => {
      const response: CompoundLayoutWorkerResponse = { kind: "layout-complete", generation, result };
      self.postMessage(response);
    },
    (error: unknown) => {
      const response: CompoundLayoutWorkerResponse = {
        kind: "layout-failed",
        generation,
        message: error instanceof Error ? error.message : "Compound layout failed.",
      };
      self.postMessage(response);
    },
  );
});
