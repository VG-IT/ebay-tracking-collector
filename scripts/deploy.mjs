#!/usr/bin/env node
/**
 * Deploy / update the unpacked extension from the latest GitHub Release.
 *
 * Downloads the release zip and extracts into a fixed install folder
 * (keep the same path so Chrome retains extension id / storage).
 *
 * Usage:
 *   node scripts/deploy.mjs
 *   node scripts/deploy.mjs --dir "C:\\extensions\\ebay-tracking-collector"
 *   node scripts/deploy.mjs --dry-run
 *
 * Install dir (first match):
 *   1. --dir <path>
 *   2. env EBAY_TRACKING_COLLECTOR_HOME
 *   3. repo file .deploy-dir (one line)
 *   4. default: %LOCALAPPDATA%\\ebay-tracking-collector
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const REPO = "VG-IT/ebay-tracking-collector";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dirFlagIndex = args.indexOf("--dir");
const dirFlag = dirFlagIndex >= 0 ? args[dirFlagIndex + 1] : null;

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function findGh() {
  const which = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(which, ["gh"], { encoding: "utf8", shell: true });
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

function defaultInstallDir() {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "ebay-tracking-collector",
    );
  }
  return path.join(os.homedir(), ".local", "share", "ebay-tracking-collector");
}

function resolveInstallDir() {
  if (dirFlag) return path.resolve(dirFlag);
  if (process.env.EBAY_TRACKING_COLLECTOR_HOME) {
    return path.resolve(process.env.EBAY_TRACKING_COLLECTOR_HOME);
  }
  const marker = path.join(root, ".deploy-dir");
  if (fs.existsSync(marker)) {
    const line = fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)[0];
    if (line) return path.resolve(line);
  }
  return defaultInstallDir();
}

function runCapture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    fail(
      `${command} ${commandArgs.join(" ")} failed\n${result.stderr || result.stdout}`,
    );
  }
  return (result.stdout || "").trim();
}

function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    const ps = `
      $ErrorActionPreference = 'Stop'
      Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force
    `;
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", ps],
      { stdio: "inherit" },
    );
    if (result.status !== 0) fail("Expand-Archive failed");
    return;
  }
  const result = spawnSync("unzip", ["-o", zipPath, "-d", destDir], {
    stdio: "inherit",
  });
  if (result.status !== 0) fail("unzip failed (install unzip)");
}

function clearExtensionFiles(destDir) {
  if (!fs.existsSync(destDir)) return;
  for (const name of fs.readdirSync(destDir)) {
    if (name === ".deploy-readme.txt") continue;
    fs.rmSync(path.join(destDir, name), { recursive: true, force: true });
  }
}

const gh = findGh();
if (!gh) fail("GitHub CLI (gh) not found. Install: https://cli.github.com/");

const auth = spawnSync(gh, ["auth", "status"], { encoding: "utf8" });
if (auth.status !== 0) fail("Not logged into gh. Run: gh auth login");

const installDir = resolveInstallDir();
const releaseJson = runCapture(gh, [
  "release",
  "view",
  "--repo",
  REPO,
  "--json",
  "tagName,assets,url",
]);
const release = JSON.parse(releaseJson);
const tag = release.tagName;
const version = String(tag || "").replace(/^v/i, "");
const assets = release.assets || [];
const zipAsset =
  assets.find((a) => a.name === `ebay-tracking-collector-${version}.zip`) ||
  assets.find((a) => (a.name || "").endsWith(".zip"));

if (!zipAsset?.name) {
  fail(`No zip asset on ${tag}. Open ${release.url}`);
}

const localManifest = path.join(installDir, "manifest.json");
let installedVersion = null;
if (fs.existsSync(localManifest)) {
  try {
    installedVersion = JSON.parse(
      fs.readFileSync(localManifest, "utf8"),
    ).version;
  } catch {
    /* ignore */
  }
}

console.log(`\n→ Deploy ${tag}`);
console.log(`  release:   ${release.url}`);
console.log(`  zip:       ${zipAsset.name}`);
console.log(`  install:   ${installDir}`);
console.log(
  `  installed: ${installedVersion ? `v${installedVersion}` : "(none)"}`,
);

if (installedVersion && installedVersion === version) {
  console.log(`\n✔ Already on v${version}. Nothing to do.`);
  process.exit(0);
}

if (dryRun) {
  console.log("\nDry run only — no download/extract.");
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebay-tracking-deploy-"));
const zipPath = path.join(tmpDir, zipAsset.name);
const extractDir = path.join(tmpDir, "extract");

try {
  console.log("\n→ Download");
  const dl = spawnSync(
    gh,
    [
      "release",
      "download",
      tag,
      "--repo",
      REPO,
      "--pattern",
      zipAsset.name,
      "--dir",
      tmpDir,
      "--clobber",
    ],
    { stdio: "inherit" },
  );
  if (dl.status !== 0) fail("Download failed");
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 100) {
    fail(`Downloaded zip looks empty: ${zipPath}`);
  }

  console.log("\n→ Extract");
  fs.mkdirSync(extractDir, { recursive: true });
  unzip(zipPath, extractDir);

  if (!fs.existsSync(path.join(extractDir, "manifest.json"))) {
    fail("Zip root must contain manifest.json");
  }

  console.log("\n→ Install");
  fs.mkdirSync(installDir, { recursive: true });
  clearExtensionFiles(installDir);
  for (const name of fs.readdirSync(extractDir)) {
    fs.cpSync(path.join(extractDir, name), path.join(installDir, name), {
      recursive: true,
    });
  }

  fs.writeFileSync(
    path.join(installDir, ".deploy-readme.txt"),
    [
      `Deployed ${tag} at ${new Date().toISOString()}`,
      `Source: ${release.url}`,
      "",
      "First install:",
      "  chrome://extensions → Developer mode → Load unpacked → this folder",
      "",
      "After each deploy:",
      "  chrome://extensions → click Reload on this extension",
      "",
    ].join("\n"),
  );

  const marker = path.join(root, ".deploy-dir");
  if (
    !fs.existsSync(marker) &&
    !process.env.EBAY_TRACKING_COLLECTOR_HOME &&
    !dirFlag
  ) {
    fs.writeFileSync(marker, `${installDir}\n`);
    console.log(`  wrote ${path.relative(root, marker)} → ${installDir}`);
  }

  console.log(`\n✔ Deployed v${version} → ${installDir}`);
  console.log(
    "  Next: chrome://extensions → Reload (or Load unpacked on first install)",
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
