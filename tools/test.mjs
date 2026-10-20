import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = resolve(root, "../../modera/modera-app");
execFileSync(
  process.execPath,
  [
    join(host, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    join(root, "vitest.config.mjs"),
    ...process.argv.slice(2),
  ],
  { cwd: host, stdio: "inherit", windowsHide: true },
);
