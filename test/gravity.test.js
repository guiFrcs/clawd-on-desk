"use strict";

// Exercita o src/gravity.js com um contexto falso (tempo real, poucos segundos).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const initGravity = require("../src/gravity");
const { measureReleaseVelocity, getThrowVelocity, advanceThrow, getSpinTurnMs, getSpinRotation } = initGravity;

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
    getDisplayKey: () => "monitor-teste",
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

// Arrasta em tempo real: um passo de (dx, dy) a cada ~16 ms, como os drag-move do Clawd.
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

test("cai acelerando até o chão e avisa o pouso uma vez", async () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  const ends = [];
  const landing = await new Promise((resolve) => {
    assert.strictEqual(gravity.startFall((value, info) => { ends.push(value); resolve(info); }), true);
    assert.strictEqual(gravity.isFalling(), true);
  });
  assert.deepStrictEqual(ends, [true]);
  assert.strictEqual(landing.intensity, 1, "queda de 732 px: achatamento cheio");
  assert.strictEqual(gravity.isFalling(), false);
  const ys = ctx.applied.map((b) => b.y);
  assert.strictEqual(ys[ys.length - 1], FLOOR_Y);
  assert.ok(ctx.applied.every((b) => b.x === 500 && b.width === PET && b.height === PET));
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1], "nunca sobe");
  const firstStep = ys[1] - ys[0];
  const lastStep = ys[ys.length - 2] - ys[ys.length - 3];
  assert.ok(lastStep > firstStep * 3, `acelera (primeiro passo ${firstStep}, último ${lastStep})`);
  assert.strictEqual(ctx.hitSyncs, ctx.applied.length);
  assert.strictEqual(ctx.releases, 1);
  assert.deepStrictEqual(ctx.rotations, [], "queda reta não gira");
});

test("achatamento proporcional à altura: leve em 100 px, nenhum em 30 px", async () => {
  const low = await fallFrom(FLOOR_Y - 100);
  assert.strictEqual(low.landed, true);
  assert.ok(low.info.intensity > 0.1 && low.info.intensity < 0.4, `100 px deu ${low.info.intensity}`);
  const tiny = await fallFrom(FLOOR_Y - 30);
  assert.strictEqual(tiny.landed, true);
  assert.strictEqual(tiny.info.intensity, 0);
});

test("usa a área de trabalho do monitor onde foi solto, sem encaixe na borda", () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  gravity.startFall(() => {});
  gravity.cancel();
  assert.strictEqual(ctx.clampOptions.workArea, WORK_AREA);
  assert.strictEqual(ctx.clampOptions.allowEdgePinning, false);
});

test("já no chão: não cai", () => {
  const ctx = makeCtx(FLOOR_Y - 1);
  const gravity = makeGravity(ctx);
  assert.strictEqual(gravity.startFall(() => assert.fail("não devia chamar")), false);
  assert.strictEqual(gravity.isFalling(), false);
  assert.strictEqual(ctx.applied.length, 0);
});

test("pego no ar: para onde está e avisa sem pouso", async () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  const ends = [];
  gravity.startFall((value, info) => ends.push(value, info));
  await wait(120);
  ctx.dragLocked = true;
  await wait(60);
  assert.deepStrictEqual(ends, [false, null]);
  const moves = ctx.applied.length;
  assert.ok(lastY(ctx) < FLOOR_Y, "ficou no ar");
  await wait(60);
  assert.strictEqual(ctx.applied.length, moves, "não mexe mais depois de pego");
});

test("modo mini: não cai", () => {
  const ctx = makeCtx(100);
  ctx.miniMode = true;
  const gravity = makeGravity(ctx);
  assert.strictEqual(gravity.startFall(() => {}), false);
});

test("Shift ao soltar grava a altura acima da barra de tarefas, e a prateleira vale depois de reiniciar", async () => {
  const floorFile = tempFloorFile();
  const shelfY = FLOOR_Y - 300;
  const setter = makeGravity(makeCtx(shelfY), floorFile);
  assert.strictEqual(setter.setFloorHere(), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(floorFile, "utf8")).floors, {
    "monitor-teste": { heightAboveTaskbar: 300 },
  });
  const above = await fallFrom(shelfY - 300, floorFile);
  assert.strictEqual(above.landed, true);
  assert.strictEqual(lastY(above.ctx), shelfY, "de cima cai na prateleira");
});

