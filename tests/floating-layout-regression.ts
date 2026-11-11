import assert from "node:assert/strict";
import { clampPosition } from "../src/page/ui/floating-layout";
export function runFloatingLayoutTests(): number {
  assert.deepEqual(clampPosition({ x: -99, y: 900 }, 80, 40, 400, 300), {
    x: 12,
    y: 248,
  });
  assert.deepEqual(clampPosition({ x: 350, y: 250 }, 80, 40, 200, 150), {
    x: 108,
    y: 98,
  });
  console.log(
    "PASS Floating entry clamps to 12px viewport margins and smaller viewport",
  );
  return 1;
}
