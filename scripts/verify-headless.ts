import type { LockScreenState } from '../src/apps/lockscreen/logic.ts';
import { DEFAULT_LAYOUT_METRICS, MAX_THROW_VX_ISO, MAX_TILT_DEG } from '../src/apps/pet/brain.ts';
import type { PetState } from '../src/apps/pet/brain.ts';
import { INTRO_GREETING } from '../src/apps/pet/dialogue.ts';
import { LOCKSCREEN_APP_ID, PET_APP_ID } from '../src/apps/registry.ts';
import { createGameRuntime } from '../src/director/actions.ts';
import type { SystemAction } from '../src/director/actions.ts';
import type { SyscallResult } from '../src/kernel/types.ts';

type Runtime = ReturnType<typeof createGameRuntime>;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function near(actual: number, expected: number, message: string, tolerance = 1e-8) {
  check(Math.abs(actual - expected) <= tolerance, `${message} (expected ${expected}, got ${actual})`);
}

function unwrap<T>(result: SyscallResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
}

function pet({ kernel, director }: Runtime): PetState {
  const pid = director.getSnapshot().petPid;
  check(pid !== null, 'The Director should own a pet process');
  const state = kernel.getProcessState<PetState>(pid);
  check(state, 'The pet process should expose its snapshot');
  return state;
}

function lockscreen({ kernel, director }: Runtime): LockScreenState {
  const pid = director.getSnapshot().lockscreenPid;
  check(pid !== null, 'The Director should own a lockscreen process');
  const state = kernel.getProcessState<LockScreenState>(pid);
  check(state, 'The lockscreen process should expose its snapshot');
  return state;
}

function send({ kernel }: Runtime, action: SystemAction) {
  const result = kernel.dispatch(action);
  check(result.accepted, `${action.type} was blocked by ${result.blockedBy}`);
}

function stepTo({ kernel }: Runtime, atMs: number) {
  kernel.step(atMs - kernel.getNowMs());
}

function logCount({ kernel }: Runtime, event: string): number {
  return kernel.getSnapshot().dmesg.filter((entry) => entry.event === event).length;
}

function checkBounds({ ix, iy, layout }: PetState) {
  const side = layout.petWidthIso / 2 + 0.02;
  const top = layout.topSafeNorm * layout.aspectRatio + layout.petHeightIso;
  check(ix >= side && ix <= 1 - side, 'Pet exceeded the horizontal collider bounds');
  check(iy >= top && iy <= layout.floorYNorm * layout.aspectRatio, 'Pet exceeded the vertical collider bounds');
}

function settle(runtime: Runtime, condition: (state: PetState) => boolean): number {
  for (let elapsedMs = 0; elapsedMs <= 4000; elapsedMs += 5) {
    const state = pet(runtime);
    checkBounds(state);
    if (condition(state)) return elapsedMs;
    if (elapsedMs < 4000) runtime.kernel.step(5);
  }
  throw new Error('Pet never reached the expected motion state');
}

