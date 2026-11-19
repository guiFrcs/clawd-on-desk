"use strict";

// Exercises src/gravity.js against a fake context (real time, a few seconds).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const initGravity = require("../src/gravity");
const { measureReleaseVelocity, getThrowVelocity, advanceThrow, getSpinTurnMs, getSpinRotation } = initGravity;
const { i18n, SUPPORTED_LANGS, createTranslator } = require("../src/i18n");

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1032 };
const BOTTOM_MARGIN = 10;
const PET = 200;
const FLOOR_Y = WORK_AREA.height - PET + BOTTOM_MARGIN;
const SIDE = Math.round(PET * 0.25);
const MIN_X = WORK_AREA.x - SIDE;
const MAX_X = WORK_AREA.x + WORK_AREA.width - PET + SIDE;

function makeCtx(y, x = 500) {
  let current = { x, y, width: PET, height: PET };
  const ctx = {
    win: { isDestroyed: () => false },
    dragLocked: false,
    miniTransitioning: false,
    miniMode: false,
    getMiniMode: () => ctx.miniMode,
    getPetWindowBounds: () => ({ ...current }),
    applyPetWindowBounds: (b) => {
      ctx.applied.push({ ...b, t: performance.now() });
      current = { ...b };
    },
    cursor: { x, y },
    moveTo: (nx, ny) => {
      current = { ...current, x: nx, y: ny };
      ctx.cursor = { x: nx, y: ny };
    },
    getEffectiveCurrentPixelSize: () => ({ width: PET, height: PET }),
    getNearestWorkArea: () => WORK_AREA,
    // Same shape as the real rest clamp: 25% side overhang, visible margin at the bottom.
    clampToScreenVisual: (cx, cy, w, h, opts) => {
      ctx.clampOptions = opts;
      const wa = opts.workArea;
      const side = Math.round(w * 0.25);
      return {
        x: Math.max(wa.x - side, Math.min(cx, wa.x + wa.width - w + side)),
        y: Math.max(wa.y, Math.min(cy, wa.y + wa.height - h + BOTTOM_MARGIN)),
      };
    },
    syncHitWin: () => { ctx.hitSyncs += 1; },
    repositionAnchoredSurfaces: () => {},
    releaseReconcileProtection: () => { ctx.releases += 1; },
    applied: [],
    rotations: [],
    rotationTimes: [],
    hitSyncs: 0,
    releases: 0,
  };
  return ctx;
}

function tempFloorFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-gravity-test-"));
  return path.join(dir, "gravity-floor.json");
}

function makeGravity(ctx, floorFile = tempFloorFile()) {
  return initGravity(ctx, {
    floorFile,
    getDisplayKey: () => "test-display",
    getCursorPoint: () => ctx.cursor,
    setRotation: (degrees) => {
      ctx.rotations.push(degrees);
      ctx.rotationTimes.push(performance.now());
    },
  });
}

function fallFrom(y, floorFile) {
  const ctx = makeCtx(y);
  const gravity = makeGravity(ctx, floorFile);
  return new Promise((resolve) => {
    const started = gravity.startFall((landed, info) => resolve({ started, landed, info, ctx }));
    if (!started) resolve({ started, ctx });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastY = (ctx) => ctx.applied[ctx.applied.length - 1].y;
const lastX = (ctx) => ctx.applied[ctx.applied.length - 1].x;

// Drags in real time: one (dx, dy) step every ~16 ms, like Clawd's drag-move events.
async function drag(ctx, gravity, dx, dy, steps = 6) {
  gravity.beginDrag();
  let { x, y } = ctx.getPetWindowBounds();
  for (let i = 0; i < steps; i++) {
    x += dx;
    y += dy;
    ctx.moveTo(x, y);
    gravity.recordDragSample();
    await wait(16);
  }
}

function releaseAndLand(gravity) {
  return new Promise((resolve) => {
    const started = gravity.release((landed, info) => resolve({ started, landed, info }));
    if (!started) resolve({ started });
  });
}

test("falls with acceleration to the floor and reports the landing once", async () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  const ends = [];
  const landing = await new Promise((resolve) => {
    assert.strictEqual(gravity.startFall((value, info) => { ends.push(value); resolve(info); }), true);
    assert.strictEqual(gravity.isFalling(), true);
  });
  assert.deepStrictEqual(ends, [true]);
  assert.strictEqual(landing.intensity, 1, "732 px fall: full squash");
  assert.strictEqual(gravity.isFalling(), false);
  const ys = ctx.applied.map((b) => b.y);
  assert.strictEqual(ys[ys.length - 1], FLOOR_Y);
  assert.ok(ctx.applied.every((b) => b.x === 500 && b.width === PET && b.height === PET));
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1], "never goes up");
  const firstStep = ys[1] - ys[0];
  const lastStep = ys[ys.length - 2] - ys[ys.length - 3];
  assert.ok(lastStep > firstStep * 3, `accelerates (first step ${firstStep}, last ${lastStep})`);
  assert.strictEqual(ctx.hitSyncs, ctx.applied.length);
  assert.strictEqual(ctx.releases, 1);
  assert.deepStrictEqual(ctx.rotations, [], "a straight fall does not spin");
});

