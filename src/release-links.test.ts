import assert from "node:assert/strict";
import { test } from "node:test";
import { readRepoText } from "./test-tools.js";

const packageText = readRepoText(new URL("../package.json", import.meta.url));
const readme = readRepoText(new URL("../README.md", import.meta.url));
const ignoreText = readRepoText(new URL("../.lycheeignore", import.meta.url)).trim();

test("release download links match the package version and published asset names", () => {
  const versionMatch = packageText.match(/^  "version": "([0-9]+\.[0-9]+\.[0-9]+)",$/m);
  assert.ok(versionMatch);
  const version = versionMatch[1];
  const releaseLinks = [
    ...readme.matchAll(
      /https:\/\/github\.com\/moonbase2090\/lightwell\/releases\/download\/v([^/]+)\/Lightwell_([^\s)]+)/g,
    ),
  ];

  assert.equal(releaseLinks.length, 8);
  const suffixes = releaseLinks.map(([, tagVersion, asset]) => {
    assert.equal(tagVersion, version);
    assert.ok(asset.startsWith(`${version}_`));
    return asset.slice(version.length + 1);
  });
  assert.deepEqual(suffixes.sort(), [
    "aarch64.dmg",
    "amd64.AppImage",
    "amd64.deb",
    "linux_aarch64.tar.gz",
    "linux_x86_64.tar.gz",
    "universal.dmg",
    "x64.msi",
    "x86_64.rpm",
  ]);

  const pendingAsset = new RegExp(ignoreText);
  for (const [url] of releaseLinks) assert.match(url, pendingAsset);
  assert.doesNotMatch(
    `https://github.com/moonbase2090/lightwell/releases/download/v${version}/Lightwell_${version}_typo.dmg`,
    pendingAsset,
  );
});

test("release packaging versions match the package version", () => {
  const version: unknown = JSON.parse(packageText).version;
  assert.equal(typeof version, "string");
  const cargo = readRepoText(new URL("../Cargo.toml", import.meta.url));
  assert.equal(cargo.match(/^version = "([^"]+)"$/m)?.[1], version);
  const tauri: { version?: unknown } = JSON.parse(readRepoText(new URL("../crates/lightwell-app/tauri.conf.json", import.meta.url)));
  assert.equal(tauri.version, version);
  const lock: { version?: unknown; packages: Record<string, { version?: unknown }> } = JSON.parse(readRepoText(new URL("../package-lock.json", import.meta.url)));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""]?.version, version);
  const pkgbuild = readRepoText(new URL("../packaging/arch/PKGBUILD", import.meta.url));
  assert.equal(pkgbuild.match(/^pkgver=(.+)$/m)?.[1], version);
  const cargoLock = readRepoText(new URL("../Cargo.lock", import.meta.url));
  for (const name of ["lightwell-app", "lightwell-cli", "lightwell-core"]) {
    const entry = cargoLock.split("[[package]]").find((block) => block.includes(`name = "${name}"\n`));
    assert.equal(entry?.match(/^version = "([^"]+)"$/m)?.[1], version, `${name} lock version`);
  }
});