function checkIntro(runtime: Runtime) {
  const { kernel, director } = runtime;
  const initial = kernel.getSnapshot();
  check(initial.hardware.systemTime === '00:00' && initial.hardware.battery === 3, 'Unexpected initial hardware');
  check(initial.processes.length === 1 && initial.processes[0].appId === LOCKSCREEN_APP_ID, 'Expected just the lockscreen');
  stepTo(runtime, 599);
  check(initial.inputLock.locked && kernel.findActiveProcessByAppId(PET_APP_ID) === undefined, 'Silent intro should hold input');
  check(kernel.dispatch({ type: 'POKE_PET' }).blockedBy === 'INPUT_LOCK', 'Locked poke was accepted');
  check(kernel.dispatch({ type: 'TAP_STUCK_SLIDER' }).blockedBy === 'INPUT_LOCK', 'Locked slider tap was accepted');
  stepTo(runtime, 600);
  check(director.getSnapshot().rift.visible && logCount(runtime, 'director.rift_open') === 1, 'Rift did not open at 600 ms');
  check(pet(runtime).fsm === 'INTRO_EMERGE', 'Pet did not emerge');
  check(kernel.getSnapshot().surfaces.filter(({ layer }) => layer === 'overlay').length === 1, 'Missing or duplicate pet surface');
  stepTo(runtime, 1000);
  check(pet(runtime).fsm === 'INTRO_SPLAT' && pet(runtime).squashX === 1.44, 'The pet missed the glass splat');
  stepTo(runtime, 1699);
  near(pet(runtime).y, 0.34, 'The splat did not stay pasted to the glass');
  stepTo(runtime, 1700);
  const slideSpeed = pet(runtime).vyIso;
  check(pet(runtime).fsm === 'INTRO_SLIDE' && slideSpeed > 0, 'The slow slide did not start');
  stepTo(runtime, 2350);
  check(pet(runtime).fsm === 'INTRO_FALL' && pet(runtime).vyIso > slideSpeed * 4, 'Free fall did not accelerate');
  stepTo(runtime, 2699);
  check(pet(runtime).introLanded && logCount(runtime, 'pet.land') === 1, 'The pet should land once before recovery');
  stepTo(runtime, 2700);
  check(pet(runtime).headShakeActive, 'Recovery omitted the head shake');
  stepTo(runtime, 3100);
  const greeting = pet(runtime).bubble;
  check(greeting?.text === INTRO_GREETING && greeting.remainingMs === 6500, 'Incorrect opening greeting');
  stepTo(runtime, 3800);
  check(!kernel.getSnapshot().inputLock.locked, 'Input lock survived handoff');
  check(director.getSnapshot().flowMode === 'interactive' && pet(runtime).fsm === 'IDLE_ROAM', 'No interactive handoff');
  check(pet(runtime).bubble?.id === greeting.id && pet(runtime).bubble?.remainingMs === 5800, 'Greeting did not survive handoff');
  check(lockscreen(runtime).tapCount === 0 && kernel.getSnapshot().hal.vibrationCount === 0, 'Locked actions were replayed');
}

function checkReactions(runtime: Runtime) {
  send(runtime, { type: 'POKE_PET' });
  const first = pet(runtime);
  check(first.fsm === 'POKED' && first.squashX === 1.30 && first.bubble?.tone === 'poke', 'Poke missed its reaction');
  runtime.kernel.step(470);
  send(runtime, { type: 'POKE_PET' });
  check(pet(runtime).bubble?.text !== first.bubble.text && pet(runtime).expression !== first.expression, 'Poke repeated');
  runtime.kernel.step(10);
  check(pet(runtime).fsm === 'POKED', 'The first poke timer canceled its replacement');
  send(runtime, { type: 'HOLD_PET' });
  check(pet(runtime).fsm === 'SOOTHED' && pet(runtime).shyWobbleActive, 'Hold missed the soothed pose');
  check(pet(runtime).wireframeFlashRemainingMs === 80, 'Low RNG draw missed the wireframe');
  runtime.kernel.step(79);
  check(pet(runtime).wireframeFlashRemainingMs === 1, 'Wireframe duration drifted');
  runtime.kernel.step(1);
  check(!pet(runtime).wireframeFlashActive && pet(runtime).fsm === 'SOOTHED', 'The flash or soothe duration was wrong');
  runtime.kernel.step(1120);
  check(pet(runtime).fsm === 'IDLE_ROAM', 'Soothe did not expire');

  const high = createGameRuntime({ rng: () => 0.99, layout: DEFAULT_LAYOUT_METRICS });
  high.kernel.step(3800);
  send(high, { type: 'HOLD_PET' });
  check(!pet(high).wireframeFlashActive && pet(high).bubble?.tone === 'soothe', 'High RNG draw caused a wireframe');
}

