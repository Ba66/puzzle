import { failure, success } from './types.ts';
import type {
  InputLockState,
  PID,
  ProcessRecord,
  SurfaceLayer,
  SurfaceOptions,
  SyscallResult,
  WindowSurface,
} from './types.ts';

const layerRank: Readonly<Record<SurfaceLayer, number>> = { system: 100, app: 200, overlay: 300 };
const unlocked: InputLockState = Object.freeze({
  locked: false,
  ownerId: null,
  ownerPid: null,
  reason: null,
  acquiredAtMs: null,
});

export class Wm {
  readonly layoutMode = 'single';
  readonly #surfaces = new Map<string, WindowSurface>();
  #surfaceSnapshot: readonly WindowSurface[] | undefined;
  #inputLock = unlocked;

  getSurfaces(): readonly WindowSurface[] {
    return this.#surfaceSnapshot ??= Object.freeze([...this.#surfaces.values()].sort((a, b) =>
      layerRank[a.layer] - layerRank[b.layer] || a.zIndex - b.zIndex,
    ));
  }

  getSurface(id: string): WindowSurface | undefined {
    return this.#surfaces.get(id);
  }

  create(process: ProcessRecord, options: SurfaceOptions): SyscallResult<WindowSurface> {
    const { id, layer = process.layer, zIndex = layerRank[layer], title = process.name, visible = true } = options;
    if (!id.trim() || !Object.hasOwn(layerRank, layer) || !Number.isFinite(zIndex)) {
      return failure('INVALID_STATE', 'A surface needs an ID, a valid layer, and a finite z-index.');
    }
    if (this.#surfaces.has(id)) return failure('INVALID_STATE', `Surface already exists: ${id}`);

    const surface = Object.freeze({ id, pid: process.pid, appId: process.appId, layer, zIndex, title, visible });
    this.#surfaces.set(id, surface);
    this.#surfaceSnapshot = undefined;
    return success(surface);
  }

  destroy(id: string): SyscallResult<void> {
    if (!this.#surfaces.delete(id)) return failure('NOT_FOUND', `Unknown surface: ${id}`);
    this.#surfaceSnapshot = undefined;
    return success(undefined);
  }

  destroyByPid(pid: PID): void {
    for (const [id, surface] of this.#surfaces) {
      if (surface.pid === pid) this.destroy(id);
    }
  }

  getInputLock(): InputLockState {
    return this.#inputLock;
  }

  acquire(ownerId: string, ownerPid: PID | null, reason: string, nowMs: number): SyscallResult<InputLockState> {
    if (this.#inputLock.locked) {
      if (this.#inputLock.ownerId === ownerId && this.#inputLock.ownerPid === ownerPid) {
        return success(this.#inputLock);
      }
      return failure('INVALID_STATE', 'The input lock already has an owner.');
    }

    this.#inputLock = Object.freeze({ locked: true, ownerId, ownerPid, reason, acquiredAtMs: nowMs });
    return success(this.#inputLock);
  }

  release(ownerId: string): SyscallResult<void> {
    if (this.#inputLock.ownerId !== ownerId) {
      return failure('INVALID_STATE', 'Only the input lock owner can release it.');
    }
    this.#inputLock = unlocked;
    return success(undefined);
  }

  releaseByPid(pid: PID): boolean {
    if (this.#inputLock.ownerPid !== pid) return false;
    this.#inputLock = unlocked;
    return true;
  }
}