test("squash scales with the drop height: light at 100 px, none at 30 px", async () => {
  const low = await fallFrom(FLOOR_Y - 100);
  assert.strictEqual(low.landed, true);
  assert.ok(low.info.intensity > 0.1 && low.info.intensity < 0.4, `100 px gave ${low.info.intensity}`);
  const tiny = await fallFrom(FLOOR_Y - 30);
  assert.strictEqual(tiny.landed, true);
  assert.strictEqual(tiny.info.intensity, 0);
});

test("uses the work area of the display where it was dropped and the user's edge pinning", () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  gravity.startFall(() => {});
  gravity.cancel();
  assert.strictEqual(ctx.clampOptions.workArea, WORK_AREA);
  // No override: the rest clamp applies "Allow pinning to screen edges" itself.
  assert.ok(!("allowEdgePinning" in ctx.clampOptions), "the floor follows the edge pinning setting");
});

test("already on the floor: does not fall", () => {
  const ctx = makeCtx(FLOOR_Y - 1);
  const gravity = makeGravity(ctx);
  assert.strictEqual(gravity.startFall(() => assert.fail("should not be called")), false);
  assert.strictEqual(gravity.isFalling(), false);
  assert.strictEqual(ctx.applied.length, 0);
});

test("caught mid-air: stops where it is and reports no landing", async () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  const ends = [];
  gravity.startFall((value, info) => ends.push(value, info));
  await wait(120);
  ctx.dragLocked = true;
  await wait(60);
  assert.deepStrictEqual(ends, [false, null]);
  const moves = ctx.applied.length;
  assert.ok(lastY(ctx) < FLOOR_Y, "stayed in the air");
  await wait(60);
  assert.strictEqual(ctx.applied.length, moves, "does not move after being caught");
});

test("mini mode: does not fall", () => {
  const ctx = makeCtx(100);
  ctx.miniMode = true;
  const gravity = makeGravity(ctx);
  assert.strictEqual(gravity.startFall(() => {}), false);
});

test("Shift on release saves the height above the taskbar, and the shelf survives a restart", async () => {
  const floorFile = tempFloorFile();
  const shelfY = FLOOR_Y - 300;
  const setter = makeGravity(makeCtx(shelfY), floorFile);
  assert.strictEqual(setter.setFloorHere(), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(floorFile, "utf8")).floors, {
    "test-display": { heightAboveTaskbar: 300 },
  });
  const above = await fallFrom(shelfY - 300, floorFile);
  assert.strictEqual(above.landed, true);
  assert.strictEqual(lastY(above.ctx), shelfY, "from above it lands on the shelf");
});

test("below the shelf it falls to the taskbar; on top of it, it does not fall", async () => {
  const floorFile = tempFloorFile();
  const shelfY = FLOOR_Y - 300;
  makeGravity(makeCtx(shelfY), floorFile).setFloorHere();
  const below = await fallFrom(shelfY + 100, floorFile);
  assert.strictEqual(below.landed, true);
  assert.strictEqual(lastY(below.ctx), FLOOR_Y);
  const onShelf = await fallFrom(shelfY + 1, floorFile);
  assert.strictEqual(onShelf.started, false);
});