function launch(runtime: Runtime, fling: boolean) {
  const start = pet(runtime);
  const pointer = { x: start.x - 0.04, y: start.y - 0.05 };
  send(runtime, { type: 'START_DRAG_PET', payload: pointer });
  near(pet(runtime).ix, start.ix, 'Grab teleported the pet');
  const logLength = runtime.kernel.getSnapshot().dmesg.length;
  const lifted = { x: 0.23, y: pointer.y - 0.36 / start.layout.aspectRatio };
  runtime.kernel.step(25);
  send(runtime, { type: 'MOVE_DRAG_PET', payload: lifted });
  runtime.kernel.step(240);
  send(runtime, { type: 'MOVE_DRAG_PET', payload: lifted });
  const end = { x: lifted.x + (fling ? 0.08 : 0), y: lifted.y };
  runtime.kernel.step(25);
  send(runtime, { type: 'MOVE_DRAG_PET', payload: end });
  check(runtime.kernel.getSnapshot().dmesg.length === logLength, 'Drag moves produced dmesg entries');
  const tilt = pet(runtime).tiltDeg;
  send(runtime, { type: 'END_DRAG_PET', payload: end });
  const released = pet(runtime);
  check(released.fsm === 'FALLING', 'An airborne release did not fall');
  check(Math.abs(released.vxIso) <= MAX_THROW_VX_ISO && Math.abs(tilt) <= MAX_TILT_DEG, 'Fling exceeded its bounds');
  check(fling ? released.vxIso > 2 && tilt < -5 : Math.abs(released.vxIso) < 0.05, 'Fling and drop release speeds did not differ');
  return { released, tilt };
}

function checkIsotropy(fling: boolean) {
  const traces = [1.5, 2.2].map((aspectRatio) => {
    const runtime = createGameRuntime({ rng: () => 0.51, layout: { ...DEFAULT_LAYOUT_METRICS, aspectRatio } });
    runtime.kernel.step(3800);
    const { released, tilt } = launch(runtime, fling);
    const positions: number[][] = [];
    const impactMs = settle(runtime, (state) => {
      positions.push([state.ix, state.iy - state.layout.floorYNorm * aspectRatio]);
      return state.landComplaintCount === 1;
    });
    const displacement = pet(runtime).ix - released.ix;
    check(pet(runtime).vyIso < 0 && pet(runtime).bubble?.tone === 'land', 'Impact did not rebound and complain');
    settle(runtime, ({ fsm }) => fsm === 'IDLE_ROAM');
    check(pet(runtime).landComplaintCount === 1 && logCount(runtime, 'pet.land') === 2, 'Bounces produced duplicate complaints');
    return { impactMs, displacement, tilt, positions };
  });
  const [short, tall] = traces;
  check(short.impactMs === tall.impactMs, 'Aspect ratio changed impact time');
  near(short.displacement, tall.displacement, 'Aspect ratio changed landing displacement');
  near(short.tilt, tall.tilt, 'Aspect ratio changed tilt');
  short.positions.forEach(([x, altitude], index) => {
    near(x, tall.positions[index][0], 'Aspect ratio changed horizontal position');
    near(altitude, tall.positions[index][1], 'Aspect ratio changed altitude');
  });
  return short.displacement;
}

