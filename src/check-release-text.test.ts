import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const script = fileURLToPath(new URL("../scripts/check-release-text.sh", import.meta.url));
const probe = "RELEASETEXTPROBETOKEN";

function writeZip(path: string, name: string, payload: string) {
  execFileSync(
    "python3",
    [
      "-c",
      [
        "import sys, zipfile",
        "path, name, payload = sys.argv[1:]",
        "with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:",
        "    archive.writestr(name, payload)",
      ].join("\n"),
      path,
      name,
      payload,
    ],
    { stdio: "ignore" },
  );
}

function scan(artifact: string): { status: number; stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "lightwell-release-text-"));
  writeFileSync(join(root, "README.md"), "Public release notes.\n");
  try {
    const stdout = execFileSync(script, ["--root", root, "--artifact", artifact], {
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_DENYLIST: probe,
        RELEASE_DENYLIST_FILE: "/dev/null",
      },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { status?: number; stdout?: string; stderr?: string };
    return {
      status: failed.status ?? 1,
      stdout: String(failed.stdout ?? ""),
      stderr: String(failed.stderr ?? ""),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a denylisted string inside a compressed zip member fails the scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "lightwell-release-zip-"));
  const archive = join(dir, "lightwell.zip");
  const clean = join(dir, "clean.zip");
  try {
    writeZip(archive, "payload.txt", `${probe}\n`);
    writeZip(clean, "payload.txt", "public note\n");
    const hidden = execFileSync("strings", ["-a", "-n", "6", archive], { encoding: "utf8" });
    assert.equal(hidden.includes(probe), false, "the compressed member should hide the planted text from strings");

    const failed = scan(archive);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout, /payload\.txt:/);
    assert.equal(failed.stdout.includes(probe), false);
    assert.equal(failed.stderr.includes(probe), false);

    const passed = scan(clean);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(passed.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SHA256SUMS is scanned as text", () => {
  const dir = mkdtempSync(join(tmpdir(), "lightwell-release-sums-"));
  const clean = mkdtempSync(join(tmpdir(), "lightwell-release-sums-clean-"));
  try {
    writeFileSync(join(dir, "SHA256SUMS"), `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  lightwell.zip\n${probe}\n`);
    writeFileSync(join(clean, "SHA256SUMS"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  lightwell.zip\n");

    const failed = scan(dir);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout, /SHA256SUMS:/);
    assert.equal(failed.stdout.includes(probe), false);
    assert.equal(failed.stderr.includes(probe), false);

    const passed = scan(clean);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(passed.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }
});

test("an unsupported compressed artifact fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "lightwell-release-gz-"));
  const archive = join(dir, "lightwell.gz");
  const broken = join(dir, "broken.zip");
  try {
    writeFileSync(archive, gzipSync(Buffer.from("public note\n")));
    writeFileSync(broken, Buffer.from("not a zip"));

    const compressed = scan(archive);
    assert.notEqual(compressed.status, 0);
    assert.match(compressed.stderr, /unsupported artifact format/);

    const invalid = scan(broken);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /could not unpack zip/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
