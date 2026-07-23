import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { arch } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "native", "MediaWorker");
const triple =
  arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";

execFileSync(
  "/usr/bin/swift",
  ["build", "-c", "release", "--package-path", packagePath],
  { stdio: "inherit" },
);

const binPath = execFileSync(
  "/usr/bin/swift",
  [
    "build",
    "-c",
    "release",
    "--package-path",
    packagePath,
    "--show-bin-path",
  ],
  { encoding: "utf8" },
).trim();

const destination = resolve(
  root,
  "src-tauri",
  "binaries",
  `media-worker-${triple}`,
);

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(resolve(binPath, "MediaWorker"), destination);
chmodSync(destination, 0o755);
console.log(`Media worker ready: ${destination}`);
