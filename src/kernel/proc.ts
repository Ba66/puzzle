import { failure, success } from './types.ts';
import type {
  AppDefinition,
  AppManifest,
  AppProcessContext,
  Permission,
  PID,
  ProcessRecord,
  ProcessStatus,
  SyscallResult,
} from './types.ts';

export type PermissionPolicy = (permission: Permission, manifest: AppManifest) => boolean;

const noHiddenPermissions: readonly string[] = Object.freeze([]);

export class Proc {
  readonly #permissionPolicy: PermissionPolicy;
  readonly #apps = new Map<string, AppDefinition>();
  readonly #records = new Map<PID, ProcessRecord>();
  #nextPid = 1;
  #recordsSnapshot: readonly ProcessRecord[] | undefined;

  constructor(permissionPolicy: PermissionPolicy = () => true) {
    this.#permissionPolicy = permissionPolicy;
  }

  registerApp<TState, TInit>(definition: AppDefinition<TState, TInit>): SyscallResult<void> {
    const { manifest, createProcess } = definition;
    if (!manifest.appId.trim()) return failure('INVALID_STATE', 'An app needs an ID.');
    if (this.#apps.has(manifest.appId)) {
      return failure('INVALID_STATE', `App already registered: ${manifest.appId}`);
    }

    const registered: AppDefinition = {
      manifest: Object.freeze({
        ...manifest,
        requestedPermissions: Object.freeze([...manifest.requestedPermissions]),
        ...(manifest.hiddenPermissions && { hiddenPermissions: Object.freeze([...manifest.hiddenPermissions]) }),
      }),
      // Initialization data comes from the caller of procSpawn and is application-defined.
      createProcess: (context) => createProcess.call(definition, context as AppProcessContext<TInit>),
    };
    this.#apps.set(manifest.appId, Object.freeze(registered));
    return success(undefined);
  }

  getDefinition(appId: string): AppDefinition | undefined {
    return this.#apps.get(appId);
  }

  getManifest(appId: string): AppManifest | undefined {
    return this.#apps.get(appId)?.manifest;
  }

  listRegisteredApps(): readonly AppManifest[] {
    return Object.freeze(Array.from(this.#apps.values(), ({ manifest }) => manifest));
  }

  getRecord(pid: PID): ProcessRecord | undefined {
    return this.#records.get(pid);
  }

  getRecords(): readonly ProcessRecord[] {
    return this.#recordsSnapshot ??= Object.freeze([...this.#records.values()]);
  }

  findRunningProcessByAppId(appId: string): ProcessRecord | undefined {
    for (const record of this.#records.values()) {
      if (record.appId === appId && record.status === 'running') return record;
    }
  }

  findActiveProcessByAppId(appId: string): ProcessRecord | undefined {
    let suspended: ProcessRecord | undefined;
    for (const record of this.#records.values()) {
      if (record.appId !== appId) continue;
      if (record.status === 'running') return record;
      if (record.status === 'suspended') suspended ??= record;
    }
    return suspended;
  }

  spawn(appId: string, nowMs: number): SyscallResult<ProcessRecord> {
    const manifest = this.getManifest(appId);
    if (!manifest) return failure('NOT_FOUND', `App is not registered: ${appId}`);

    const hiddenPermissions = manifest.hiddenPermissions ?? noHiddenPermissions;
    const grantedPermissions = [...new Set(manifest.requestedPermissions)].filter((permission) =>
      !hiddenPermissions.includes(permission) && this.#permissionPolicy(permission, manifest),
    );
    if (manifest.singleton && this.findActiveProcessByAppId(appId)) {
      return failure('INVALID_STATE', `App already has an active process: ${appId}`);
    }

    const record: ProcessRecord = Object.freeze({
      pid: this.#nextPid++,
      appId,
      name: manifest.name,
      status: 'running',
      layer: manifest.defaultLayer,
      grantedPermissions: Object.freeze(grantedPermissions),
      hiddenPermissions,
      spawnedAtMs: nowMs,
      terminatedAtMs: null,
    });
    this.#records.set(record.pid, record);
    this.#recordsSnapshot = undefined;
    return success(record);
  }

  suspend(pid: PID): SyscallResult<ProcessRecord> {
    return this.#transition(pid, 'suspended', 'running', null);
  }

  resume(pid: PID): SyscallResult<ProcessRecord> {
    return this.#transition(pid, 'running', 'suspended', null);
  }

  kill(pid: PID, nowMs: number): SyscallResult<ProcessRecord> {
    return this.#transition(pid, 'terminated', undefined, nowMs);
  }

  #transition(
    pid: PID,
    status: ProcessStatus,
    requiredStatus: ProcessStatus | undefined,
    terminatedAtMs: number | null,
  ): SyscallResult<ProcessRecord> {
    const record = this.#records.get(pid);
    if (!record) return failure('NOT_FOUND', `Unknown process: ${pid}`);
    if (record.status === 'terminated' || (requiredStatus && record.status !== requiredStatus)) {
      return failure('INVALID_STATE', `Cannot change process ${pid} from ${record.status} to ${status}.`);
    }

    const updated = Object.freeze({ ...record, status, terminatedAtMs });
    this.#records.set(pid, updated);
    this.#recordsSnapshot = undefined;
    return success(updated);
  }
}