test("Shift on release at the taskbar clears the shelf", () => {
  const floorFile = tempFloorFile();
  makeGravity(makeCtx(FLOOR_Y - 300), floorFile).setFloorHere();
  const gravity = makeGravity(makeCtx(FLOOR_Y), floorFile);
  assert.strictEqual(gravity.hasCustomFloor(), true);
  gravity.setFloorHere();
  assert.strictEqual(gravity.hasCustomFloor(), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(floorFile, "utf8")).floors, {});
});

test("the reset-floor menu item clears the shelf and the pet on it falls", async () => {
  const floorFile = tempFloorFile();
  const shelfY = FLOOR_Y - 300;
  const ctx = makeCtx(shelfY);
  const gravity = makeGravity(ctx, floorFile);
  gravity.setFloorHere();
  const reset = (g) => g.buildMenuItem().submenu.find((i) => i.label === i18n.en.gravityResetFloor);
  assert.strictEqual(reset(gravity).enabled, true);
  const landed = new Promise((resolve) => gravity.setFallEndHandler((value) => resolve(value)));
  reset(gravity).click();
  assert.strictEqual(await landed, true);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
  assert.strictEqual(reset(gravity).enabled, false);
});

test("the menu is translated into every supported language, English by default", () => {
  const labels = (item) => [item.label, ...item.submenu.filter((i) => i.type !== "separator").map((i) => i.label)];
  const keys = ["gravity", "gravityFallWhenReleased", "gravitySetFloorHint", "gravityResetFloor"];
  assert.deepStrictEqual(labels(makeGravity(makeCtx(100)).buildMenuItem()), keys.map((key) => i18n.en[key]));
  for (const lang of SUPPORTED_LANGS) {
    const gravity = initGravity(makeCtx(100), {
      floorFile: tempFloorFile(),
      getDisplayKey: () => "test-display",
      t: createTranslator(() => lang),
    });
    assert.deepStrictEqual(labels(gravity.buildMenuItem()), keys.map((key) => i18n[lang][key]), lang);
  }
});

const toggle = (g) => g.buildMenuItem().submenu.find((i) => i.label === i18n.en.gravityFallWhenReleased);

test("turned off from the menu: no fall and no floor marking, and it stays off after a restart", () => {
  const floorFile = tempFloorFile();
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx, floorFile);
  assert.strictEqual(toggle(gravity).checked, true, "starts on");
  toggle(gravity).click();
  assert.strictEqual(gravity.isEnabled(), false);
  assert.strictEqual(toggle(gravity).checked, false);
  assert.strictEqual(gravity.startFall(() => assert.fail("should not fall")), false);
  assert.strictEqual(gravity.setFloorHere(), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(floorFile, "utf8")).enabled, false);
  const restarted = makeGravity(makeCtx(100), floorFile);
  assert.strictEqual(restarted.isEnabled(), false);
  assert.strictEqual(restarted.startFall(() => {}), false);
});

test("turning off mid-fall stops it where it is; turning back on with the pet in the air makes it fall", async () => {
  const floorFile = tempFloorFile();
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx, floorFile);
  const ends = [];
  gravity.setFallEndHandler((landed) => ends.push(landed));
  gravity.startFall();
  await wait(150);
  gravity.setEnabled(false);
  assert.deepStrictEqual(ends, [false]);
  const stoppedAt = lastY(ctx);
  assert.ok(stoppedAt < FLOOR_Y, "stopped in the air");
  await wait(60);
  assert.strictEqual(lastY(ctx), stoppedAt);
  const landed = new Promise((resolve) => gravity.setFallEndHandler((value) => resolve(value)));
  gravity.setEnabled(true);
  assert.strictEqual(gravity.isFalling(), true, "turned back on and already falling");
  assert.strictEqual(await landed, true);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
});

