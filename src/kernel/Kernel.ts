import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import { Hal } from './hal.ts';
import { Ipc } from './ipc.ts';
import { Proc } from './proc.ts';
import type { PermissionPolicy } from './proc.ts';
import { failure, success } from './types.ts';
import type {
  AppDefinition,
  AppProcessInstance,
  DispatchResult,
  DmesgEntry,
  DmesgLevel,
  InitialKernelState,
  KernelAction,
  KernelSnapshot,
  Permission,
  PID,
  ProcessRecord,
  SurfaceOptions,
  SyscallHandle,
  SyscallResult,
  WindowSurface,
} from './types.ts';
import { Vfs } from './vfs.ts';
import { Wm } from './wm.ts';

const PROCESS_OWNER_PREFIX = 'proc:';

export interface KernelOptions {
  readonly onVibrate?: (patternMs: readonly number[]) => void;
  readonly permissionPolicy?: PermissionPolicy;
}

export interface ActionRouteOptions {
  readonly bypassInputLock?: boolean;
  readonly targetAppId?: string;
}

export type ActionRouteHandler = (
  action: KernelAction,
  instance: AppProcessInstance | undefined,
  process: ProcessRecord | undefined,
) => boolean | void;

type ReadonlyKernelStore = Pick<StoreApi<KernelSnapshot>, 'getState' | 'getInitialState' | 'subscribe'>;
type TickListener = (dtMs: number, nowMs: number) => void;

interface ActionRoute extends ActionRouteOptions {
  readonly handler: ActionRouteHandler;
}

interface Caller {
  readonly ownerId: string;
  readonly pid: PID | null;
  readonly permissions: ReadonlySet<Permission>;
}

export class Kernel {
  readonly #hal: Hal;
  readonly #vfs = new Vfs();
  readonly #proc: Proc;
  readonly #wm = new Wm();
  readonly #ipc = new Ipc();
  readonly #store: StoreApi<KernelSnapshot>;
  readonly #readonlyStore: ReadonlyKernelStore;
  readonly #instances = new Map<PID, AppProcessInstance>();
  readonly #routes = new Map<string, ActionRoute>();
  readonly #tickListeners = new Set<TickListener>();
  #nowMs = 0;
  #revision = 0;
  #mutationDepth = 0;
  #dirty = false;
  #publishing = false;