test("abaixo da prateleira cai até a barra de tarefas; em cima dela não cai", async () => {
  const floorFile = tempFloorFile();
  const shelfY = FLOOR_Y - 300;
  makeGravity(makeCtx(shelfY), floorFile).setFloorHere();
  const below = await fallFrom(shelfY + 100, floorFile);
  assert.strictEqual(below.landed, true);
  assert.strictEqual(lastY(below.ctx), FLOOR_Y);
  const onShelf = await fallFrom(shelfY + 1, floorFile);
  assert.strictEqual(onShelf.started, false);
});

test("Shift ao soltar na barra de tarefas apaga a prateleira", () => {
  const floorFile = tempFloorFile();
  makeGravity(makeCtx(FLOOR_Y - 300), floorFile).setFloorHere();
  const gravity = makeGravity(makeCtx(FLOOR_Y), floorFile);
  assert.strictEqual(gravity.hasCustomFloor(), true);
  gravity.setFloorHere();
  assert.strictEqual(gravity.hasCustomFloor(), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(floorFile, "utf8")).floors, {});
});

test("Voltar para a barra de tarefas: apaga a prateleira e o pet em cima dela cai", async () => {
  const floorFile = tempFloorFile();
  const shelfY = FLOOR_Y - 300;
  const ctx = makeCtx(shelfY);
  const gravity = makeGravity(ctx, floorFile);
  gravity.setFloorHere();
  const reset = (g) => g.buildMenuItem().submenu.find((i) => i.label === "Voltar para a barra de tarefas");
  assert.strictEqual(reset(gravity).enabled, true);
  const landed = new Promise((resolve) => gravity.setFallEndHandler((value) => resolve(value)));
  reset(gravity).click();
  assert.strictEqual(await landed, true);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
  assert.strictEqual(reset(gravity).enabled, false);
});

const toggle = (g) => g.buildMenuItem().submenu.find((i) => i.label === "Queda ao soltar");

test("desligada pelo menu: não cai nem marca chão, e continua desligada depois de reiniciar", () => {
  const floorFile = tempFloorFile();
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx, floorFile);
  assert.strictEqual(toggle(gravity).checked, true, "começa ligada");
  toggle(gravity).click();
  assert.strictEqual(gravity.isEnabled(), false);
  assert.strictEqual(toggle(gravity).checked, false);
  assert.strictEqual(gravity.startFall(() => assert.fail("não devia cair")), false);
  assert.strictEqual(gravity.setFloorHere(), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(floorFile, "utf8")).enabled, false);
  const restarted = makeGravity(makeCtx(100), floorFile);
  assert.strictEqual(restarted.isEnabled(), false);
  assert.strictEqual(restarted.startFall(() => {}), false);
});

test("desligar no meio da queda para onde está; religar com o pet no ar faz cair", async () => {
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
  assert.ok(stoppedAt < FLOOR_Y, "parou no ar");
  await wait(60);
  assert.strictEqual(lastY(ctx), stoppedAt);
  const landed = new Promise((resolve) => gravity.setFallEndHandler((value) => resolve(value)));
  gravity.setEnabled(true);
  assert.strictEqual(gravity.isFalling(), true, "religou e já está caindo");
  assert.strictEqual(await landed, true);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
});

const s = (x, y, t) => ({ x, y, t });
// Seis amostras a cada 16 ms andando `px` na horizontal; solta 5 ms depois da última.
const line = (px) => [0, 1, 2, 3, 4, 5].map((i) => s(i * px, 0, i * 16));

