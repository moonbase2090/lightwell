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
