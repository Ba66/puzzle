import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import { LOCKSCREEN_APP_ID } from '../apps/lockscreen/manifest.ts';
import { readLayoutMetrics } from '../apps/pet/brain.ts';
import type { IntroBeat, LayoutMetrics, PetInitOptions } from '../apps/pet/brain.ts';
import { PET_APP_ID } from '../apps/pet/manifest.ts';
import type { Kernel } from '../kernel/Kernel.ts';
import type { InitialKernelState, PID, SurfaceLayer, SyscallHandle, SyscallResult } from '../kernel/types.ts';

export const initialKernelState = {
  device: 'phone' as const,
  hardware: {
    volume: 50,
    volumeOverlayVisible: false,
    brightness: 80,
    systemTime: '00:00',
    battery: 3,
  },
} satisfies InitialKernelState;

export const initialDirectorState = {
  flowMode: 'lockscreen' as const,
  knowledgeFlags: {} as Record<string, boolean>,
};

export type IntroReason = 'boot' | 'debug_replay';
export type IntroStage =
  | 'SILENT_LOCKSCREEN' | 'RIFT_OPENING' | 'SPLAT_GLASS' | 'SLIDE_AND_FALL' | 'RECOVER_AND_GREET' | 'COMPLETE';

export interface DirectorSnapshot {
  readonly flowMode: 'lockscreen' | 'intro' | 'interactive';
  readonly knowledgeFlags: Readonly<Record<string, boolean>>;
  readonly epoch: number;
  readonly introActive: boolean;
  readonly introElapsedMs: number;
  readonly introStage: IntroStage;
  readonly rift: { readonly visible: boolean; readonly progress: number; readonly intensity: number };
  readonly petPid: PID | null;
  readonly lockscreenPid: PID | null;
}

type ReadOnlyDirectorStore = Pick<StoreApi<DirectorSnapshot>, 'getState' | 'getInitialState' | 'subscribe'>;

interface IntroRun {
  readonly epoch: number;
  readonly startedAtMs: number;
  nextMilestone: number;
  stage: IntroStage;
  petPid: PID | null;
}

const riftOpenMs = 600;
const splatMs = 1000;
const riftClosedMs = 1380;
const handoffMs = 3800;
const milestones: readonly {
  readonly atMs: number;
  readonly beat: IntroBeat | 'SPAWN' | 'HANDOFF';
  readonly stage?: IntroStage;
}[] = [
  { atMs: riftOpenMs, beat: 'SPAWN', stage: 'RIFT_OPENING' },
  { atMs: splatMs, beat: 'SPLAT', stage: 'SPLAT_GLASS' },
  { atMs: 1700, beat: 'SLIDE', stage: 'SLIDE_AND_FALL' },
  { atMs: 2150, beat: 'FALL' },
  { atMs: 2700, beat: 'RECOVER', stage: 'RECOVER_AND_GREET' },
  { atMs: 3100, beat: 'GREET' },
  { atMs: handoffMs, beat: 'HANDOFF', stage: 'COMPLETE' },
];

const closedRift: DirectorSnapshot['rift'] = Object.freeze({ visible: false, progress: 0, intensity: 0 });

function riftAt(elapsedMs: number): DirectorSnapshot['rift'] {
  if (elapsedMs < riftOpenMs || elapsedMs >= riftClosedMs) return closedRift;
  const progress = elapsedMs < splatMs
    ? (elapsedMs - riftOpenMs) / (splatMs - riftOpenMs)
    : (riftClosedMs - elapsedMs) / (riftClosedMs - splatMs);
  const intensity = elapsedMs < splatMs ? progress * 0.7 + 0.3 : progress;
  return Object.freeze({ visible: true, progress, intensity });
}

function requireSuccess<T>(result: SyscallResult<T>): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