test("medição: o trecho mais rápido dos últimos 120 ms; folga de 80 ms do VS Code", () => {
  assert.strictEqual(Math.round(measureReleaseVelocity(line(32), 85).speed), 2000);
  // Flick a 3000 px/s e freada a ~300 px/s antes de soltar: vale o pico, não a média.
  const flick = [s(0, 0, 0), s(48, 0, 16), s(96, 0, 32), s(144, 0, 48), s(149, 0, 64), s(154, 0, 80), s(159, 0, 96)];
  assert.strictEqual(Math.round(measureReleaseVelocity(flick, 100).speed), 3000);
  assert.strictEqual(measureReleaseVelocity(line(32), 80 + 81), null, "mouse parado mais de 80 ms antes de soltar");
  assert.strictEqual(measureReleaseVelocity([s(0, 0, 0)], 5), null, "uma amostra só");
  // Pico antigo, fora dos 120 ms, não conta.
  const old = [s(0, 0, 0), s(200, 0, 16), s(201, 0, 150), s(202, 0, 166), s(203, 0, 182)];
  assert.ok(measureReleaseVelocity(old, 185).speed < 200);
});

test("teto suave: abaixo de 650 px/s não arremessa; acima, 3200 × tanh(v/3200)", () => {
  const at = (px) => getThrowVelocity(line(px), 85);
  assert.strictEqual(at(8), null, "500 px/s");
  const v1000 = at(16).x;
  const v2000 = at(32).x;
  const v4000 = at(64).x;
  const v10000 = at(160).x;
  assert.ok(Math.abs(v1000 - 968.7) < 1, `1000 px/s → ${v1000}`);
  assert.ok(Math.abs(v2000 - 1774.7) < 1, `2000 px/s → ${v2000}`);
  assert.ok(Math.abs(v4000 - 2714.5) < 1, `4000 px/s → ${v4000}`);
  assert.ok(v10000 > 3150 && v10000 < 3200, `10000 px/s fica abaixo de 3200 (${v10000})`);
  assert.ok(v2000 > v1000 * 1.7 && v4000 > v2000 * 1.4, "continua variando com a velocidade do mouse");
  const diagonal = getThrowVelocity([0, 1, 2, 3, 4, 5].map((i) => s(i * 16, -i * 16, i * 16)), 85);
  assert.ok(Math.abs(diagonal.x + diagonal.y) < 1e-9, "mantém a direção do gesto");
});

test("passo do voo: para na parede e avisa; o teto devolve 20% da velocidade", () => {
  const bounds = { minX: 0, maxX: 100, minY: 0 };
  const wall = advanceThrow({ x: 90, y: 50, vx: 1000, vy: 0 }, 32, bounds);
  assert.strictEqual(wall.wall, "right");
  assert.strictEqual(wall.x, 100);
  assert.strictEqual(wall.vx, 1000, "quem inverte é o laço, depois da pausa na parede");
  assert.ok(Math.abs(wall.y - 50.14) < 0.01, `só desce o tempo até a parede (${wall.y})`);
  const ceiling = advanceThrow({ x: 50, y: 5, vx: 0, vy: -1000 }, 32, bounds);
  assert.strictEqual(ceiling.y, 0);
  assert.ok(Math.abs(ceiling.vy - 182.08) < 0.01, `teto: ${ceiling.vy}`);
  const free = advanceThrow({ x: 50, y: 50, vx: -500, vy: 0 }, 16, bounds);
  assert.strictEqual(free.wall, null);
});

test("arremesso para a direita: bate na parede, volta devagar e pousa", async () => {
  const ctx = makeCtx(300, MAX_X - 470);
  const gravity = makeGravity(ctx);
  await drag(ctx, gravity, 40, 0);
  const result = await releaseAndLand(gravity);
  assert.strictEqual(result.started, true);
  assert.strictEqual(result.landed, true);
  const frames = ctx.applied;
  const xs = frames.map((b) => b.x);
  const hit = xs.indexOf(MAX_X);
  assert.ok(hit >= 2, `chegou na parede direita (${MAX_X}) depois de voar; máximo foi ${Math.max(...xs)}`);
  assert.ok(xs.every((x) => x <= MAX_X), "não atravessa a parede");
  const back = frames.slice(hit + 1).filter((f) => f.x < MAX_X);
  assert.ok(back.length >= 3, "voltou da parede");
  const speedIn = (frames[hit - 1].x - frames[hit - 2].x) / (frames[hit - 1].t - frames[hit - 2].t);
  const speedBack = (back[0].x - back[2].x) / (back[2].t - back[0].t);
  const ratio = speedBack / speedIn;
  assert.ok(ratio > 0.1 && ratio < 0.35, `volta com ~20% da velocidade (${ratio.toFixed(2)})`);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
  assert.ok(result.info.intensity > 0);
  assert.ok(ctx.rotations.includes(90), "virou 90° de frente para a parede direita");
  const afterWall = ctx.rotations.slice(ctx.rotations.indexOf(90));
  assert.ok(afterWall.every((r) => r >= 0 && r <= 90), "depois da parede só se endireita");
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0, "pousou em pé");
});

