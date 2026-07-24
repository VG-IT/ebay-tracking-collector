import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "dist-release");

const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const version = String(manifest.version || "").trim();

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid manifest version: "${version}" (expected x.y.z)`);
  process.exit(1);
}

/** Extension files to ship (no build step — source is the package). */
const INCLUDE = [
  "manifest.json",
  "background.js",
  "popup.html",
  "popup.js",
  "popup.css",
  "content",
  "lib",
  "icons",
];

fs.mkdirSync(outDir, { recursive: true });

const zipName = `ebay-tracking-collector-${version}.zip`;
const zipPath = path.join(outDir, zipName);
const latestPath = path.join(outDir, "latest.json");

if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

const stageDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "ebay-tracking-pack-"),
);

try {
  for (const name of INCLUDE) {
    const src = path.join(root, name);
    if (!fs.existsSync(src)) {
      console.error(`Missing required path: ${name}`);
      process.exit(1);
    }
    fs.cpSync(src, path.join(stageDir, name), { recursive: true });
  }

  if (process.platform === "win32") {
    const ps = `
      $ErrorActionPreference = 'Stop'
      Compress-Archive -Path '${stageDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force
    `;
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", ps],
      { stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
  } else {
    const result = spawnSync("zip", ["-r", zipPath, "."], {
      cwd: stageDir,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error("zip failed. Install `zip` or run on Windows.");
      process.exit(result.status ?? 1);
    }
  }
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}

const latest = {
  version,
  zip_name: zipName,
  released_at: new Date().toISOString(),
  notes: "",
};

fs.writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);

const tag = `v${version}`;
console.log(`\nPacked ${zipName}`);
console.log(`Also wrote ${path.relative(root, latestPath)}`);
console.log(`\nPublish with:`);
console.log(
  `  gh release create ${tag} "${path.relative(root, zipPath)}" "${path.relative(root, latestPath)}" --title "${tag}" --generate-notes`,
);
console.log(`\nOr push a tag to trigger CI:`);
console.log(`  git tag ${tag} && git push origin ${tag}`);
