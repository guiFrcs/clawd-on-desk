"use strict";

// src/gravity.js — a drag released in mid-air makes the pet fall to the floor
// instead of hanging there; a fast release throws it spinning, and it bumps
// off the screen sides and top before landing.
//
// Same frame loop as roam.js: applyPetWindowBounds every 16 ms with the size
// frozen at the start (#569), hit window and anchored surfaces synced per frame.
//
// Floors per display: the taskbar one (lowest resting spot) and an optional
// shelf set with Shift+release, stored in ~/.clawd/gravity-floor.json as its
// height above the taskbar floor. The shelf is one-way: it only catches a pet
// coming down onto it, and below it the pet falls to the taskbar. The same
// file keeps the on/off switch from the Gravity menu (on by default).
//
// advanceThrow, the wall pose and the release rules of measureReleaseVelocity
// are adapted from VS Code's chat pet (src/vs/workbench/contrib/chat/browser/widget/
// chatPetWidget.ts @ 968fb17), Copyright (c) 2015 - present Microsoft
// Corporation, MIT License (text at the end of this file). Gravity, the peak
// measurement, the throw response curve and the one-turn spin are Clawd's own.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createTranslator } = require("./i18n");

const GRAVITY_PX_PER_S2 = 2800;
const MAX_FALL_SPEED_PX_PER_S = 2400;
const FRAME_MS = 16;
const MIN_DROP_PX = 2;
// Released this close below the shelf still counts as standing on it.
const SHELF_TOLERANCE_PX = 2;
const FLOOR_FILE = path.join(os.homedir(), ".clawd", "gravity-floor.json");
// Landing squash intensity (0..1) follows the impact speed: no squash up to a
// ~40 px drop, full squash from ~500 px (v = sqrt(2 * g * h)).
const SQUASH_MIN_SPEED = Math.sqrt(2 * GRAVITY_PX_PER_S2 * 40);
const SQUASH_FULL_SPEED = Math.sqrt(2 * GRAVITY_PX_PER_S2 * 500);

// Throw values from VS Code's chat pet.
const THROW_RELEASE_GRACE_MS = 80;
const THROW_MIN_VELOCITY = 650;
const THROW_MAX_FRAME_MS = 32;
const THROW_MAX_DURATION_MS = 4000;
const THROW_WALL_RESTITUTION = 0.2;
const THROW_CEILING_RESTITUTION = 0.2;
const WALL_IMPACT_MS = 48;
const THROW_SELF_RIGHTING_SPEED = 720;
// VS Code rolls 0.65° per sideways pixel, about one turn in its panel but two
// to four across a whole screen. Here every throw makes exactly one turn, and
// its pace follows the angle, as VS Code's spin follows the sideways speed:
// straight up (or down) takes 1.1 s, 45° ~0.75 s, sideways 0.6 s. A shorter
// flight shortens it so that 90% of it (all but the last ~4°) is done by the
// landing; a turn under 450 ms would be too fast, so that flight gets none.
const SPIN_UPRIGHT_TURN_MS = 1100;
const SPIN_SIDEWAYS_TURN_MS = 600;
const SPIN_MIN_TURN_MS = 450;
const SPIN_DONE_AT_LANDING = 0.9;
// Safety stop: whatever happens in the air, the pet ends on the floor.
const HARD_STOP_MS = 2 * THROW_MAX_DURATION_MS;
// Clawd's throw tuning. VS Code averages the last 100 ms and caps at
// 2400 px/s, which felt weak on a whole screen: here the fastest ~30 ms of
// the last 120 ms counts (a flick that slows right before the release keeps
// its force). Measured flicks go from ~700 to over 8000 px/s, so a soft cap
// (tanh) follows the hand up to ~1500 px/s and squeezes faster ones below 3200.
const THROW_PEAK_WINDOW_MS = 120;
const THROW_PEAK_SPAN_MS = 30;
const THROW_SOFT_MAX_VELOCITY = 3200;
const DRAG_SAMPLE_LIMIT = 16;

