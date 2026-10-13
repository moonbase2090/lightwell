import { readFile } from "node:fs/promises";

export function loadConfig(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export class Widget {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export type Options = { readonly debug: boolean };