const s = (x, y, t) => ({ x, y, t });
// Six samples 16 ms apart, `px` apart horizontally; the release comes 5 ms after the last one.
const line = (px) => [0, 1, 2, 3, 4, 5].map((i) => s(i * px, 0, i * 16));

test("measurement: the fastest stretch of the last 120 ms; VS Code's 80 ms grace", () => {
  assert.strictEqual(Math.round(measureReleaseVelocity(line(32), 85).speed), 2000);
  // A flick at 3000 px/s that slows to ~300 px/s before the release: the peak counts, not the average.
  const flick = [s(0, 0, 0), s(48, 0, 16), s(96, 0, 32), s(144, 0, 48), s(149, 0, 64), s(154, 0, 80), s(159, 0, 96)];
  assert.strictEqual(Math.round(measureReleaseVelocity(flick, 100).speed), 3000);
  assert.strictEqual(measureReleaseVelocity(line(32), 80 + 81), null, "mouse still for more than 80 ms before the release");
  assert.strictEqual(measureReleaseVelocity([s(0, 0, 0)], 5), null, "a single sample");
  // An old peak, outside the 120 ms window, does not count.
  const old = [s(0, 0, 0), s(200, 0, 16), s(201, 0, 150), s(202, 0, 166), s(203, 0, 182)];
  assert.ok(measureReleaseVelocity(old, 185).speed < 200);
});

test("soft cap: no throw below 650 px/s; above it, 3200 × tanh(v/3200)", () => {
  const at = (px) => getThrowVelocity(line(px), 85);
  assert.strictEqual(at(8), null, "500 px/s");
  const v1000 = at(16).x;
  const v2000 = at(32).x;
  const v4000 = at(64).x;
  const v10000 = at(160).x;
  assert.ok(Math.abs(v1000 - 968.7) < 1, `1000 px/s → ${v1000}`);
  assert.ok(Math.abs(v2000 - 1774.7) < 1, `2000 px/s → ${v2000}`);
  assert.ok(Math.abs(v4000 - 2714.5) < 1, `4000 px/s → ${v4000}`);
  assert.ok(v10000 > 3150 && v10000 < 3200, `10000 px/s stays below 3200 (${v10000})`);
  assert.ok(v2000 > v1000 * 1.7 && v4000 > v2000 * 1.4, "still varies with the mouse speed");
  const diagonal = getThrowVelocity([0, 1, 2, 3, 4, 5].map((i) => s(i * 16, -i * 16, i * 16)), 85);
  assert.ok(Math.abs(diagonal.x + diagonal.y) < 1e-9, "keeps the direction of the gesture");
});

test("flight step: stops at the wall and reports it; the ceiling returns 20% of the speed", () => {
  const bounds = { minX: 0, maxX: 100, minY: 0 };
  const wall = advanceThrow({ x: 90, y: 50, vx: 1000, vy: 0 }, 32, bounds);
  assert.strictEqual(wall.wall, "right");
  assert.strictEqual(wall.x, 100);
  assert.strictEqual(wall.vx, 1000, "the loop reverses it, after the pause at the wall");
  assert.ok(Math.abs(wall.y - 50.14) < 0.01, `drops only for the time it takes to reach the wall (${wall.y})`);
  const ceiling = advanceThrow({ x: 50, y: 5, vx: 0, vy: -1000 }, 32, bounds);
  assert.strictEqual(ceiling.y, 0);
  assert.ok(Math.abs(ceiling.vy - 182.08) < 0.01, `ceiling: ${ceiling.vy}`);
  const free = advanceThrow({ x: 50, y: 50, vx: -500, vy: 0 }, 16, bounds);
  assert.strictEqual(free.wall, null);
});

