import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/Kernel.ts';
import { Proc } from '../src/kernel/proc.ts';
import type {
  AppManifest,
  InitialKernelState,
  IpcMessage,
  Permission,
  SyscallHandle,
  SyscallResult,
} from '../src/kernel/types.ts';
import { Vfs } from '../src/kernel/vfs.ts';

const initial: InitialKernelState = {
  device: 'phone',
  hardware: { volume: 50, volumeOverlayVisible: false, brightness: 80, systemTime: '00:00', battery: 3 },
};

const manifest: AppManifest = {
  appId: 'example', name: 'Example', version: '1.0.0', defaultLayer: 'app', requestedPermissions: [],
};

function data<T>(result: SyscallResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
}

describe('headless kernel', () => {
  it('exposes immutable snapshots and publishes nested observer changes in revision order', () => {
    const kernel = new Kernel(initial);
    const first = kernel.getSnapshot();
    expect(first).toMatchObject({ device: 'phone', hardware: initial.hardware, nowMs: 0, revision: 0 });
    expect(first.hardware).not.toBe(initial.hardware);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.hardware)).toBe(true);
    expect(kernel.getStore()).not.toHaveProperty('setState');

    const observer = kernel.createSystemHandle('observer', ['dmesg:write']);
    const revisions: number[][] = [];
    const unsubscribe = kernel.subscribe((snapshot) => {
      if (snapshot.revision === 1) data(observer.dmesgWrite('info', 'observed'));
    });
    kernel.getStore().subscribe((snapshot, prior) => revisions.push([prior.revision, snapshot.revision]));
    kernel.step(7.5);
    unsubscribe();

    const current = kernel.getSnapshot();
    expect(revisions).toEqual([[0, 1], [1, 2]]);
    expect(current.nowMs).toBe(7.5);
    expect(current.dmesg[0]?.timestampMs).toBe(7.5);
    expect(current.processes).toBe(first.processes);
    expect(first.dmesg).toEqual([]);
  });

  it('rejects negative, non-finite, and overflowing steps without advancing time', () => {
    const kernel = new Kernel(initial);
    const first = kernel.getSnapshot();
    for (const dtMs of [-1, NaN, Infinity, -Infinity]) {
      expect(() => kernel.step(dtMs)).toThrow(RangeError);
      expect(kernel.getSnapshot()).toBe(first);
    }
    kernel.step(0);
    expect(kernel.getSnapshot()).toMatchObject({ nowMs: 0, revision: 1 });
    kernel.step(Number.MAX_VALUE);
    expect(() => kernel.step(Number.MAX_VALUE)).toThrow(RangeError);
    expect(kernel.getSnapshot().nowMs).toBe(Number.MAX_VALUE);
  });

  it('binds capabilities to handles, applies host policy, and logs permission denials', () => {
    const kernel = new Kernel(initial, { permissionPolicy: (permission) => permission !== 'hal:vibrate' });
    const grants: Permission[] = ['proc:spawn'];
    const host = kernel.createSystemHandle('host', grants);
    grants.push('vfs:write');
    const requested: Permission[] = ['vfs:read', 'vfs:read', 'hal:vibrate', 'vfs:write'];
    const hidden = ['vfs:write', 'unknown-capability'];
    data(kernel.registerApp({
      manifest: { ...manifest, requestedPermissions: requested, hiddenPermissions: hidden },
      createProcess: ({ handle }) => ({ getState: () => handle }),
    }));
    requested.push('proc:spawn');
    hidden.push('vfs:read');
    const process = data(host.procSpawn(manifest.appId));
    const handle = kernel.getProcessState<SyscallHandle>(process.pid)!;

    expect(process.grantedPermissions).toEqual(['vfs:read']);
    expect(process.hiddenPermissions).toEqual(['vfs:write', 'unknown-capability']);
    expect(Object.isFrozen(handle.permissions)).toBe(true);
    expect(() => kernel.createSystemHandle(handle.ownerId, ['ipc:send'])).toThrow(RangeError);
    expect(handle.vfsRead('/system/os.conf').ok).toBe(true);
    expect(handle.halGetHardware()).toEqual({ ok: true, data: initial.hardware });
    expect(handle.halVibrate([10])).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(handle.vfsWrite('/home/user/notes.txt', '')).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(host.vfsWrite('/home/user/notes.txt', '')).toMatchObject({ code: 'PERMISSION_DENIED' });
    const writer = kernel.createSystemHandle('writer', ['vfs:write']);
    expect(writer.vfsWrite('/missing', '')).toMatchObject({ code: 'UNSUPPORTED' });
    expect(kernel.getSnapshot().dmesg.filter(({ level }) => level === 'sec')).toEqual([
      expect.objectContaining({ source: handle.ownerId, event: 'syscall.denied', detail: expect.stringContaining('hal:vibrate') }),
      expect.objectContaining({ source: handle.ownerId, event: 'syscall.denied', detail: expect.stringContaining('vfs:write') }),
      expect.objectContaining({ source: host.ownerId, event: 'syscall.denied', detail: expect.stringContaining('vfs:write') }),
    ]);
  });

  it('normalizes VFS paths and keeps the complete mounted image read-only', () => {
    const vfs = new Vfs();
    const paths = [
      '/system/os.conf', '/system/permissions.policy', '/proc/README.txt', '/var/log/boot.log',
      '/apps/lockscreen/manifest.json', '/apps/unknown.pet/anomaly.note', '/home/user/notes.txt',
    ];
    for (const path of paths) expect(data(vfs.read(path)).trim()).not.toBe('');
    expect(vfs.read('///../system/./other/../os.conf/')).toEqual(vfs.read(paths[0]!));
    expect(vfs.list('')).toEqual(vfs.list('/../../'));
    expect(vfs.read('/system')).toMatchObject({ code: 'INVALID_STATE' });
    expect(vfs.list('/system/os.conf')).toMatchObject({ code: 'INVALID_STATE' });
    expect(vfs.read('/system/os.conf/child')).toMatchObject({ code: 'NOT_FOUND' });
    expect(vfs.list('a\0b')).toMatchObject({ code: 'INVALID_STATE' });
    expect(vfs.unlock('/')).toMatchObject({ code: 'UNSUPPORTED' });
    expect(Object.isFrozen(vfs.getTree().children)).toBe(true);
  });

  it('routes actions and ticks only to running processes and never replays blocked input', () => {
    const kernel = new Kernel(initial);
    const host = kernel.createSystemHandle('host', ['proc:spawn', 'proc:control', 'wm:input-lock']);
    const calls: string[] = [];
    data(kernel.registerApp({
      manifest: { ...manifest, singleton: true },
      createProcess: ({ initOptions, getNowMs }) => ({
        getState: () => initOptions,
        onTick: (dtMs, nowMs) => calls.push(`process:${dtMs}:${nowMs}:${getNowMs()}`),
        onAction: () => { calls.push('action'); },
        onSuspend: () => calls.push('suspend'),
        onResume: () => calls.push('resume'),
      }),
    }));
    kernel.registerActionRoute('ACTION', { targetAppId: manifest.appId }, (action, instance) => instance?.onAction?.(action));
    kernel.registerActionRoute('DEBUG', { bypassInputLock: true }, () => { calls.push('debug'); });
    expect(kernel.dispatch({ type: 'ACTION' })).toEqual({ accepted: false, blockedBy: 'NO_HANDLER' });
    const process = data(host.procSpawn(manifest.appId, { seed: 4 }));
    expect(kernel.getProcessState(process.pid)).toEqual({ seed: 4 });
    kernel.addTickListener((dtMs, nowMs) => calls.push(`system:${dtMs}:${nowMs}`));
    data(host.wmAcquireInputLock('exclusive'));
    expect(kernel.dispatch({ type: 'ACTION' })).toEqual({ accepted: false, blockedBy: 'INPUT_LOCK' });
    expect(kernel.dispatch({ type: 'DEBUG' }).accepted).toBe(true);
    data(host.wmReleaseInputLock());
    data(host.procSuspend(process.pid));
    expect(host.procSpawn(manifest.appId)).toMatchObject({ code: 'INVALID_STATE' });
    expect(kernel.findActiveProcessByAppId(manifest.appId)?.status).toBe('suspended');
    expect(kernel.findRunningProcessByAppId(manifest.appId)).toBeUndefined();
    expect(kernel.dispatch({ type: 'ACTION' })).toEqual({ accepted: false, blockedBy: 'PROCESS_SUSPENDED' });
    kernel.step(5);
    data(host.procResume(process.pid));
    kernel.step(2);
    expect(kernel.dispatch({ type: 'ACTION', payload: { pid: 23, permissions: ['proc:kill'] } })).toEqual({
      accepted: true, handledBy: manifest.appId,
    });
    expect(calls).toEqual(['debug', 'suspend', 'system:5:5', 'resume', 'system:2:7', 'process:2:7:7', 'action']);
    const remove = kernel.registerActionRoute('DEBUG', {}, () => false);
    expect(kernel.dispatch({ type: 'DEBUG' })).toEqual({ accepted: false, blockedBy: 'INVALID_TARGET' });
    remove();
    expect(kernel.dispatch({ type: 'DEBUG' })).toEqual({ accepted: false, blockedBy: 'NO_HANDLER' });
  });

  it('skips processes terminated during a step and continues after a failing tick listener', () => {
    const kernel = new Kernel(initial);
    const host = kernel.createSystemHandle('host', ['proc:spawn', 'proc:kill']);
    const calls: number[] = [];
    data(kernel.registerApp({
      manifest,
      createProcess: ({ pid }) => ({
        getState: () => pid,
        onTick: () => {
          calls.push(pid);
          if (pid === 1) data(host.procKill(2));
        },
      }),
    }));
    data(host.procSpawn(manifest.appId));
    data(host.procSpawn(manifest.appId));
    let removeListener = () => {};
    kernel.addTickListener(() => { removeListener(); kernel.step(0); });
    removeListener = kernel.addTickListener(() => { throw new Error('removed listener should never run'); });
    kernel.step(10);
    expect(calls).toEqual([1]);
    expect(kernel.getSnapshot().nowMs).toBe(10);
    expect(kernel.getSnapshot().dmesg.filter(({ level }) => level === 'error')).toEqual([
      expect.objectContaining({ event: 'tick.listener-error', detail: 'Cannot step during a kernel operation.' }),
    ]);
  });

  it('orders surfaces by layer and stable z-index and prevents ownership spoofing', () => {
    const kernel = new Kernel(initial);
    const host = kernel.createSystemHandle('host', ['proc:spawn', 'wm:surface', 'wm:input-lock']);
    const other = kernel.createSystemHandle('other', ['wm:input-lock']);
    data(kernel.registerApp({
      manifest: { ...manifest, requestedPermissions: ['wm:surface'] },
      createProcess: ({ handle }) => ({ getState: () => handle }),
    }));
    const first = data(host.procSpawn(manifest.appId));
    const second = data(host.procSpawn(manifest.appId));
    const handle = kernel.getProcessState<SyscallHandle>(first.pid)!;
    data(host.wmCreateSurface({ id: 'overlay', layer: 'overlay', zIndex: -100 }, second.pid));
    data(handle.wmCreateSurface({ id: 'first', zIndex: 9 }));
    data(handle.wmCreateSurface({ id: 'second', zIndex: 9, visible: false }));
    data(host.wmCreateSurface({ id: 'system', layer: 'system', zIndex: 1000 }, second.pid));
    expect(kernel.getSnapshot().surfaces.map(({ id }) => id)).toEqual(['system', 'first', 'second', 'overlay']);
    expect(handle.wmCreateSurface({ id: 'first' })).toMatchObject({ code: 'INVALID_STATE' });
    expect(handle.wmCreateSurface({ id: 'wrong' }, second.pid)).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(handle.wmDestroySurface('overlay')).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(host.wmCreateSurface({ id: 'no-owner' })).toMatchObject({ code: 'INVALID_STATE' });
    data(handle.wmDestroySurface('first'));
    data(host.wmDestroySurface('overlay'));
    expect(kernel.getSnapshot().surfaces.map(({ id }) => id)).toEqual(['system', 'second']);
    kernel.step(3);
    const lock = data(host.wmAcquireInputLock('test'));
    expect(lock).toMatchObject({ ownerPid: null, ownerId: 'host', acquiredAtMs: 3 });
    expect(data(host.wmAcquireInputLock('retry'))).toBe(lock);
    expect(other.wmAcquireInputLock('competing')).toMatchObject({ code: 'INVALID_STATE' });
    expect(other.wmReleaseInputLock()).toMatchObject({ code: 'INVALID_STATE' });
    data(host.wmReleaseInputLock());
    expect(kernel.getSnapshot().inputLock.locked).toBe(false);
  });

  it('releases the lock, surfaces and IPC subscriptions on termination and revokes stale handles', () => {
    const kernel = new Kernel(initial);
    const host = kernel.createSystemHandle('host', ['proc:spawn', 'proc:control', 'proc:kill', 'ipc:send']);
    const received: IpcMessage[] = [];
    const terminated: string[] = [];
    data(kernel.registerApp({
      manifest: { ...manifest, requestedPermissions: ['ipc:subscribe', 'wm:surface', 'wm:input-lock'] },
      createProcess: ({ handle }) => {
        data(handle.ipcSubscribe('signal', (message) => { received.push(message); }));
        data(handle.wmCreateSurface({ id: 'owned' }));
        data(handle.wmAcquireInputLock('test'));
        return { getState: () => handle, onTerminate: () => { terminated.push(handle.ownerId); } };
      },
    }));
    const process = data(host.procSpawn(manifest.appId));
    const handle = kernel.getProcessState<SyscallHandle>(process.pid)!;
    expect(kernel.getSnapshot().inputLock.ownerPid).toBe(process.pid);
    expect(data(host.ipcPublish('signal', null)).seq).toBe(1);
    data(host.procSuspend(process.pid));
    expect(handle.halGetHardware()).toMatchObject({ code: 'PROCESS_SUSPENDED' });
    expect(handle.vfsWrite('/', '')).toMatchObject({ code: 'PROCESS_SUSPENDED' });
    data(host.ipcPublish('signal', 'ignored'));
    data(host.procResume(process.pid));
    kernel.step(4);
    data(host.ipcPublish('signal', 'resumed'));
    expect(data(host.procKill(process.pid))).toMatchObject({ status: 'terminated', terminatedAtMs: 4 });
    data(host.ipcPublish('signal', 'removed'));
    expect(received).toEqual([
      { seq: 1, topic: 'signal', senderId: 'host', senderPid: null, timestampMs: 0, payload: null },
      { seq: 3, topic: 'signal', senderId: 'host', senderPid: null, timestampMs: 4, payload: 'resumed' },
    ]);
    expect(terminated).toEqual([handle.ownerId]);
    expect(handle.halGetHardware()).toMatchObject({ code: 'INVALID_STATE' });
    expect(host.procKill(process.pid)).toMatchObject({ code: 'INVALID_STATE' });
    expect(kernel.getProcessState(process.pid)).toBeUndefined();
    expect(kernel.getSnapshot().surfaces).toEqual([]);
    expect(kernel.getSnapshot().inputLock.locked).toBe(false);
    expect(kernel.getSnapshot().dmesg.at(-1)).toMatchObject({ event: 'proc.kill', timestampMs: 4 });
    expect(data(host.procSpawn(manifest.appId)).pid).toBe(process.pid + 1);
  });

  it('handles subscription changes and faults during IPC delivery', () => {
    const kernel = new Kernel(initial);
    const client = kernel.createSystemHandle('client', ['ipc:send', 'ipc:subscribe']);
    const deliveries: string[] = [];
    let remove = () => {};
    data(client.ipcSubscribe('topic', () => {
      remove();
      data(client.ipcSubscribe('topic', () => { deliveries.push('new'); }));
      throw new Error('bad subscriber');
    }));
    remove = data(client.ipcSubscribe('topic', () => { deliveries.push('removed'); }));
    data(client.ipcSubscribe('topic', () => { deliveries.push('remaining'); }));
    data(client.ipcPublish('topic'));
    data(client.ipcPublish('topic'));
    expect(deliveries).toEqual(['remaining', 'remaining', 'new']);
    expect(kernel.getSnapshot().dmesg).toHaveLength(2);
    expect(kernel.getSnapshot().dmesg[0]).toMatchObject({ level: 'error', event: 'ipc.handler-error', detail: 'bad subscriber' });
  });

  it('rolls back resources when a process factory throws or terminates itself', () => {
    const kernel = new Kernel(initial);
    const host = kernel.createSystemHandle('host', ['proc:spawn', 'proc:kill', 'wm:input-lock', 'ipc:send']);
    let deliveries = 0;
    let terminations = 0;
    data(kernel.registerApp({
      manifest: { ...manifest, singleton: true, requestedPermissions: ['wm:surface', 'wm:input-lock', 'ipc:subscribe'] },
      createProcess: ({ pid, handle, initOptions }) => {
        data(handle.wmCreateSurface({ id: 'owned' }));
        data(handle.wmAcquireInputLock('test'));
        data(handle.ipcSubscribe('topic', () => { deliveries++; }));
        if (initOptions === 'throw') throw new Error('failed to initialize');
        data(host.procKill(pid));
        return { getState: () => pid, onTerminate: () => { terminations++; } };
      },
    }));
    expect(host.procSpawn(manifest.appId, 'throw')).toMatchObject({ code: 'INVALID_STATE', message: 'failed to initialize' });
    expect(host.procSpawn(manifest.appId, 'terminate')).toMatchObject({ code: 'INVALID_STATE' });
    data(host.ipcPublish('topic'));
    const snapshot = kernel.getSnapshot();
    expect(snapshot.processes.map(({ pid, status }) => [pid, status])).toEqual([[1, 'terminated'], [2, 'terminated']]);
    expect(snapshot.inputLock.locked).toBe(false);
    expect(snapshot.surfaces).toEqual([]);
    expect([deliveries, terminations]).toEqual([0, 1]);
  });

  it('validates vibration durations and records a bounded history independently of host failures', () => {
    const patterns: (readonly number[])[] = [];
    const kernel = new Kernel(initial, { onVibrate: (pattern) => {
      patterns.push(pattern);
      if (patterns.length === 1) throw new Error('vibration unavailable');
    } });
    const client = kernel.createSystemHandle('client', ['hal:vibrate']);
    const firstPattern = [40, 0, 10];
    kernel.step(8);
    const first = data(client.halVibrate(firstPattern));
    firstPattern[0] = 1;
    expect(first).toEqual({ seq: 1, timestampMs: 8, patternMs: [40, 0, 10] });
    expect(Object.isFrozen(patterns[0])).toBe(true);
    for (const pattern of [[-1], [NaN], [Infinity], new Array<number>(1)]) {
      expect(client.halVibrate(pattern)).toMatchObject({ code: 'INVALID_STATE' });
    }
    for (let index = 0; index < 40; index++) data(client.halVibrate([]));
    const snapshot = kernel.getSnapshot();
    expect(snapshot.hal).toMatchObject({ vibrationCount: 41, lastVibration: { seq: 41, patternMs: [] } });
    expect(snapshot.hal.history).toHaveLength(32);
    expect(snapshot.hal.history[0]?.seq).toBe(10);
    expect(snapshot.dmesg[0]).toMatchObject({ event: 'hal.host-error', timestampMs: 8 });
  });

  it('returns the newest 200 dmesg entries in sequence order after multiple wraps', () => {
    const kernel = new Kernel(initial);
    const client = kernel.createSystemHandle('client', ['dmesg:write']);
    for (let index = 0; index < 450; index++) {
      kernel.step(1);
      data(client.dmesgWrite('info', 'event'));
    }
    const entries = kernel.getSnapshot().dmesg;
    expect(entries.map(({ seq }) => seq)).toEqual(Array.from({ length: 200 }, (_, index) => index + 251));
    expect(entries[0]).toEqual({ seq: 251, timestampMs: 251, level: 'info', event: 'event', source: 'client' });
    expect(entries.at(-1)?.timestampMs).toBe(450);
  });

  it('reports duplicate registration and prefers running instances over suspended instances', () => {
    const proc = new Proc();
    const definition = { manifest, createProcess: () => ({ getState: () => null }) };
    data(proc.registerApp(definition));
    expect(proc.registerApp(definition)).toMatchObject({ code: 'INVALID_STATE' });
    expect(proc.listRegisteredApps()).toEqual([manifest]);
    expect(proc.getManifest(manifest.appId)).toEqual(manifest);
    expect(proc.spawn('missing', 0)).toMatchObject({ code: 'NOT_FOUND' });
    const first = data(proc.spawn(manifest.appId, 0));
    const second = data(proc.spawn(manifest.appId, 0));
    data(proc.suspend(first.pid));
    expect(proc.findActiveProcessByAppId(manifest.appId)).toBe(second);
    data(proc.kill(second.pid, 0));
    expect(proc.findActiveProcessByAppId(manifest.appId)?.pid).toBe(first.pid);
    expect(proc.findRunningProcessByAppId(manifest.appId)).toBeUndefined();
  });

  it('leaves no partially spawned process when the host permission policy throws', () => {
    let fail = true;
    const kernel = new Kernel(initial, { permissionPolicy: () => {
      if (fail) throw new Error('permission policy error');
      return true;
    } });
    const host = kernel.createSystemHandle('host', ['proc:spawn']);
    data(kernel.registerApp({
      manifest: { ...manifest, singleton: true, requestedPermissions: ['hal:vibrate'] },
      createProcess: () => ({ getState: () => null }),
    }));
    expect(host.procSpawn(manifest.appId)).toMatchObject({ code: 'INVALID_STATE' });
    expect(kernel.getSnapshot().processes).toEqual([]);
    expect(kernel.getSnapshot().dmesg.at(-1)).toMatchObject({ level: 'error', event: 'proc.permission-policy-error' });
    fail = false;
    expect(data(host.procSpawn(manifest.appId)).pid).toBe(1);
  });
});