function landingIntensity(speed) {
  const k = (speed - SQUASH_MIN_SPEED) / (SQUASH_FULL_SPEED - SQUASH_MIN_SPEED);
  return Math.round(Math.min(1, Math.max(0, k)) * 100) / 100;
}

// Cursor velocity at the release, from the drag samples ({ x, y, t }): the
// fastest span of at least ~30 ms in the last 120 ms. null when the cursor
// rested for more than 80 ms before the release (VS Code's rule).
function measureReleaseVelocity(samples, releaseTime) {
  if (samples.length < 2) return null;
  const latest = samples[samples.length - 1];
  if (releaseTime - latest.t > THROW_RELEASE_GRACE_MS) return null;
  let best = null;
  for (let i = samples.length - 1; i > 0; i -= 1) {
    const end = samples[i];
    if (latest.t - end.t > THROW_PEAK_WINDOW_MS) break;
    let j = i - 1;
    while (j > 0 && end.t - samples[j].t < THROW_PEAK_SPAN_MS) j -= 1;
    const begin = samples[j];
    const elapsed = Math.max(16, end.t - begin.t);
    const x = ((end.x - begin.x) / elapsed) * 1000;
    const y = ((end.y - begin.y) / elapsed) * 1000;
    const speed = Math.hypot(x, y);
    if (!best || speed > best.speed) best = { x, y, speed };
  }
  return best;
}

// The throw: under 650 px/s there is none (VS Code's threshold); above it the
// speed goes through the soft cap, in the direction of the gesture.
function getThrowVelocity(samples, releaseTime) {
  const measured = measureReleaseVelocity(samples, releaseTime);
  if (!measured || measured.speed < THROW_MIN_VELOCITY) return null;
  const speed = THROW_SOFT_MAX_VELOCITY * Math.tanh(measured.speed / THROW_SOFT_MAX_VELOCITY);
  const scale = speed / measured.speed;
  return { x: measured.x * scale, y: measured.y * scale };
}

// One flight step: constant horizontal speed, gravity up to the maximum fall
// speed. A side wall ends the step at the wall and reports it; the top
// reflects the vertical speed at 20%.
function advanceThrow(motion, elapsedMs, bounds) {
  const duration = Math.max(0, elapsedMs) / 1000;
  const hasRange = bounds.maxX > bounds.minX;
  const startX = Math.max(bounds.minX, Math.min(Math.max(bounds.minX, bounds.maxX), motion.x));
  const projectedX = startX + motion.vx * duration;
  let wall = null;
  let motionDuration = duration;
  let x = hasRange ? projectedX : bounds.minX;
  if (hasRange && projectedX < bounds.minX) {
    wall = "left";
    motionDuration *= (bounds.minX - startX) / (projectedX - startX);
    x = bounds.minX;
  } else if (hasRange && projectedX > bounds.maxX) {
    wall = "right";
    motionDuration *= (bounds.maxX - startX) / (projectedX - startX);
    x = bounds.maxX;
  }
  const accelerating = Math.min(
    motionDuration,
    Math.max(0, (MAX_FALL_SPEED_PX_PER_S - motion.vy) / GRAVITY_PX_PER_S2),
  );
  const steady = motionDuration - accelerating;
  let y = motion.y
    + motion.vy * accelerating
    + (GRAVITY_PX_PER_S2 * accelerating * accelerating) / 2
    + MAX_FALL_SPEED_PX_PER_S * steady;
  let vy = Math.min(motion.vy + GRAVITY_PX_PER_S2 * accelerating, MAX_FALL_SPEED_PX_PER_S);
  if (y < bounds.minY) {
    y = bounds.minY;
    vy = Math.abs(vy) * THROW_CEILING_RESTITUTION;
  }
  return { x, y, vx: hasRange ? motion.vx : 0, vy, wall };
}