test("ritmo da volta pelo ângulo: reto para cima é a mais lenta, de lado a mais rápida", () => {
  assert.strictEqual(getSpinTurnMs({ x: 0, y: -2000 }), 1100);
  assert.strictEqual(getSpinTurnMs({ x: 2000, y: 0 }), 600);
  const diagonal = getSpinTurnMs({ x: 1500, y: -1500 });
  assert.ok(Math.abs(diagonal - 746) < 1, `45°: ${diagonal} ms`);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(near(getSpinTurnMs({ x: -1500, y: -1500 }), diagonal), "para a esquerda, o mesmo ritmo");
  assert.ok(near(getSpinTurnMs({ x: 1500, y: 1500 }), diagonal), "para baixo também");
  assert.ok(near(getSpinTurnMs({ x: 300, y: -300 }), diagonal), "a força não muda o ritmo");
  const steep = getSpinTurnMs({ x: 500, y: -2000 });
  assert.ok(steep < 1100 && steep > diagonal, `quase reto (14°): ${steep} ms`);
});

test("uma volta: mais rápida no começo, desacelerando até ficar em pé", () => {
  assert.strictEqual(getSpinRotation(1, 0), 0);
  assert.ok(Math.abs(getSpinRotation(1, 0.5) - 254.56) < 0.01, "metade do tempo, 71% da volta");
  assert.ok(getSpinRotation(1, 0.9) > 355, "os últimos 10% do tempo são só ~4°");
  assert.strictEqual(getSpinRotation(1, 1), 360);
  assert.strictEqual(getSpinRotation(1, 2), 360, "nunca passa de uma volta");
  assert.ok(Math.abs(getSpinRotation(-1, 0.5) + 254.56) < 0.01, "para a esquerda gira ao contrário");
});

// Todo ângulo que voltou a 0 no pouso tinha terminado a volta (≥ 340°) ou estava quase em pé.
function assertNoSnap(rotations) {
  rotations.forEach((r, i) => {
    if (r !== 0 || i === 0) return;
    const before = Math.abs(rotations[i - 1]);
    assert.ok(before >= 340 || before <= 25, `voltou a 0 no meio da volta (de ${rotations[i - 1]}°)`);
  });
}

// Do soltar até passar de meia volta (180°), em ms.
async function halfTurnMs(ctx, gravity) {
  const releasedAt = performance.now();
  assert.strictEqual((await releaseAndLand(gravity)).landed, true);
  const i = ctx.rotations.findIndex((r) => Math.abs(r) >= 180);
  assert.ok(i >= 0, "passou de meia volta");
  return ctx.rotationTimes[i] - releasedAt;
}

test("reto para cima gira mais devagar que a 45°", async () => {
  const up = makeCtx(800, 900);
  const upGravity = makeGravity(up);
  await drag(up, upGravity, 0, -40);
  const upMs = await halfTurnMs(up, upGravity);
  assert.ok(Math.max(...up.rotations) >= 340, "reto para cima também dá a volta inteira");

  const diagonal = makeCtx(800, 300);
  const diagonalGravity = makeGravity(diagonal);
  await drag(diagonal, diagonalGravity, 30, -30);
  const diagonalMs = await halfTurnMs(diagonal, diagonalGravity);
  assert.ok(upMs > diagonalMs * 1.25, `meia volta: reto ${Math.round(upMs)} ms, 45° ${Math.round(diagonalMs)} ms`);
});