  constructor(initialState: InitialKernelState, options: KernelOptions = {}) {
    const { onVibrate, permissionPolicy } = options;
    this.#hal = new Hal(initialState, onVibrate && ((pattern) => {
      this.#invoke('hal', 'hal.host-error', () => onVibrate(pattern));
    }));
    this.#proc = new Proc(permissionPolicy);
    this.#store = createStore<KernelSnapshot>(() => this.#snapshot());
    const { getState, getInitialState, subscribe } = this.#store;
    this.#readonlyStore = Object.freeze({ getState, getInitialState, subscribe });
  }

  getSnapshot(): KernelSnapshot {
    return this.#store.getState();
  }

  subscribe(listener: Parameters<ReadonlyKernelStore['subscribe']>[0]): () => void {
    return this.#store.subscribe(listener);
  }

  getStore(): ReadonlyKernelStore {
    return this.#readonlyStore;
  }

  getNowMs(): number {
    return this.#nowMs;
  }

  getProcessState<T = unknown>(pid: PID): T | undefined {
    return this.#instances.get(pid)?.getState() as T | undefined;
  }

  findActiveProcessByAppId(appId: string): ProcessRecord | undefined {
    return this.#proc.findActiveProcessByAppId(appId);
  }

  findRunningProcessByAppId(appId: string): ProcessRecord | undefined {
    return this.#proc.findRunningProcessByAppId(appId);
  }

  registerApp<TState, TInit>(definition: AppDefinition<TState, TInit>): SyscallResult<void> {
    return this.#proc.registerApp(definition);
  }

  createSystemHandle(ownerId: string, permissions: readonly Permission[]): SyscallHandle {
    if (!ownerId.trim() || ownerId.startsWith(PROCESS_OWNER_PREFIX)) {
      throw new RangeError('System handles need a non-empty owner ID outside the process namespace.');
    }
    return this.#createHandle(ownerId, null, permissions);
  }

  registerActionRoute(actionType: string, options: ActionRouteOptions, handler: ActionRouteHandler): () => void {
    const route = { ...options, handler };
    this.#routes.set(actionType, route);
    return () => {
      if (this.#routes.get(actionType) === route) this.#routes.delete(actionType);
    };
  }

  dispatch(action: KernelAction): DispatchResult {
    const route = this.#routes.get(action.type);
    if (this.#wm.getInputLock().locked && !route?.bypassInputLock) {
      return { accepted: false, blockedBy: 'INPUT_LOCK' };
    }
    if (!route) return { accepted: false, blockedBy: 'NO_HANDLER' };

    let process: ProcessRecord | undefined;
    let instance: AppProcessInstance | undefined;
    if (route.targetAppId !== undefined) {
      process = this.#proc.findActiveProcessByAppId(route.targetAppId);
      if (!process) return { accepted: false, blockedBy: 'NO_HANDLER' };
      if (process.status === 'suspended') return { accepted: false, blockedBy: 'PROCESS_SUSPENDED' };
      instance = this.#instances.get(process.pid);
      if (!instance) return { accepted: false, blockedBy: 'NO_HANDLER' };
    }

    const source = process ? PROCESS_OWNER_PREFIX + process.pid : 'kernel';
    return this.#mutate(() => {
      this.#dirty = true;
      const result = this.#invoke(source, 'action.handler-error', () => route.handler(action, instance, process));
      if (!result.ok || result.data === false) return { accepted: false, blockedBy: 'INVALID_TARGET' };
      return { accepted: true, handledBy: process?.appId ?? action.type };
    });
  }

  addTickListener(listener: TickListener): () => void {
    const tick: TickListener = (dtMs, nowMs) => listener(dtMs, nowMs);
    this.#tickListeners.add(tick);
    return () => { this.#tickListeners.delete(tick); };
  }

  step(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs < 0) {
      throw new RangeError('A step requires a finite, non-negative duration.');
    }
    const nowMs = this.#nowMs + dtMs;
    if (!Number.isFinite(nowMs)) throw new RangeError('The logical clock would overflow.');
    if (this.#mutationDepth !== 0) throw new Error('Cannot step during a kernel operation.');

    this.#mutate(() => {
      this.#nowMs = nowMs;
      this.#dirty = true;

      for (const tick of [...this.#tickListeners]) {
        if (this.#tickListeners.has(tick)) this.#invoke('kernel', 'tick.listener-error', () => tick(dtMs, nowMs));
      }

      for (const record of this.#proc.getRecords()) {
        if (record.status !== 'running' || this.#proc.getRecord(record.pid)?.status !== 'running') continue;
        const instance = this.#instances.get(record.pid);
        if (instance?.onTick) {
          this.#invoke(PROCESS_OWNER_PREFIX + record.pid, 'proc.tick-error', () => instance.onTick?.(dtMs, nowMs));
        }
      }
    });
  }

  #createHandle(ownerId: string, pid: PID | null, permissions: readonly Permission[]): SyscallHandle {
    const grants = new Set(permissions);
    const caller: Caller = { ownerId, pid, permissions: grants };
    const call = <T>(permission: Permission | undefined, run: () => SyscallResult<T>): SyscallResult<T> =>
      this.#syscall(caller, permission, run);

    const handle: SyscallHandle = {
      ownerId,
      pid,
      permissions: Object.freeze([...grants]),
      halVibrate: (pattern) => call('hal:vibrate', () => this.#changed(this.#hal.vibrate(pattern, this.#nowMs))),
      halGetHardware: () => call(undefined, () => success(this.#hal.hardware)),
      ipcPublish: (topic, payload) => call('ipc:send', () => this.#changed(success(
        this.#ipc.publish(topic, ownerId, pid, payload, this.#nowMs,
          (subscriberPid) => this.#proc.getRecord(subscriberPid)?.status !== 'running'),
      ))),
      ipcSubscribe: (topic, handler) => call('ipc:subscribe', () =>
        success(this.#ipc.subscribe(topic, ownerId, pid, handler))),
      vfsList: (path) => call('vfs:read', () => this.#vfs.list(path)),
      vfsRead: (path) => call('vfs:read', () => this.#vfs.read(path)),
      vfsWrite: (path, content) => call('vfs:write', () => this.#vfs.write(path, content)),
      procSpawn: (appId, initOptions) => call('proc:spawn', () => this.#spawn(appId, initOptions)),
      procSuspend: (targetPid) => call('proc:control', () => this.#setSuspended(targetPid, true)),
      procResume: (targetPid) => call('proc:control', () => this.#setSuspended(targetPid, false)),
      procKill: (targetPid) => call('proc:kill', () => this.#kill(targetPid)),
      wmAcquireInputLock: (reason) => call('wm:input-lock', () => {
        const prior = this.#wm.getInputLock();
        const result = this.#wm.acquire(ownerId, pid, reason, this.#nowMs);
        if (result.ok && result.data !== prior) this.#log('info', ownerId, 'wm.input-lock.acquired', reason);
        return result;
      }),
      wmReleaseInputLock: () => call('wm:input-lock', () => {
        const result = this.#wm.release(ownerId);
        if (result.ok) this.#log('info', ownerId, 'wm.input-lock.released');
        return result;
      }),
      wmCreateSurface: (options, targetPid = pid ?? undefined) => call('wm:surface', () =>
        this.#createSurface(caller, options, targetPid)),
      wmDestroySurface: (id) => call('wm:surface', () => this.#destroySurface(caller, id)),
      dmesgWrite: (level, event, detail) => call('dmesg:write', () => success(this.#log(level, ownerId, event, detail))),
    };
    return Object.freeze(handle);
  }

  #syscall<T>(caller: Caller, permission: Permission | undefined, run: () => SyscallResult<T>): SyscallResult<T> {
    if (caller.pid !== null) {
      const status = this.#proc.getRecord(caller.pid)?.status;
      if (status === 'suspended') return failure('PROCESS_SUSPENDED', 'The calling process is suspended.');
      if (status !== 'running') return failure('INVALID_STATE', 'The calling process has terminated.');
    }

    return this.#mutate(() => {
      if (permission !== undefined && !caller.permissions.has(permission)) return this.#deny(caller, permission);
      return run();
    });
  }

  #spawn(appId: string, initOptions: unknown): SyscallResult<ProcessRecord> {
    const definition = this.#proc.getDefinition(appId);
    if (!definition) return failure('NOT_FOUND', `App is not registered: ${appId}`);

    const reservation = this.#invoke('kernel', 'proc.permission-policy-error', () => this.#proc.spawn(appId, this.#nowMs));
    if (!reservation.ok) return reservation;
    if (!reservation.data.ok) return reservation.data;

    const { pid, grantedPermissions } = reservation.data.data;
    const ownerId = PROCESS_OWNER_PREFIX + pid;
    const handle = this.#createHandle(ownerId, pid, grantedPermissions);
    this.#log('info', ownerId, 'proc.spawn', appId);
    const created = this.#invoke(ownerId, 'proc.init-error', () => definition.createProcess({
      pid,
      handle,
      getNowMs: () => this.#nowMs,
      initOptions,
    }));
    if (!created.ok) {
      this.#kill(pid);
      return created;
    }

    const record = this.#proc.getRecord(pid);
    if (!record || record.status === 'terminated') {
      this.#invoke(ownerId, 'proc.terminate-error', () => created.data.onTerminate?.());
      return failure('INVALID_STATE', `Process ${pid} terminated during initialization.`);
    }
    this.#instances.set(pid, created.data);
    if (record.status === 'suspended') {
      this.#invoke(ownerId, 'proc.suspend-error', () => created.data.onSuspend?.());
    }

    const initialized = this.#proc.getRecord(pid);
    if (!initialized || initialized.status === 'terminated') {
      return failure('INVALID_STATE', `Process ${pid} terminated during initialization.`);
    }
    return success(initialized);
  }

  #setSuspended(pid: PID, suspended: boolean): SyscallResult<ProcessRecord> {
    const result = suspended ? this.#proc.suspend(pid) : this.#proc.resume(pid);
    if (!result.ok) return result;

    const ownerId = PROCESS_OWNER_PREFIX + pid;
    const instance = this.#instances.get(pid);
    const event = suspended ? 'proc.suspend' : 'proc.resume';
    this.#log('info', ownerId, event, result.data.appId);
    this.#invoke(ownerId, `${event}-error`, () => suspended ? instance?.onSuspend?.() : instance?.onResume?.());
    return success(this.#proc.getRecord(pid) ?? result.data);
  }

  #kill(pid: PID): SyscallResult<ProcessRecord> {
    const result = this.#proc.kill(pid, this.#nowMs);
    if (!result.ok) return result;

    const ownerId = PROCESS_OWNER_PREFIX + pid;
    const instance = this.#instances.get(pid);
    this.#instances.delete(pid);
    this.#ipc.unsubscribeByOwner(ownerId);
    this.#wm.destroyByPid(pid);
    if (this.#wm.releaseByPid(pid)) this.#log('info', ownerId, 'wm.input-lock.released', 'Process terminated.');
    this.#log('info', ownerId, 'proc.kill', result.data.appId);
    this.#invoke(ownerId, 'proc.terminate-error', () => instance?.onTerminate?.());
    return result;
  }

  #createSurface(caller: Caller, options: SurfaceOptions, targetPid: PID | undefined): SyscallResult<WindowSurface> {
    if (caller.pid !== null && caller.pid !== targetPid) {
      return this.#deny(caller, 'wm:surface', 'Surface creation must use the caller’s process ID.');
    }
    if (targetPid === undefined) return failure('INVALID_STATE', 'A surface must belong to a process.');
    const process = this.#proc.getRecord(targetPid);
    if (!process) return failure('NOT_FOUND', `Unknown process: ${targetPid}`);
    if (process.status === 'terminated') return failure('INVALID_STATE', 'A terminated process cannot own a surface.');
    return this.#changed(this.#wm.create(process, options));
  }

  #destroySurface(caller: Caller, id: string): SyscallResult<void> {
    const surface = this.#wm.getSurface(id);
    if (!surface) return failure('NOT_FOUND', `Unknown surface: ${id}`);
    if (caller.pid !== null && caller.pid !== surface.pid) {
      return this.#deny(caller, 'wm:surface', 'Only the owning process or a system client can destroy a surface.');
    }
    return this.#changed(this.#wm.destroy(id));
  }

  #deny(caller: Caller, permission: Permission, reason?: string): SyscallResult<never> {
    const detail = `${caller.ownerId} was denied ${permission}.` + (reason ? ` ${reason}` : '');
    this.#log('sec', caller.ownerId, 'syscall.denied', detail);
    return failure('PERMISSION_DENIED', detail);
  }

  #invoke<T>(source: string, event: string, callback: () => T): SyscallResult<T> {
    try {
      return success(callback());
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'A kernel callback failed.';
      this.#log('error', source, event, detail);
      return failure('INVALID_STATE', detail);
    }
  }

  #log(level: DmesgLevel, source: string, event: string, detail?: string): DmesgEntry {
    this.#dirty = true;
    return this.#ipc.writeDmesg(this.#nowMs, level, source, event, detail);
  }

  #changed<T>(result: SyscallResult<T>): SyscallResult<T> {
    if (result.ok) this.#dirty = true;
    return result;
  }

  #mutate<T>(run: () => T): T {
    this.#mutationDepth++;
    try {
      return run();
    } finally {
      this.#mutationDepth--;
      if (this.#mutationDepth === 0) this.#publishSnapshots();
    }
  }

  #publishSnapshots(): void {
    if (this.#publishing || !this.#dirty) return;
    this.#publishing = true;
    try {
      // Publish subscriber-triggered changes after every subscriber sees the current revision.
      while (this.#dirty) {
        this.#dirty = false;
        this.#revision++;
        this.#store.setState(this.#snapshot(), true);
      }
    } finally {
      this.#publishing = false;
    }
  }

  #snapshot(): KernelSnapshot {
    return Object.freeze({
      device: this.#hal.device,
      hardware: this.#hal.hardware,
      hal: this.#hal.getSnapshot(),
      nowMs: this.#nowMs,
      processes: this.#proc.getRecords(),
      surfaces: this.#wm.getSurfaces(),
      inputLock: this.#wm.getInputLock(),
      dmesg: this.#ipc.getDmesg(),
      vfsRoot: this.#vfs.getTree(),
      revision: this.#revision,
    });
  }
}