// How long the turn takes for a throw in this direction: the more sideways
// (sine of the angle to the vertical), the faster. Strength doesn't count.
function getSpinTurnMs(velocity) {
  const speed = Math.hypot(velocity.x, velocity.y);
  const sideways = speed > 0 ? Math.abs(velocity.x) / speed : 0;
  return SPIN_UPRIGHT_TURN_MS - (SPIN_UPRIGHT_TURN_MS - SPIN_SIDEWAYS_TURN_MS) * sideways;
}

// The one turn, in degrees, at progress 0..1: fastest at the release (1.6x
// the average speed) and slowing down into upright (ease-out sine).
// direction is +1 (clockwise) or -1.
function getSpinRotation(direction, progress) {
  const p = Math.min(1, Math.max(0, progress));
  return direction * 360 * Math.sin((p * Math.PI) / 2);
}

// The cursor, not the pet window: near a screen edge the drag clamp stops the
// window while the hand keeps moving.
function electronCursorPoint() {
  try {
    return require("electron").screen.getCursorScreenPoint();
  } catch {
    return null;
  }
}

// Display bounds as the key: stable across restarts while the monitor layout stays the same.
function electronDisplayKey(x, y) {
  try {
    const { screen } = require("electron");
    const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
    const b = display && display.bounds;
    return b ? `${b.x},${b.y},${b.width}x${b.height}` : null;
  } catch {
    return null;
  }
}