test("throw to the right: hits the wall, comes back slowly and lands", async () => {
  const ctx = makeCtx(300, MAX_X - 470);
  const gravity = makeGravity(ctx);
  await drag(ctx, gravity, 40, 0);
  const result = await releaseAndLand(gravity);
  assert.strictEqual(result.started, true);
  assert.strictEqual(result.landed, true);
  const frames = ctx.applied;
  const xs = frames.map((b) => b.x);
  const hit = xs.indexOf(MAX_X);
  assert.ok(hit >= 2, `reached the right wall (${MAX_X}) after flying; the max was ${Math.max(...xs)}`);
  assert.ok(xs.every((x) => x <= MAX_X), "does not go through the wall");
  const back = frames.slice(hit + 1).filter((f) => f.x < MAX_X);
  assert.ok(back.length >= 3, "came back from the wall");
  const speedIn = (frames[hit - 1].x - frames[hit - 2].x) / (frames[hit - 1].t - frames[hit - 2].t);
  const speedBack = (back[0].x - back[2].x) / (back[2].t - back[0].t);
  const ratio = speedBack / speedIn;
  assert.ok(ratio > 0.1 && ratio < 0.35, `comes back with ~20% of the speed (${ratio.toFixed(2)})`);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
  assert.ok(result.info.intensity > 0);
  assert.ok(ctx.rotations.includes(90), "turned 90° to face the right wall");
  const afterWall = ctx.rotations.slice(ctx.rotations.indexOf(90));
  assert.ok(afterWall.every((r) => r >= 0 && r <= 90), "after the wall it only straightens up");
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0, "landed upright");
});

test("spin pace by angle: straight up is the slowest, sideways the fastest", () => {
  assert.strictEqual(getSpinTurnMs({ x: 0, y: -2000 }), 1100);
  assert.strictEqual(getSpinTurnMs({ x: 2000, y: 0 }), 600);
  const diagonal = getSpinTurnMs({ x: 1500, y: -1500 });
  assert.ok(Math.abs(diagonal - 746) < 1, `45°: ${diagonal} ms`);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(near(getSpinTurnMs({ x: -1500, y: -1500 }), diagonal), "to the left, the same pace");
  assert.ok(near(getSpinTurnMs({ x: 1500, y: 1500 }), diagonal), "downward too");
  assert.ok(near(getSpinTurnMs({ x: 300, y: -300 }), diagonal), "the throw strength does not change the pace");
  const steep = getSpinTurnMs({ x: 500, y: -2000 });
  assert.ok(steep < 1100 && steep > diagonal, `nearly straight (14°): ${steep} ms`);
});

test("one turn: fastest at the start, slowing down until upright", () => {
  assert.strictEqual(getSpinRotation(1, 0), 0);
  assert.ok(Math.abs(getSpinRotation(1, 0.5) - 254.56) < 0.01, "half the time, 71% of the turn");
  assert.ok(getSpinRotation(1, 0.9) > 355, "the last 10% of the time is only ~4°");
  assert.strictEqual(getSpinRotation(1, 1), 360);
  assert.strictEqual(getSpinRotation(1, 2), 360, "never goes past one turn");
  assert.ok(Math.abs(getSpinRotation(-1, 0.5) + 254.56) < 0.01, "to the left it spins the other way");
});

// Every angle that went back to 0 on landing had finished the turn (≥ 340°) or was nearly upright.
function assertNoSnap(rotations) {
  rotations.forEach((r, i) => {
    if (r !== 0 || i === 0) return;
    const before = Math.abs(rotations[i - 1]);
    assert.ok(before >= 340 || before <= 25, `went back to 0 mid-turn (from ${rotations[i - 1]}°)`);
  });
}

// From the release until past half a turn (180°), in ms.
async function halfTurnMs(ctx, gravity) {
  const releasedAt = performance.now();
  assert.strictEqual((await releaseAndLand(gravity)).landed, true);
  const i = ctx.rotations.findIndex((r) => Math.abs(r) >= 180);
  assert.ok(i >= 0, "went past half a turn");
  return ctx.rotationTimes[i] - releasedAt;
}

test("straight up spins slower than at 45°", async () => {
  const up = makeCtx(800, 900);
  const upGravity = makeGravity(up);
  await drag(up, upGravity, 0, -40);
  const upMs = await halfTurnMs(up, upGravity);
  assert.ok(Math.max(...up.rotations) >= 340, "straight up also does the full turn");

  const diagonal = makeCtx(800, 300);
  const diagonalGravity = makeGravity(diagonal);
  await drag(diagonal, diagonalGravity, 30, -30);
  const diagonalMs = await halfTurnMs(diagonal, diagonalGravity);
  assert.ok(upMs > diagonalMs * 1.25, `half turn: straight up ${Math.round(upMs)} ms, 45° ${Math.round(diagonalMs)} ms`);
});