export class IntroDirector {
  readonly #kernel: Kernel;
  readonly #handle: SyscallHandle;
  readonly #store: StoreApi<DirectorSnapshot>;
  readonly #readonlyStore: ReadOnlyDirectorStore;
  #epoch = 0;
  #run: IntroRun | null = null;
  #latestLayout: LayoutMetrics | undefined;

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
    this.#handle = kernel.createSystemHandle('director', [
      'proc:spawn', 'proc:kill', 'proc:control', 'wm:input-lock', 'wm:surface',
      'ipc:send', 'ipc:subscribe', 'dmesg:write',
    ]);
    const lockscreenPid = this.#ensureLockscreen();
    this.#store = createStore<DirectorSnapshot>(() => Object.freeze({
      flowMode: initialDirectorState.flowMode,
      knowledgeFlags: Object.freeze({ ...initialDirectorState.knowledgeFlags }),
      epoch: 0,
      introActive: false,
      introElapsedMs: 0,
      introStage: 'SILENT_LOCKSCREEN',
      rift: closedRift,
      petPid: null,
      lockscreenPid,
    }));
    const { getState, getInitialState, subscribe } = this.#store;
    this.#readonlyStore = Object.freeze({ getState, getInitialState, subscribe });
    this.#handle.ipcSubscribe('system.layout_changed', ({ payload }) => {
      if (!payload || typeof payload !== 'object' || !('layout' in payload)) return;
      this.#latestLayout = readLayoutMetrics(payload.layout) ?? this.#latestLayout;
    });
    kernel.addTickListener((dtMs, nowMs) => this.onTick(dtMs, nowMs));
  }

  getSnapshot(): DirectorSnapshot {
    return this.#store.getState();
  }

  getStore(): ReadOnlyDirectorStore {
    return this.#readonlyStore;
  }

  subscribe(listener: Parameters<ReadOnlyDirectorStore['subscribe']>[0]): () => void {
    return this.#store.subscribe(listener);
  }

  triggerIntroRift(reason: IntroReason = 'boot'): boolean {
    const lock = this.#kernel.getSnapshot().inputLock;
    if (lock.locked && (lock.ownerId !== this.#handle.ownerId || lock.ownerPid !== null)) return false;

    const epoch = ++this.#epoch;
    this.#run = null;
    let pet = this.#kernel.findActiveProcessByAppId(PET_APP_ID);
    while (pet) {
      requireSuccess(this.#handle.procKill(pet.pid));
      if (epoch !== this.#epoch) return true;
      pet = this.#kernel.findActiveProcessByAppId(PET_APP_ID);
    }
    const lockscreenPid = this.#ensureLockscreen();
    if (epoch !== this.#epoch) return true;
    this.#handle.ipcPublish('director.replay_reset', { epoch, reason });
    if (epoch !== this.#epoch) return true;
    const acquired = this.#handle.wmAcquireInputLock('intro_sequence');
    if (!acquired.ok) return false;
    if (epoch !== this.#epoch) return true;

    const run: IntroRun = {
      epoch,
      startedAtMs: this.#kernel.getNowMs(),
      nextMilestone: 0,
      stage: 'SILENT_LOCKSCREEN',
      petPid: null,
    };
    this.#run = run;
    this.#update({
      flowMode: 'intro',
      epoch,
      introActive: true,
      introElapsedMs: 0,
      introStage: run.stage,
      rift: closedRift,
      petPid: null,
      lockscreenPid,
    });
    if (this.#run === run) this.#handle.dmesgWrite('info', 'director.intro_start', reason);
    return true;
  }

  onTick(_dtMs: number, nowMs = this.#kernel.getNowMs()): void {
    const run = this.#run;
    if (!run) return;
    const elapsedMs = Math.min(handoffMs, nowMs - run.startedAtMs);
    try {
      for (const milestone of milestones.slice(run.nextMilestone)) {
        if (milestone.atMs > elapsedMs) break;
        run.nextMilestone++;
        run.stage = milestone.stage ?? run.stage;
        if (milestone.beat === 'SPAWN') {
          this.#spawnPet(run);
        } else if (milestone.beat === 'HANDOFF') {
          this.#handoff(run);
          return;
        } else {
          this.#handle.ipcPublish('director.intro_beat', { epoch: run.epoch, beat: milestone.beat });
        }
        if (this.#run !== run) return;
      }
    } catch (error) {
      if (this.#run === run) {
        this.#run = null;
        if (run.petPid !== null) this.#handle.procKill(run.petPid);
        this.#handle.wmReleaseInputLock();
        this.#update({ flowMode: 'lockscreen', introActive: false, introElapsedMs: 0,
          introStage: 'SILENT_LOCKSCREEN', rift: closedRift, petPid: null });
      }
      throw error;
    }

    this.#update({ introElapsedMs: elapsedMs, introStage: run.stage, rift: riftAt(elapsedMs), petPid: run.petPid });
  }

  #handoff(run: IntroRun): void {
    requireSuccess(this.#handle.wmReleaseInputLock());
    this.#run = null;
    this.#handle.dmesgWrite('info', 'director.handoff');
    this.#handle.ipcPublish('director.intro_handoff', { epoch: run.epoch });
    if (this.#epoch !== run.epoch) return;
    this.#update({
      flowMode: 'interactive',
      introActive: false,
      introElapsedMs: handoffMs,
      introStage: 'COMPLETE',
      rift: closedRift,
      petPid: run.petPid,
    });
  }

  #ensureLockscreen(): PID {
    const process = this.#kernel.findActiveProcessByAppId(LOCKSCREEN_APP_ID);
    const pid = process?.pid ?? requireSuccess(this.#handle.procSpawn(LOCKSCREEN_APP_ID)).pid;
    if (process?.status === 'suspended') requireSuccess(this.#handle.procResume(pid));
    this.#ensureSurface(pid, 'surface:lockscreen', 'system');
    return pid;
  }

  #spawnPet(run: IntroRun): void {
    this.#handle.dmesgWrite('info', 'director.rift_open');
    const cues = milestones.flatMap(({ atMs, beat }) =>
      beat === 'SPAWN' ? [] : [{ beat, atMs: run.startedAtMs + atMs }],
    );
    const options: PetInitOptions = {
      layout: this.#latestLayout,
      intro: { epoch: run.epoch, spawnAtMs: run.startedAtMs + riftOpenMs, cues },
    };
    run.petPid = requireSuccess(this.#handle.procSpawn(PET_APP_ID, options)).pid;
    this.#ensureSurface(run.petPid, 'surface:pet', 'overlay');
  }

  #ensureSurface(pid: PID, id: string, layer: SurfaceLayer): void {
    // A replay can run inside an IPC callback before the kernel publishes its next snapshot.
    const destroyed = this.#handle.wmDestroySurface(id);
    if (!destroyed.ok && destroyed.code !== 'NOT_FOUND') requireSuccess(destroyed);
    requireSuccess(this.#handle.wmCreateSurface({ id, layer }, pid));
  }

  #update(patch: Partial<DirectorSnapshot>): void {
    this.#store.setState(Object.freeze({ ...this.getSnapshot(), ...patch }), true);
  }
}
