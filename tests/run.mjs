import "./directory-selftest-regression.mjs";
import "./status-layout-regression.mjs";
import { createRequire } from "node:module";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const dir = await mkdtemp(join(tmpdir(), "wa-tests-"));
try {
  await build({
    entryPoints: ["tests/regression.ts"],
    outfile: join(dir, "tests.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
  await import(pathToFileURL(join(dir, "tests.mjs")));
} finally {
  await rm(dir, { recursive: true, force: true });
}