test("throw up and sideways: a single turn, landing upright", async () => {
  const ctx = makeCtx(700, 300);
  const gravity = makeGravity(ctx);
  await drag(ctx, gravity, 30, -40);
  const result = await releaseAndLand(gravity);
  assert.strictEqual(result.landed, true);
  const maxSpin = Math.max(...ctx.rotations);
  assert.ok(maxSpin >= 300 && maxSpin <= 360, `one turn (${maxSpin}°)`);
  assert.ok(ctx.rotations.every((r) => r >= 0), "in one direction only");
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0, "landed upright");
  assertNoSnap(ctx.rotations);
});

test("a straight sideways throw also does one turn, in the direction of the gesture", async () => {
  const ctx = makeCtx(300, 1700);
  const gravity = makeGravity(ctx);
  await drag(ctx, gravity, -40, 0);
  assert.strictEqual((await releaseAndLand(gravity)).landed, true);
  const minSpin = Math.min(...ctx.rotations);
  assert.ok(minSpin <= -300 && minSpin >= -360, `one turn to the left (${minSpin}°)`);
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0);
  assertNoSnap(ctx.rotations);
});

test("short flight: no spin near the floor; a medium flight finishes the turn by the landing", async () => {
  const low = makeCtx(FLOOR_Y - 150);
  const lowGravity = makeGravity(low);
  await drag(low, lowGravity, 40, 0);
  assert.strictEqual((await releaseAndLand(lowGravity)).landed, true);
  assert.deepStrictEqual(low.rotations, [], "0.33 s flight: the turn would take under 450 ms");

  const mid = makeCtx(FLOOR_Y - 300);
  const midGravity = makeGravity(mid);
  await drag(mid, midGravity, 40, 0);
  assert.strictEqual((await releaseAndLand(midGravity)).landed, true);
  assert.ok(Math.max(...mid.rotations) >= 340, "did the full turn");
  assertNoSnap(mid.rotations);
});

test("caught mid-air while spinning: back upright at once", async () => {
  const ctx = makeCtx(700, 300);
  const gravity = makeGravity(ctx);
  await drag(ctx, gravity, 30, -40);
  gravity.release(() => {});
  await wait(120);
  assert.ok(ctx.rotations.some((r) => r !== 0), "was spinning");
  ctx.dragLocked = true;
  await wait(40);
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0);
});

test("throw up from below the shelf: passes through it and lands on top", async () => {
  const floorFile = tempFloorFile();
  const shelfY = FLOOR_Y - 300;
  makeGravity(makeCtx(shelfY), floorFile).setFloorHere();
  const ctx = makeCtx(shelfY + 150);
  const gravity = makeGravity(ctx, floorFile);
  await drag(ctx, gravity, 0, -40);
  const result = await releaseAndLand(gravity);
  assert.strictEqual(result.landed, true);
  assert.ok(Math.min(...ctx.applied.map((b) => b.y)) < shelfY, "rose above the shelf");
  assert.strictEqual(lastY(ctx), shelfY);
});

test("slow release or a still mouse: it just falls, with no throw", async () => {
  const slow = makeCtx(300);
  const slowGravity = makeGravity(slow);
  await drag(slow, slowGravity, 4, 0);
  const startX = slow.getPetWindowBounds().x;
  assert.strictEqual((await releaseAndLand(slowGravity)).landed, true);
  assert.ok(slow.applied.every((b) => b.x === startX), "slow: falls straight down");

  const parked = makeCtx(300);
  const parkedGravity = makeGravity(parked);
  await drag(parked, parkedGravity, 40, 0);
  await wait(120);
  const parkedX = parked.getPetWindowBounds().x;
  assert.strictEqual((await releaseAndLand(parkedGravity)).landed, true);
  assert.ok(parked.applied.every((b) => b.x === parkedX), "stopped before the release: falls straight down");
});