function checkLifecycle(runtime: Runtime, hostVibrations: number[][]) {
  const { kernel, director } = runtime;
  send(runtime, { type: 'TAP_STUCK_SLIDER' });
  check(lockscreen(runtime).locked && lockscreen(runtime).tapCount === 1, 'Slider changed the lock state');
  check(kernel.getSnapshot().hal.lastVibration?.patternMs.join(',') === '25,35,25', 'HAL missed the vibration');
  check(hostVibrations.length === 1 && hostVibrations[0].join(',') === '25,35,25', 'Host missed the vibration');
  check(pet(runtime).bubble?.tone === 'slider', 'Slider IPC missed the pet');

  const control = kernel.createSystemHandle('verifier-control', ['proc:control']);
  const oldPid = director.getSnapshot().petPid!;
  launch(runtime, true);
  const nearTap = { x: 0.23, y: 0.41 };
  const lastTap = { x: 0.74, y: 0.39 };
  send(runtime, { type: 'SUMMON_PET_TO', payload: nearTap });
  send(runtime, { type: 'SUMMON_PET_TO', payload: lastTap });
  check(pet(runtime).fsm === 'FALLING' && pet(runtime).queuedSummonTarget?.x === lastTap.x, 'Summon displaced the active fall');
  check(lockscreen(runtime).ripples.length === 2, 'Summon ripple IPC missed the lockscreen');
  const suspended = pet(runtime);
  unwrap(control.procSuspend(oldPid));
  send(runtime, { type: 'TAP_STUCK_SLIDER' });
  check(kernel.dispatch({ type: 'POKE_PET' }).blockedBy === 'PROCESS_SUSPENDED', 'Suspended pet accepted a poke');
  kernel.step(650);
  check(pet(runtime) === suspended && lockscreen(runtime).ripples.length === 0, 'Suspension changed the pet or stalled the lockscreen');
  unwrap(control.procResume(oldPid));
  settle(runtime, ({ fsm }) => fsm === 'SUMMON_MOVE');
  settle(runtime, ({ fsm }) => fsm === 'IDLE_ROAM');
  near(pet(runtime).x, lastTap.x, 'Pet did not reach the latest summon');
  check(pet(runtime).lookTarget?.y === lastTap.y, 'Pet did not look at the summon point');

  send(runtime, { type: 'START_DRAG_PET', payload: lastTap });
  const replay = { type: 'TRIGGER_INTRO_RIFT', payload: { reason: 'debug_replay' } } as const;
  send(runtime, replay);
  check(kernel.getProcessState(oldPid) === undefined, 'Replay kept the old dragged pet alive');
  kernel.step(1400);
  const introPid = director.getSnapshot().petPid!;
  for (let i = 0; i < 5; i++) send(runtime, replay);
  check(kernel.getProcessState(introPid) === undefined && kernel.getSnapshot().inputLock.locked, 'Replay did not replace the old intro');
  check(lockscreen(runtime).tapCount === 0 && lockscreen(runtime).ripples.length === 0, 'Replay did not reset the lockscreen');
  kernel.step(599);
  check(kernel.getSnapshot().processes.filter(({ status }) => status !== 'terminated').length === 1, 'Pet respawned too early');
  kernel.step(3201);
  check(!kernel.getSnapshot().inputLock.locked && pet(runtime).fsm === 'IDLE_ROAM', 'Replayed intro did not finish');
  check(kernel.getSnapshot().processes.filter(({ status }) => status !== 'terminated').length === 2, 'Duplicate processes after replay');
  send(runtime, { type: 'TAP_STUCK_SLIDER' });
  check(pet(runtime).bubble?.tone === 'slider' && pet(runtime).bubble?.id === 2, 'Replay duplicated the slider reaction');
  const logs = kernel.getSnapshot().dmesg;
  check(logs.every(({ seq, level }, index) => level !== 'error' && (index === 0 || seq > logs[index - 1].seq)), 'Kernel log was invalid');
}

const hostVibrations: number[][] = [];
const runtime = createGameRuntime({
  rng: () => 0.01,
  layout: { ...DEFAULT_LAYOUT_METRICS, aspectRatio: 2 },
  onVibrate: (pattern) => { hostVibrations.push([...pattern]); },
});
checkIntro(runtime);
checkReactions(runtime);
const dropDistance = checkIsotropy(false);
const flingDistance = checkIsotropy(true);
check(Math.abs(flingDistance - dropDistance) > 0.15, 'Fling did not travel farther than a drop');
checkLifecycle(runtime, hostVibrations);

console.log('Headless verification passed');
console.log('  Intro     | timed beats, input lock, greeting persistence');
console.log('  Reactions | poke, soothe, both wireframe outcomes');
console.log('  Physics   | drop and fling at aspect ratios 1.5 and 2.2, single impact complaint');
console.log('  IPC       | summon, ripple, stuck slider, HAL and host vibration');
console.log('  Lifecycle | suspend, resume, replay during intro and drag');