module.exports = function initGravity(ctx, options = {}) {
  const floorFile = options.floorFile || FLOOR_FILE;
  const getDisplayKey = options.getDisplayKey || electronDisplayKey;
  const now = options.now || (() => performance.now());
  const getCursorPoint = options.getCursorPoint || electronCursorPoint;
  // Spin in degrees to the pet window, which rotates the drawing.
  const setRotation = options.setRotation || (() => {});
  // Menu labels in the app's language; English when no translator is given.
  const translate = options.t || createTranslator(() => "en");
  const saved = loadState();
  let enabled = saved.enabled !== false;
  let floors = saved.floors;
  let falling = false;
  let fallTimer = null;
  let onFallEnd = null;
  let defaultFallEnd = null;
  let dragSamples = [];
  let shownRotation = 0;

  // Only changes go to the renderer (one IPC per frame at most, none at rest).
  function showRotation(degrees) {
    const rounded = Math.round(degrees * 10) / 10;
    if (rounded === shownRotation) return;
    shownRotation = rounded;
    setRotation(rounded);
  }

  function loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(floorFile, "utf8"));
      return {
        enabled: !(data && data.enabled === false),
        floors: data && data.floors && typeof data.floors === "object" ? data.floors : {},
      };
    } catch {
      return { enabled: true, floors: {} };
    }
  }

  function saveState() {
    try {
      fs.mkdirSync(path.dirname(floorFile), { recursive: true });
      const tmp = `${floorFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, enabled, floors }, null, 2));
      fs.renameSync(tmp, floorFile);
    } catch (err) {
      console.warn("Clawd gravity: floor not saved:", err && err.message);
    }
  }

  function isWindowAlive() {
    return !!(ctx.win && !ctx.win.isDestroyed());
  }

  function isMiniBusy() {
    return !!((ctx.getMiniMode && ctx.getMiniMode()) || ctx.miniTransitioning);
  }

  function frozenSize(bounds) {
    const size = typeof ctx.getEffectiveCurrentPixelSize === "function"
      ? ctx.getEffectiveCurrentPixelSize()
      : null;
    return {
      width: size && Number.isFinite(size.width) && size.width > 0 ? size.width : bounds.width,
      height: size && Number.isFinite(size.height) && size.height > 0 ? size.height : bounds.height,
    };
  }

  // Floors, walls and top of the display where the pet is, all from the rest
  // clamp it already obeys (as if dragged against each edge). shelfY is null
  // without a custom floor there.
  function resolveArea(bounds) {
    const { width, height } = frozenSize(bounds);
    const cx = bounds.x + width / 2;
    const cy = bounds.y + height / 2;
    const wa = ctx.getNearestWorkArea(cx, cy);
    if (!wa) return null;
    const rest = (x, y) => ctx.clampToScreenVisual(x, y, width, height, { workArea: wa, allowEdgePinning: false });
    const lowest = rest(bounds.x, wa.y + wa.height);
    const highest = rest(bounds.x, wa.y - height);
    const leftmost = rest(wa.x - width, bounds.y);
    const rightmost = rest(wa.x + wa.width + width, bounds.y);
    const valid = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
    if (![lowest, highest, leftmost, rightmost].every(valid)) return null;
    const taskbarY = Math.round(lowest.y);
    const topY = Math.round(highest.y);
    const key = getDisplayKey(cx, cy);
    const savedFloor = key ? floors[key] : null;
    let shelfY = null;
    if (savedFloor && Number.isFinite(savedFloor.heightAboveTaskbar) && savedFloor.heightAboveTaskbar > 0) {
      shelfY = Math.max(topY, taskbarY - Math.round(savedFloor.heightAboveTaskbar));
    }
    return {
      width,
      height,
      key,
      taskbarY,
      shelfY,
      bounds: { minX: Math.round(leftmost.x), maxX: Math.round(rightmost.x), minY: topY },
    };
  }

  function finish(landed, landing) {
    if (fallTimer) {
      clearTimeout(fallTimer);
      fallTimer = null;
    }
    if (!falling) return;
    falling = false;
    // Upright before the landing squash (or the drag that caught it) starts.
    showRotation(0);
    // Same release point as roam: a reconcile marked dirty mid-fall runs now.
    if (typeof ctx.releaseReconcileProtection === "function") ctx.releaseReconcileProtection();
    const callback = onFallEnd;
    onFallEnd = null;
    if (typeof callback === "function") callback(landed, landing || null);
  }

  // Drops the pet, or throws it when a velocity comes in. Returns true when it
  // left the ground. onEnd(landed, landing) runs once at the end (defaults to
  // the setFallEndHandler one); landed is false (landing null) when the pet was
  // caught mid-air or the flight was interrupted, otherwise landing = { intensity }.
  function startFall(onEnd, velocity) {
    if (!enabled || falling || !isWindowAlive() || isMiniBusy()) return false;
    const start = ctx.getPetWindowBounds();
    if (!start) return false;
    const area = resolveArea(start);
    if (!area) return false;
    const { width, height } = area;
    const thrown = !!velocity && (velocity.x !== 0 || velocity.y !== 0);
    if (!thrown) {
      const onShelfSide = area.shelfY !== null && start.y <= area.shelfY + SHELF_TOLERANCE_PX;
      const floorY = onShelfSide ? area.shelfY : area.taskbarY;
      if (floorY - start.y < MIN_DROP_PX) return false;
    }

    falling = true;
    onFallEnd = onEnd || defaultFallEnd;
    let motion = { x: start.x, y: start.y, vx: thrown ? velocity.x : 0, vy: thrown ? velocity.y : 0 };
    const startedAt = now();
    let lastTick = startedAt;
    let wallHoldUntil = 0;
    let frameCount = 0;
    let rotation = 0;
    let righting = false;

    // Coming down onto the shelf (one-way) or reaching the taskbar floor.
    function landingAt(previousY, next) {
      if (next.vy < 0) return null;
      if (area.shelfY !== null && previousY <= area.shelfY + SHELF_TOLERANCE_PX && next.y >= area.shelfY) {
        return area.shelfY;
      }
      return next.y >= area.taskbarY ? area.taskbarY : null;
    }

    // Flight time ahead, to fit the turn in it (wall pauses skipped).
    function predictFlightMs() {
      let m = motion;
      for (let ms = FRAME_MS; ms < HARD_STOP_MS; ms += FRAME_MS) {
        const n = advanceThrow(m, FRAME_MS, area.bounds);
        if (landingAt(m.y, n) !== null) return ms;
        m = n.wall ? { ...n, vx: -n.vx * THROW_WALL_RESTITUTION } : n;
      }
      return HARD_STOP_MS;
    }

    let spin = null;
    if (thrown) {
      const turnMs = Math.min(getSpinTurnMs(velocity), predictFlightMs() / SPIN_DONE_AT_LANDING);
      if (turnMs >= SPIN_MIN_TURN_MS) spin = { direction: motion.vx < 0 ? -1 : 1, turnMs };
    }

    function place(x, y, final) {
      ctx.applyPetWindowBounds({ x: Math.round(x), y: Math.round(y), width, height });
      if (typeof ctx.syncHitWin === "function") ctx.syncHitWin();
      if (typeof ctx.repositionAnchoredSurfaces === "function") ctx.repositionAnchoredSurfaces();
      if (
        typeof ctx.repositionBubbles === "function"
        && ctx.bubbleFollowPet
        && ctx.pendingPermissions
        && ctx.pendingPermissions.length
        && (++frameCount % 3 === 0 || final)
      ) {
        ctx.repositionBubbles();
      }
    }

    function step() {
      fallTimer = null;
      if (!falling) return;
      // Caught mid-air (the new drag owns the window), mini mode or shutdown.
      if (!isWindowAlive() || ctx.dragLocked || isMiniBusy()) {
        finish(false);
        return;
      }
      const t = now();
      // Against a wall: hold still, then come back at 20% of the speed.
      if (wallHoldUntil) {
        if (t < wallHoldUntil) {
          fallTimer = setTimeout(step, FRAME_MS);
          return;
        }
        wallHoldUntil = 0;
        lastTick = t;
        motion = { ...motion, vx: -motion.vx * THROW_WALL_RESTITUTION };
      }
      const flying = t - startedAt;
      // Like VS Code: after 4 s in the air the pet stops drifting and drops.
      if (flying >= THROW_MAX_DURATION_MS && motion.vx !== 0) {
        motion = { ...motion, vx: 0, vy: Math.max(0, motion.vy) };
      }
      const elapsed = Math.min(THROW_MAX_FRAME_MS, Math.max(0, t - lastTick));
      lastTick = t;
      const previousY = motion.y;
      const next = advanceThrow(motion, elapsed, area.bounds);

      let landY = landingAt(previousY, next);
      if (landY === null && flying >= HARD_STOP_MS) landY = area.taskbarY;
      if (landY !== null) {
        // Speed when touching down (v² = v0² + 2gh), not at the end of the
        // frame, which already overshot the floor by up to 32 ms.
        const impact = Math.min(
          MAX_FALL_SPEED_PX_PER_S,
          Math.sqrt(Math.max(0, motion.vy * motion.vy + 2 * GRAVITY_PX_PER_S2 * (landY - previousY))),
        );
        place(next.x, landY, true);
        finish(true, { intensity: landingIntensity(impact) });
        return;
      }
      motion = next;
      if (next.wall) {
        // Like VS Code: the impact stops the turn, the pet faces the wall at
        // 90° and then rights itself at 720°/s while it falls.
        spin = null;
        righting = true;
        rotation = next.wall === "left" ? -90 : 90;
        wallHoldUntil = t + WALL_IMPACT_MS;
      } else if (spin) {
        const progress = (t - startedAt) / spin.turnMs;
        rotation = progress >= 1 ? 0 : getSpinRotation(spin.direction, progress);
        if (progress >= 1) spin = null;
      } else if (righting) {
        const correction = (THROW_SELF_RIGHTING_SPEED * elapsed) / 1000;
        rotation = Math.abs(rotation) <= correction ? 0 : rotation - Math.sign(rotation) * correction;
        righting = rotation !== 0;
      }
      place(motion.x, motion.y, false);
      showRotation(rotation);
      fallTimer = setTimeout(step, FRAME_MS);
    }

    // Deferred first frame: drag-end may still hold the drag lock until its finally block.
    fallTimer = setTimeout(step, FRAME_MS);
    return true;
  }

  // A new drag catches a falling pet and starts a fresh throw measurement.
  function beginDrag() {
    cancel();
    dragSamples = [];
  }

  function recordDragSample() {
    const point = getCursorPoint();
    if (!point) return;
    dragSamples.push({ x: point.x, y: point.y, t: now() });
    if (dragSamples.length > DRAG_SAMPLE_LIMIT) dragSamples.shift();
  }

  // End of a drag: a fast release throws the pet, a slow one just drops it.
  // The cursor at the release joins the samples while the hand was still moving.
  function release(onEnd) {
    const t = now();
    const lastMove = dragSamples[dragSamples.length - 1];
    let samples = dragSamples;
    if (lastMove && t - lastMove.t <= THROW_RELEASE_GRACE_MS) {
      const point = getCursorPoint();
      if (point) samples = [...dragSamples, { x: point.x, y: point.y, t }];
    }
    const velocity = getThrowVelocity(samples, t);
    dragSamples = [];
    return startFall(onEnd, velocity);
  }

  // Shift+release: the current height becomes this display's floor. Released
  // on (or below) the taskbar floor, it clears the custom floor instead.
  function setFloorHere() {
    if (!enabled) return false;
    const bounds = ctx.getPetWindowBounds();
    const here = bounds && resolveArea(bounds);
    if (!here || !here.key) return false;
    const heightAboveTaskbar = Math.round(here.taskbarY - bounds.y);
    if (heightAboveTaskbar <= SHELF_TOLERANCE_PX) delete floors[here.key];
    else floors[here.key] = { heightAboveTaskbar };
    saveState();
    return true;
  }

  function hasCustomFloor() {
    const bounds = ctx.getPetWindowBounds();
    const here = bounds && resolveArea(bounds);
    return !!(here && here.shelfY !== null);
  }

  // The shelf goes away: a pet standing on it drops to the taskbar.
  function resetFloor() {
    const bounds = ctx.getPetWindowBounds();
    const here = bounds && resolveArea(bounds);
    if (!here || !here.key || !floors[here.key]) return false;
    delete floors[here.key];
    saveState();
    startFall();
    return true;
  }

  // Off: stops a fall where it is. On: a pet left in mid-air drops right away.
  function setEnabled(value) {
    const next = !!value;
    if (next === enabled) return;
    enabled = next;
    saveState();
    if (enabled) startFall();
    else cancel();
  }

  function isEnabled() {
    return enabled;
  }

  function buildMenuItem() {
    return {
      label: translate("gravity"),
      submenu: [
        { label: translate("gravityFallWhenReleased"), type: "checkbox", checked: enabled, click: () => setEnabled(!enabled) },
        { type: "separator" },
        { label: translate("gravitySetFloorHint"), enabled: false },
        {
          label: translate("gravityResetFloor"),
          enabled: enabled && hasCustomFloor(),
          click: () => resetFloor(),
        },
      ],
    };
  }

  function setFallEndHandler(handler) {
    defaultFallEnd = typeof handler === "function" ? handler : null;
  }

  function cancel() {
    finish(false);
  }

  function isFalling() {
    return falling;
  }

  return {
    startFall,
    release,
    beginDrag,
    recordDragSample,
    cancel,
    isFalling,
    setFloorHere,
    hasCustomFloor,
    resetFloor,
    setEnabled,
    isEnabled,
    buildMenuItem,
    setFallEndHandler,
  };
};

module.exports.measureReleaseVelocity = measureReleaseVelocity;
module.exports.getThrowVelocity = getThrowVelocity;
module.exports.advanceThrow = advanceThrow;
module.exports.getSpinTurnMs = getSpinTurnMs;
module.exports.getSpinRotation = getSpinRotation;

/*
 * License of the parts adapted from VS Code (release rules, advanceThrow, wall pose):
 *
 * MIT License
 *
 * Copyright (c) 2015 - present Microsoft Corporation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
