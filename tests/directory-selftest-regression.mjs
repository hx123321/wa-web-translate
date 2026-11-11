import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  esbuild = createRequire(require.resolve("vite"))("esbuild");
const output = esbuild.buildSync({
  entryPoints: ["src/shared/directory-selftest.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
});
const module = { exports: {} };
new Function("module", "exports", output.outputFiles[0].text)(
  module,
  module.exports,
);
const { testHistoryDirectory, directoryTestMessage } = module.exports;
const missing = () => Object.assign(Error(), { name: "NotFoundError" });
function fixture(fail) {
  const state = { fail, created: [], removed: [], writes: 0 };
  class Dir {
    constructor(name = "root", depth = 0) {
      this.name = name;
      this.depth = depth;
      this.dirs = new Map();
      this.files = new Map();
    }
    async queryPermission() {
      return fail === "permission" ? "denied" : "granted";
    }
    async isSameEntry(other) {
      return this === other;
    }
    async *entries() {
      yield* this.dirs;
      yield* this.files;
    }
    async getDirectoryHandle(name, opts) {
      if (this.dirs.has(name)) return this.dirs.get(name);
      if (!opts?.create) throw missing();
      if (fail === "nested" && this.depth === 2) throw Error("PRIVATE_PATH");
      const dir = new Dir(name, this.depth + 1);
      this.dirs.set(name, dir);
      state.created.push(name);
      return dir;
    }
    async getFileHandle(name, opts) {
      if (this.files.has(name)) return this.files.get(name);
      if (!opts?.create) throw missing();
      let text = "";
      const f = {
        isSameEntry: async (other) => other === f,
        getFile: async () => ({
          size: text.length,
          text: async () => (fail === "read" && text ? "wrong" : text),
        }),
        createWritable: async () => ({
          write: async (t) => {
            state.writes++;
            if (fail === "write") throw Error("SECRET");
            text = t;
          },
          close: async () => {},
          abort: async () => {},
        }),
      };
      this.files.set(name, f);
      state.created.push(name);
      return f;
    }
    async removeEntry(name, opts) {
      assert(!opts?.recursive);
      if (fail === "cleanup") throw Error("PRIVATE");
      if (this.dirs.has(name)) {
        const d = this.dirs.get(name);
        if (d.dirs.size || d.files.size) throw Error("not empty");
        this.dirs.delete(name);
      } else this.files.delete(name);
      state.removed.push(name);
    }
  }
  return { root: new Dir(), state };
}
for (const [fail, stage] of [
  ["permission", "permission"],
  ["nested", "nested_open"],
  ["write", "write"],
  ["read", "read"],
  ["cleanup", "cleanup"],
]) {
  const f = fixture(fail),
    r = await testHistoryDirectory(f.root, async () => true);
  assert.equal(r.stage, stage);
  assert.notEqual(r.status, "ok");
  assert(!JSON.stringify(r).includes("PRIVATE"));
  assert(!directoryTestMessage(r).includes("SECRET"));
  if (fail !== "cleanup") assert.equal(f.state.removed.length, 0);
}
const f = fixture();
f.root.files.set("user-file", {});
const r = await testHistoryDirectory(f.root, async () => true);
assert.equal(r.status, "ok");
assert.equal(r.residue, false);
assert(f.root.files.has("user-file"));
assert.equal(f.root.dirs.size, 0);
assert.deepEqual(
  f.state.created.slice(1).map((x) => x.length),
  [10, 43, 43, 43],
);
const conflict = fixture();
let checks = 0;
const stopped = await testHistoryDirectory(
  conflict.root,
  async () => ++checks < 4,
);
assert.equal(stopped.status, "conflict");
assert.equal(conflict.state.writes, 0);
assert.equal(conflict.state.removed.length, 0);
console.log(
  "PASS Directory explicit self-test synthetic permission, equal-length path, write/read/cleanup failures, stale location and unrelated-file preservation",
);

assert.equal(f.state.created[0].length, 55);
assert.equal(
  f.state.created.map((n) => n.length).reduce((a, b) => a + b, 0) + 4,
  198,
);
const collision = fixture();
collision.root.getDirectoryHandle = async () => new Object();
assert.equal(
  (await testHistoryDirectory(collision.root, async () => true)).status,
  "conflict",
);
assert.equal(collision.state.writes, 0);
const replaced = fixture();
replaced.root.isSameEntry = async () => false;
// A changed owned child identity must prevent cleanup.
const oldGet = replaced.root.getDirectoryHandle.bind(replaced.root);
replaced.root.getDirectoryHandle = async (...args) => {
  const d = await oldGet(...args);
  d.isSameEntry = async () => false;
  return d;
};
const replacedResult = await testHistoryDirectory(
  replaced.root,
  async () => true,
);
assert.equal(replacedResult.stage, "cleanup");
assert.equal(replacedResult.status, "conflict");
assert.equal(replaced.state.removed.length, 0);
