#!/usr/bin/env node
/**
 * One-click publish: bump version (optional) → pack → commit → tag →
 * GitHub Release with zip assets.
 *
 * Usage:
 *   node scripts/publish-release.mjs              # bump patch, then publish
 *   node scripts/publish-release.mjs --minor
 *   node scripts/publish-release.mjs --major
 *   node scripts/publish-release.mjs --version 1.2.0
 *   node scripts/publish-release.mjs --current     # publish current manifest version
 *   node scripts/publish-release.mjs --dry-run
 *   node scripts/publish-release.mjs --skip-commit # only pack + gh release (no git commit)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "manifest.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipCommit = args.includes("--skip-commit");
const useCurrent = args.includes("--current");
const bumpMinor = args.includes("--minor");
const bumpMajor = args.includes("--major");
const versionFlag = args.includes("--version")
  ? args[args.indexOf("--version") + 1]
  : null;

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function executable(command) {
  if (process.platform === "win32" && command === "npm") return "npm.cmd";
  return command;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(executable(command), commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${commandArgs.join(" ")} failed`);
  return result;
}

function runCapture(command, commandArgs) {
  const result = spawnSync(executable(command), commandArgs, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `${command} ${commandArgs.join(" ")} failed\n${result.stderr || result.stdout}`,
    );
  }
  return (result.stdout || "").trim();
}

function findGh() {
  const which = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(which, ["gh"], {
    encoding: "utf8",
    shell: true,
  });
  if (found.status === 0 && found.stdout.trim()) {
    return found.stdout.trim().split(/\r?\n/)[0];
  }
  const candidates = [
    path.join(process.env.ProgramFiles || "", "GitHub CLI", "gh.exe"),
    path.join(
      process.env.LOCALAPPDATA || "",
      "Programs",
      "GitHub CLI",
      "gh.exe",
    ),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function bumpVersion(version, kind) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    fail(`Invalid version: ${version}`);
  }
  let [major, minor, patch] = parts;
  if (kind === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function writeManifestVersion(version) {
  const manifest = readManifest();
  manifest.version = version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const gh = findGh();
if (!gh) fail("GitHub CLI (gh) not found. Install: https://cli.github.com/");

const auth = spawnSync(gh, ["auth", "status"], {
  cwd: root,
  encoding: "utf8",
  shell: false,
});
if (auth.status !== 0) {
  fail("Not logged into gh. Run: gh auth login");
}

const branch = runCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main" && branch !== "master") {
  console.warn(`⚠ Current branch is "${branch}" (expected main/master).`);
}

const dirty = runCapture("git", ["status", "--porcelain"]);
if (dirty && !skipCommit && !dryRun) {
  fail(
    "Working tree is not clean. Commit/stash changes first, or use --skip-commit.",
  );
}

const currentVersion = String(readManifest().version || "").trim();
if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) {
  fail(`Invalid manifest version: "${currentVersion}"`);
}

let nextVersion = currentVersion;
if (versionFlag) {
  if (!/^\d+\.\d+\.\d+$/.test(versionFlag)) {
    fail(`--version must be x.y.z, got: ${versionFlag}`);
  }
  nextVersion = versionFlag;
} else if (!useCurrent) {
  const kind = bumpMajor ? "major" : bumpMinor ? "minor" : "patch";
  nextVersion = bumpVersion(currentVersion, kind);
}

const tag = `v${nextVersion}`;
const zipRel = path.join(
  "dist-release",
  `ebay-tracking-collector-${nextVersion}.zip`,
);
const latestRel = path.join("dist-release", "latest.json");

console.log(`\n→ Publish ${tag}`);
console.log(`  current: ${currentVersion}`);
console.log(
  `  target:  ${nextVersion}${useCurrent || versionFlag ? "" : " (bumped)"}`,
);
if (dryRun) {
  console.log("\nDry run only — no changes made.");
  process.exit(0);
}

if (nextVersion !== currentVersion) {
  writeManifestVersion(nextVersion);
  console.log(`\n✓ Bumped manifest.json → ${nextVersion}`);
}

console.log("\n→ Pack");
run("npm", ["run", "release"]);

if (!fs.existsSync(path.join(root, zipRel))) {
  fail(`Missing ${zipRel}`);
}

const existing = spawnSync(gh, ["release", "view", tag], {
  cwd: root,
  encoding: "utf8",
  shell: false,
});
if (existing.status === 0) {
  fail(`Release ${tag} already exists. Bump version or delete the release first.`);
}

if (!skipCommit) {
  console.log("\n→ Commit & push");
  if (nextVersion !== currentVersion) {
    run("git", ["add", "manifest.json"]);
    run("git", ["commit", "-m", `Release ${tag}`]);
    run("git", ["push", "origin", "HEAD"]);
  } else {
    console.log("  (version unchanged — publishing current HEAD)");
    run("git", ["push", "origin", "HEAD"]);
  }
}

const localTag = spawnSync("git", ["rev-parse", tag], {
  cwd: root,
  encoding: "utf8",
  shell: false,
});
if (localTag.status === 0) {
  fail(`Local tag ${tag} already exists.`);
}

const remoteTag = spawnSync("git", ["ls-remote", "--tags", "origin", tag], {
  cwd: root,
  encoding: "utf8",
  shell: false,
});
if ((remoteTag.stdout || "").includes(tag)) {
  fail(`Remote tag ${tag} already exists.`);
}

const headSha = runCapture("git", ["rev-parse", "HEAD"]);

console.log("\n→ Create GitHub Release (tag + zip)");
run(gh, [
  "release",
  "create",
  tag,
  zipRel,
  latestRel,
  "--title",
  tag,
  "--target",
  headSha,
  "--generate-notes",
]);

run("git", ["fetch", "origin", "tag", tag]);

const url = runCapture(gh, [
  "release",
  "view",
  tag,
  "--json",
  "url",
  "-q",
  ".url",
]);
console.log(`\n✔ Published ${tag}`);
console.log(`  ${url}`);
console.log(`  asset: ${zipRel}`);
