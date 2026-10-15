import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { execScript, pythonCommand } from "./test-tools.js";

const script = fileURLToPath(new URL("../scripts/check-release-text.sh", import.meta.url));
const probe = "RELEASETEXTPROBETOKEN";

function writeZip(path: string, name: string, payload: string) {
  execFileSync(
    pythonCommand(),
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
    const stdout = execScript(script, ["--root", root, "--artifact", artifact], {
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
    const hidden = readFileSync(archive);
    assert.equal(
      hidden.includes(Buffer.from(probe)),
      false,
      "the compressed member should hide the planted text from a raw byte scan",
    );

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

test("compressed and unsupported artifacts are unpacked or fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "lightwell-release-gz-"));
  const clean = join(dir, "notes.gz");
  const dirty = join(dir, "dirty.gz");
  const sevenZip = join(dir, "bundle.bin");
  const broken = join(dir, "broken.zip");
  try {
    writeFileSync(clean, gzipSync(Buffer.from("public note\n")));
    writeFileSync(dirty, gzipSync(Buffer.from(`note ${probe}\n`)));
    writeFileSync(sevenZip, Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.from("payload")]));
    writeFileSync(broken, Buffer.from("not a zip"));

    assert.equal(scan(clean).status, 0);
    assert.notEqual(scan(dirty).status, 0);

    const unsupported = scan(sevenZip);
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /unsupported artifact format/);

    const invalid = scan(broken);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /could not unpack zip/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a zip renamed to another extension is still unpacked and scanned", () => {
  const dir = mkdtempSync(join(tmpdir(), "lightwell-release-renamed-"));
  const renamed = join(dir, "renamed.bin");
  try {
    writeZip(renamed, "notes.txt", `note ${probe}\n`);
    assert.notEqual(scan(renamed).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeDeb(dir: string, name: string, controlText: string, dataText: string): string {
  const stage = mkdtempSync(join(dir, "stage-"));
  execFileSync(
    pythonCommand(),
    [
      "-c",
      [
        "import io, sys, tarfile, gzip, os",
        "stage, control_text, data_text = sys.argv[1:]",
        "def tgz(path, member, text):",
        "    raw = io.BytesIO()",
        "    with tarfile.open(fileobj=raw, mode='w') as tar:",
        "        data = text.encode()",
        "        info = tarfile.TarInfo(member); info.size = len(data)",
        "        tar.addfile(info, io.BytesIO(data))",
        "    open(path, 'wb').write(gzip.compress(raw.getvalue()))",
        "tgz(os.path.join(stage, 'control.tar.gz'), './control', control_text)",
        "tgz(os.path.join(stage, 'data.tar.gz'), './usr/share/doc/lightwell/README', data_text)",
        "open(os.path.join(stage, 'debian-binary'), 'w').write('2.0\\n')",
        "out = bytearray(b'!<arch>\\n')",
        "for member in ('debian-binary', 'control.tar.gz', 'data.tar.gz'):",
        "    data = open(os.path.join(stage, member), 'rb').read()",
        "    header = f'{member:<16}{0:<12}{0:<6}{0:<6}{100644:<8}{len(data):<10}`\\n'",
        "    out += header.encode() + data + (b'\\n' if len(data) % 2 else b'')",
        "open(os.path.join(stage, 'package.deb'), 'wb').write(bytes(out))",
      ].join("\n"),
      stage,
      controlText,
      dataText,
    ],
    { stdio: "ignore" },
  );
  const deb = join(dir, name);
  renameSync(join(stage, "package.deb"), deb);
  return deb;
}

test("a denylisted string in deb control metadata fails the scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "lightwell-release-deb-"));
  try {
    const clean = writeDeb(dir, "clean.deb", "Package: lightwell\n", "Public readme\n");
    const dirty = writeDeb(dir, "dirty.deb", `Package: lightwell\nMaintainer: ${probe}\n`, "Public readme\n");
    assert.equal(scan(clean).status, 0);
    assert.notEqual(scan(dirty).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function py(code: string[], ...args: string[]) {
  execFileSync(pythonCommand(), ["-c", code.join("\n"), ...args], { stdio: "ignore" });
}

test("denylisted text in zip entry names and comments fails the scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "lightwell-release-zipmeta-"));
  const make = (name: string, entry: string, archiveComment: string, entryComment: string) => {
    const path = join(dir, name);
    py(
      [
        "import sys, zipfile",
        "path, entry, ac, ec = sys.argv[1:]",
        "with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as z:",
        "    info = zipfile.ZipInfo(entry)",
        "    info.comment = ec.encode()",
        "    z.writestr(info, 'public payload')",
        "    z.comment = ac.encode()",
      ],
      path,
      entry,
      archiveComment,
      entryComment,
    );
    return path;
  };
  try {
    assert.equal(scan(make("clean.zip", "notes.txt", "public", "public")).status, 0);
    assert.notEqual(scan(make("name.zip", `${probe}.txt`, "public", "public")).status, 0);
    assert.notEqual(scan(make("comment.zip", "notes.txt", `note ${probe}`, "public")).status, 0);
    assert.notEqual(scan(make("entry.zip", "notes.txt", "public", `note ${probe}`)).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("denylisted text in an archived symlink target fails the scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "lightwell-release-link-"));
  const make = (name: string, target: string) => {
    const path = join(dir, name);
    py(
      [
        "import io, sys, tarfile",
        "path, target = sys.argv[1:]",
        "with tarfile.open(path, 'w:gz') as t:",
        "    data = b'public payload'",
        "    f = tarfile.TarInfo('notes.txt'); f.size = len(data); t.addfile(f, io.BytesIO(data))",
        "    l = tarfile.TarInfo('link'); l.type = tarfile.SYMTYPE; l.linkname = target; t.addfile(l)",
      ],
      path,
      target,
    );
    return path;
  };
  try {
    assert.equal(scan(make("clean.bin", "notes.txt")).status, 0);
    const failed = scan(make("dirty.bin", `/opt/${probe}/notes`));
    assert.notEqual(failed.status, 0);
    assert.equal(failed.stderr.includes("could not unpack tar"), false, failed.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dmg release artifact is scanned without treating the extension as unsupported", () => {
  const dir = mkdtempSync(join(tmpdir(), "lightwell-release-dmg-"));
  const clean = join(dir, "Lightwell_0.1.7_aarch64.dmg");
  const dirty = join(dir, "dirty.dmg");
  try {
    writeFileSync(clean, "public release payload\n");
    writeFileSync(dirty, `note ${probe}\n`);

    const passed = scan(clean);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(passed.stderr.includes("unsupported artifact format"), false);

    const failed = scan(dirty);
    assert.notEqual(failed.status, 0);
    assert.equal(failed.stderr.includes("unsupported artifact format"), false);
    assert.equal(failed.stdout.includes(probe), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host name patterns ignore icon names and XDG paths but catch real hosts", () => {
  const dir = mkdtempSync(join(tmpdir(), "lightwell-release-hosts-"));
  const write = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  try {
    assert.equal(scan(write("icons.bin", "insert-link-symbolic preferences-desktop-font-symbolic\n")).status, 0);
    assert.equal(scan(write("xdg.bin", "config.local/bin.local/share.cache\n")).status, 0);
    assert.notEqual(scan(write("win.bin", "seen on DESKTOP-AB12CD9 today\n")).status, 0);
    assert.notEqual(scan(write("mdns.bin", "ping studio.local now\n")).status, 0);
    assert.notEqual(scan(write("runner.bin", "/home/runner/.cargo/registry/src/lib.rs\n")).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
