export type PID = number;
export type DeviceType = 'phone';

export interface HardwareState {
  readonly volume: number;
  readonly volumeOverlayVisible: boolean;
  readonly brightness: number;
  readonly systemTime: string;
  readonly battery: number;
}

export interface InitialKernelState {
  readonly device: DeviceType;
  readonly hardware: HardwareState;
}

export type Permission =
  | 'hal:vibrate'
  | 'ipc:send'
  | 'ipc:subscribe'
  | 'vfs:read'
  | 'vfs:write'
  | 'proc:spawn'
  | 'proc:kill'
  | 'proc:control'
  | 'wm:input-lock'
  | 'wm:surface'
  | 'dmesg:write';

export type SurfaceLayer = 'system' | 'app' | 'overlay';

export interface WindowSurface {
  readonly id: string;
  readonly pid: PID;
  readonly appId: string;
  readonly layer: SurfaceLayer;
  readonly zIndex: number;
  readonly title: string;
  readonly visible: boolean;
}

export interface SurfaceOptions {
  readonly id: string;
  readonly layer?: SurfaceLayer;
  readonly zIndex?: number;
  readonly title?: string;
  readonly visible?: boolean;
}

export interface InputLockState {
  readonly locked: boolean;
  readonly ownerId: string | null;
  readonly ownerPid: PID | null;
  readonly reason: string | null;
  readonly acquiredAtMs: number | null;
}

export type ProcessStatus = 'running' | 'suspended' | 'terminated';

export interface ProcessRecord {
  readonly pid: PID;
  readonly appId: string;
  readonly name: string;
  readonly status: ProcessStatus;
  readonly layer: SurfaceLayer;
  readonly grantedPermissions: readonly Permission[];
  readonly hiddenPermissions: readonly string[];
  readonly spawnedAtMs: number;
  readonly terminatedAtMs: number | null;
}

export interface VFileNode {
  readonly type: 'file';
  readonly name: string;
  readonly content: string;
}

export interface VDirNode {
  readonly type: 'dir';
  readonly name: string;
  readonly children: readonly VNode[];
}

export type VNode = VFileNode | VDirNode;

export interface VDirEntry {
  readonly type: VNode['type'];
  readonly name: string;
}

export type DmesgLevel = 'info' | 'warn' | 'sec' | 'error';

export interface DmesgEntry {
  readonly seq: number;
  readonly timestampMs: number;
  readonly level: DmesgLevel;
  readonly source: string;
  readonly event: string;
  readonly detail?: string;
}

export interface IpcMessage {
  readonly seq: number;
  readonly topic: string;
  readonly senderId: string;
  readonly senderPid: PID | null;
  readonly timestampMs: number;
  readonly payload: unknown;
}

export type IpcHandler = (message: IpcMessage) => void;

export type SyscallErrorCode =
  | 'PERMISSION_DENIED'
  | 'UNSUPPORTED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'PROCESS_SUSPENDED';

export type SyscallResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: SyscallErrorCode; readonly message: string };

export function success<T>(data: T): SyscallResult<T> {
  return { ok: true, data };
}

export function failure(code: SyscallErrorCode, message: string): SyscallResult<never> {
  return { ok: false, code, message };
}

export interface AppManifest {
  readonly appId: string;
  readonly name: string;
  readonly version: string;
  readonly defaultLayer: SurfaceLayer;
  readonly singleton?: boolean;
  readonly requestedPermissions: readonly Permission[];
  readonly hiddenPermissions?: readonly string[];
}

export interface AppProcessContext<TInit = unknown> {
  readonly pid: PID;
  readonly handle: SyscallHandle;
  readonly getNowMs: () => number;
  readonly initOptions?: TInit;
}

export interface AppProcessInstance<TState = unknown> {
  readonly getState: () => TState;
  readonly onTick?: (dtMs: number, nowMs: number) => void;
  readonly onAction?: (action: KernelAction) => boolean | void;
  readonly onSuspend?: () => void;
  readonly onResume?: () => void;
  readonly onTerminate?: () => void;
}

export interface AppDefinition<TState = unknown, TInit = unknown> {
  readonly manifest: AppManifest;
  readonly createProcess: (ctx: AppProcessContext<TInit>) => AppProcessInstance<TState>;
}

export interface KernelAction {
  readonly type: string;
  readonly payload?: unknown;
}

export interface DispatchResult {
  readonly accepted: boolean;
  readonly blockedBy?: 'INPUT_LOCK' | 'NO_HANDLER' | 'PROCESS_SUSPENDED' | 'INVALID_TARGET';
  readonly handledBy?: string;
}

export interface SyscallHandle {
  readonly ownerId: string;
  readonly pid: PID | null;
  readonly permissions: readonly Permission[];
  readonly halVibrate: (patternMs: readonly number[]) => SyscallResult<HalVibrationEvent>;
  readonly halGetHardware: () => SyscallResult<HardwareState>;
  readonly ipcPublish: (topic: string, payload?: unknown) => SyscallResult<IpcMessage>;
  readonly ipcSubscribe: (topic: string, handler: IpcHandler) => SyscallResult<() => void>;
  readonly vfsList: (path: string) => SyscallResult<readonly VDirEntry[]>;
  readonly vfsRead: (path: string) => SyscallResult<string>;
  readonly vfsWrite: (path: string, content: string) => SyscallResult<void>;
  readonly procSpawn: (appId: string, initOptions?: unknown) => SyscallResult<ProcessRecord>;
  readonly procSuspend: (pid: PID) => SyscallResult<ProcessRecord>;
  readonly procResume: (pid: PID) => SyscallResult<ProcessRecord>;
  readonly procKill: (pid: PID) => SyscallResult<ProcessRecord>;
  readonly wmAcquireInputLock: (reason: string) => SyscallResult<InputLockState>;
  readonly wmReleaseInputLock: () => SyscallResult<void>;
  readonly wmCreateSurface: (options: SurfaceOptions, targetPid?: PID) => SyscallResult<WindowSurface>;
  readonly wmDestroySurface: (id: string) => SyscallResult<void>;
  readonly dmesgWrite: (level: DmesgLevel, event: string, detail?: string) => SyscallResult<DmesgEntry>;
}

export interface HalVibrationEvent {
  readonly seq: number;
  readonly timestampMs: number;
  readonly patternMs: readonly number[];
}

export interface HalStateSnapshot {
  readonly lastVibration: HalVibrationEvent | null;
  readonly vibrationCount: number;
  readonly history: readonly HalVibrationEvent[];
}

export interface KernelSnapshot {
  readonly device: DeviceType;
  readonly hardware: HardwareState;
  readonly hal: HalStateSnapshot;
  readonly nowMs: number;
  readonly processes: readonly ProcessRecord[];
  readonly surfaces: readonly WindowSurface[];
  readonly inputLock: InputLockState;
  readonly dmesg: readonly DmesgEntry[];
  readonly vfsRoot: VDirNode;
  readonly revision: number;
}
