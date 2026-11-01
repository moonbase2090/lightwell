import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { readRepoText } from "./test-tools.js";

const text = readRepoText(new URL("../.github/workflows/ci.yml", import.meta.url));

function jobBlock(id: string): string {
  const start = text.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, id);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n  [a-z]/);
  return next === -1 ? rest : rest.slice(0, next);
}

test("the CLI is smoke-tested on Amazon Linux 2023", () => {
  const block = jobBlock("linux-cli-al2023");
  assert.match(block, /scripts\/ci\/build-linux-cli\.sh/);
  assert.match(block, /scripts\/ci\/smoke-linux-al2023\.sh/);
});

test("the packaged desktop binary gets a GUI smoke, not an Amazon Linux run", () => {
  const block = jobBlock("tauri-linux-artifact");
  assert.match(block, /runs-on: ubuntu-22\.04\n/);
  assert.match(block, /libwebkit2gtk-4\.1-dev/);
  assert.match(block, /scripts\/ci\/check-deb-glibc\.sh/);
  assert.match(block, /scripts\/ci\/smoke-deb-gui\.sh/);
  assert.equal(block.includes("smoke-deb-al2023"), false);
  assert.equal(existsSync(new URL("../scripts/ci/smoke-deb-al2023.sh", import.meta.url)), false);
  assert.equal(existsSync(new URL("../scripts/ci/smoke-deb-gui.sh", import.meta.url)), true);
});

test("windows runs the npm suite and the cargo tests", () => {
  const block = jobBlock("windows-check");
  assert.match(block, /runs-on: windows-latest\n/);
  assert.equal(block.includes("setup-mingw"), false);
  assert.match(block, /npm test\n/);
  assert.match(block, /cargo test -p lightwell-core --lib --locked/);
  assert.match(block, /cargo test -p lightwell-cli --locked/);
  assert.match(block, /cargo test -p lightwell-app --bin lightwell --locked/);
  assert.match(block, /python scripts\/release\/windows_msi_test.py/);
});

test("the signed macOS job skips Dependabot without disabling configured signing", () => {
  const block = jobBlock("tauri-macos-signed");
  assert.match(
    block,
    /if: \$\{\{ vars\.LIGHTWELL_MACOS_SIGNING == 'true' && github\.actor != 'dependabot\[bot\]' \}\}/,
  );
  assert.match(block, /scripts\/ci\/sign-macos-app\.sh --credential-smoke/);
});

test("CI upload-artifact steps are pinned to a full commit SHA", () => {
  assert.equal(text.includes("actions/upload-artifact@v"), false);
  const uploads = [...text.matchAll(/^ {2,}(?:- )?uses: (actions\/upload-artifact@\S+)/gm)].map(
    (match) => match[1],
  );
  assert.ok(uploads.length > 0);
  for (const action of uploads) {
    assert.match(action, /^actions\/upload-artifact@[0-9a-f]{40}$/, `Pin ${action} to a commit`);
  }
  assert.match(
    text,
    /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\.6\.2/,
  );
});