test("arremesso para cima e para o lado: uma volta só e pousa em pé", async () => {
  const ctx = makeCtx(700, 300);
  const gravity = makeGravity(ctx);
  await drag(ctx, gravity, 30, -40);
  const result = await releaseAndLand(gravity);
  assert.strictEqual(result.landed, true);
  const maxSpin = Math.max(...ctx.rotations);
  assert.ok(maxSpin >= 300 && maxSpin <= 360, `uma volta (${maxSpin}°)`);
  assert.ok(ctx.rotations.every((r) => r >= 0), "num sentido só");
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0, "pousou em pé");
  assertNoSnap(ctx.rotations);
});

test("arremesso reto para o lado também dá uma volta, no sentido do gesto", async () => {
  const ctx = makeCtx(300, 1700);
  const gravity = makeGravity(ctx);
  await drag(ctx, gravity, -40, 0);
  assert.strictEqual((await releaseAndLand(gravity)).landed, true);
  const minSpin = Math.min(...ctx.rotations);
  assert.ok(minSpin <= -300 && minSpin >= -360, `uma volta para a esquerda (${minSpin}°)`);
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0);
  assertNoSnap(ctx.rotations);
});

test("voo curto: perto do chão não gira; voo médio completa a volta até o pouso", async () => {
  const low = makeCtx(FLOOR_Y - 150);
  const lowGravity = makeGravity(low);
  await drag(low, lowGravity, 40, 0);
  assert.strictEqual((await releaseAndLand(lowGravity)).landed, true);
  assert.deepStrictEqual(low.rotations, [], "0,33 s de voo: a volta teria menos de 450 ms");

  const mid = makeCtx(FLOOR_Y - 300);
  const midGravity = makeGravity(mid);
  await drag(mid, midGravity, 40, 0);
  assert.strictEqual((await releaseAndLand(midGravity)).landed, true);
  assert.ok(Math.max(...mid.rotations) >= 340, "deu a volta");
  assertNoSnap(mid.rotations);
});

test("pego no ar girando: volta a ficar em pé na hora", async () => {
  const ctx = makeCtx(700, 300);
  const gravity = makeGravity(ctx);
  await drag(ctx, gravity, 30, -40);
  gravity.release(() => {});
  await wait(120);
  assert.ok(ctx.rotations.some((r) => r !== 0), "estava girando");
  ctx.dragLocked = true;
  await wait(40);
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0);
});

test("arremesso para cima por baixo da prateleira: passa por ela e pousa em cima", async () => {
  const floorFile = tempFloorFile();
  const shelfY = FLOOR_Y - 300;
  makeGravity(makeCtx(shelfY), floorFile).setFloorHere();
  const ctx = makeCtx(shelfY + 150);
  const gravity = makeGravity(ctx, floorFile);
  await drag(ctx, gravity, 0, -40);
  const result = await releaseAndLand(gravity);
  assert.strictEqual(result.landed, true);
  assert.ok(Math.min(...ctx.applied.map((b) => b.y)) < shelfY, "subiu acima da prateleira");
  assert.strictEqual(lastY(ctx), shelfY);
});

test("soltar devagar ou com o mouse parado: só cai, sem arremesso", async () => {
  const slow = makeCtx(300);
  const slowGravity = makeGravity(slow);
  await drag(slow, slowGravity, 4, 0);
  const startX = slow.getPetWindowBounds().x;
  assert.strictEqual((await releaseAndLand(slowGravity)).landed, true);
  assert.ok(slow.applied.every((b) => b.x === startX), "lento: cai reto");

  const parked = makeCtx(300);
  const parkedGravity = makeGravity(parked);
  await drag(parked, parkedGravity, 40, 0);
  await wait(120);
  const parkedX = parked.getPetWindowBounds().x;
  assert.strictEqual((await releaseAndLand(parkedGravity)).landed, true);
  assert.ok(parked.applied.every((b) => b.x === parkedX), "parou antes de soltar: cai reto");
});
