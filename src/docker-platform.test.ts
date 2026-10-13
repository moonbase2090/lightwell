import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { execScript, readRepoText } from "./test-tools.js";

const script = fileURLToPath(new URL("../scripts/ci/docker-platform.sh", import.meta.url));

function platform(args: readonly string[], input?: string): string {
  return execScript(script, args, { encoding: "utf8", input });
}

test("an arm64 binary on an x86_64 host asks Docker for linux/arm64", () => {
  assert.equal(platform(["--machine", "aarch64", "--host", "x86_64"]), "linux/arm64\n");
});

test("a matching host does not set a Docker platform", () => {
  assert.equal(platform(["--machine", "aarch64", "--host", "aarch64"]), "");
  assert.equal(platform(["--machine", "aarch64", "--host", "arm64"]), "");
  assert.equal(platform(["--machine", "i386:x86-64", "--host", "x86_64"]), "");
});

test("an x86_64 binary on an arm64 host asks Docker for linux/amd64", () => {
  assert.equal(platform(["--machine", "i386:x86-64", "--host", "aarch64"]), "linux/amd64\n");
  assert.equal(platform(["--machine", "x86-64", "--host", "arm64"]), "linux/amd64\n");
});

test("readelf machine lines choose the container platform", () => {
  const arm = "ELF Header:\n  Class:                             ELF64\n  Machine:                           AArch64\n";
  const intel = "ELF Header:\n  Class:                             ELF64\n  Machine:                           Advanced Micro Devices X86-64\n";
  const numbered = "ELF Header:\n  Machine:                           <unknown>: 0xb7\n";
  assert.equal(platform(["--readelf-stdin", "--host", "x86_64"], arm), "linux/arm64\n");
  assert.equal(platform(["--readelf-stdin", "--host", "aarch64"], arm), "");
  assert.equal(platform(["--readelf-stdin", "--host", "aarch64"], intel), "linux/amd64\n");
  assert.equal(platform(["--readelf-stdin", "--host", "x86_64"], intel), "");
  assert.equal(platform(["--readelf-stdin", "--host", "x86_64"], numbered), "linux/arm64\n");
});

test("objdump architecture lines are parsed before the platform decision", () => {
  const arm = "target/lightwell:     file format elf64-littleaarch64\narchitecture: aarch64, flags 0x00000112:\nstart address 0x0000000000020000\n";
  const intel = "target/lightwell:     file format elf64-x86-64\narchitecture: i386:x86-64, flags 0x00000150:\nstart address 0x0000000000400000\n";
  const unknownArm = "target/lightwell:     file format elf64-littleaarch64\narchitecture: UNKNOWN!\n";
  assert.equal(platform(["--objdump-stdin", "--host", "x86_64"], arm), "linux/arm64\n");
  assert.equal(platform(["--objdump-stdin", "--host", "aarch64"], intel), "linux/amd64\n");
  assert.equal(platform(["--objdump-stdin", "--host", "x86_64"], intel), "");
  assert.equal(platform(["--objdump-stdin", "--host", "x86_64"], unknownArm), "linux/arm64\n");
  assert.equal(platform(["--objdump-stdin", "--host", "aarch64"], unknownArm), "");
});

test("an unknown architecture is refused", () => {
  assert.throws(
    () => platform(["--machine", "riscv64", "--host", "x86_64"]),
    (error: NodeJS.ErrnoException & { status?: number; stderr?: Buffer }) => error.status === 1,
  );
});

test("the Amazon Linux smoke runs a foreign binary with the selected platform", () => {
  const smoke = readRepoText(new URL("../scripts/ci/smoke-linux-al2023.sh", import.meta.url));
  assert.match(smoke, /readelf -h "\$binary"/);
  assert.match(smoke, /--readelf-stdin --host "\$\(uname -m\)"/);
  assert.match(smoke, /docker_cmd\+=\(--platform "\$platform"\)/);
  assert.match(
    smoke,
    /env -i PATH="\$container_path" HOME=\/tmp \/release\/lightwell extract/,
  );
  const workflow = readRepoText(new URL("../.github/workflows/rookrunner.yml", import.meta.url));
  const start = workflow.indexOf("\n  linux-cli-aarch64:\n");
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [a-z]/);
  const job = next === -1 ? rest : rest.slice(0, next);
  assert.match(job, /qemu-user-static/);
  assert.match(job, /smoke-linux-al2023\.sh target\/aarch64-unknown-linux-gnu\/release/);
  assert.doesNotMatch(job, /ubuntu-22\.04-arm/);
});
