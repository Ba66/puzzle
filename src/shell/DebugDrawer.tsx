import { useEffect, useState } from 'react';
import { ChevronRight, FileCode2, Folder, RotateCcw, Terminal, X } from 'lucide-react';
import { useDirectorSnapshot, useKernelSelector, useLayoutMetrics, usePetState, useRuntime } from '../bridge/useKernel.ts';
import type { DmesgLevel, VFileNode, VNode } from '../kernel/types.ts';

const tabs = ['Processes', 'VFS', 'dmesg'] as const;
type Tab = (typeof tabs)[number];

const processColors = {
  running: 'text-emerald-300 bg-emerald-400/10',
  suspended: 'text-amber-300 bg-amber-400/10',
  terminated: 'text-slate-400 bg-slate-400/10',
};

const logColors = {
  info: 'text-cyan-200 bg-cyan-400/10',
  warn: 'text-amber-200 bg-amber-400/10',
  sec: 'text-violet-200 bg-violet-400/10',
  error: 'text-rose-200 bg-rose-400/10',
} satisfies Record<DmesgLevel, string>;

function ProcessPanel() {
  const { flowMode, introStage, epoch, introElapsedMs } = useDirectorSnapshot();
  const inputLock = useKernelSelector((state) => state.inputLock);
  const processes = useKernelSelector((state) => state.processes);
  const pet = usePetState();
  const { aspectRatio, floorYNorm } = useLayoutMetrics();
  const telemetry = pet && {
    fsm: pet.fsm, expression: pet.expression,
    x: pet.x, y: pet.y, ix: pet.ix, iy: pet.iy,
    vxIso: pet.vxIso, vyIso: pet.vyIso, tiltDeg: pet.tiltDeg, aspectRatio, floorYNorm,
  };

  return (
    <div className="space-y-5">
      <section className="debug-card">
        <h3 className="debug-section-title">Director</h3>
        <dl className="debug-pairs">
          <dt>flowMode</dt><dd>{flowMode}</dd>
          <dt>introStage</dt><dd>{introStage}</dd>
          <dt>epoch</dt><dd>{epoch}</dd>
          <dt>introElapsedMs</dt><dd>{Math.round(introElapsedMs)} ms</dd>
          <dt>inputLock</dt>
          <dd><span className={`debug-badge ${inputLock.locked ? 'bg-amber-400/10 text-amber-200' : 'bg-emerald-400/10 text-emerald-300'}`}>
            {inputLock.locked ? 'locked' : 'unlocked'}
          </span></dd>
          <dt>ownerId</dt><dd>{inputLock.ownerId ?? '—'}</dd>
          <dt>reason</dt><dd>{inputLock.reason ?? '—'}</dd>
        </dl>
      </section>

      <section className="debug-card">
        <h3 className="debug-section-title">Pet telemetry</h3>
        {telemetry ? (
          <dl className="debug-pairs">
            {Object.entries(telemetry).map(([name, value]) => (
              <div key={name} className="contents">
                <dt>{name}</dt><dd>{typeof value === 'number' ? value.toFixed(3) : value}</dd>
              </div>
            ))}
          </dl>
        ) : <p className="text-xs text-slate-400">Waiting for unknown.pet</p>}
      </section>

      <div className="overflow-x-auto rounded-xl border border-slate-700/65">
        <table className="w-full table-auto text-left font-mono text-[10px]">
          <caption className="sr-only">Process table</caption>
          <thead className="border-b border-slate-700/65 bg-slate-800/50 text-slate-300">
            <tr>
              <th className="p-2">PID</th><th className="p-2">App</th><th className="p-2">Status</th>
              <th className="p-2">Layer</th><th className="p-2">Permissions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {processes.map((process) => (
              <tr key={process.pid} className="align-top">
                <td className="p-2 text-slate-400">{process.pid}</td>
                <th scope="row" className="p-2 font-medium text-slate-100">{process.appId}</th>
                <td className="p-2"><span className={`debug-badge ${processColors[process.status]}`}>{process.status}</span></td>
                <td className="p-2 text-slate-400">{process.layer}</td>
                <td className="space-y-2 p-2">
                  <div>
                    <p className="mb-1 text-slate-400">Granted</p>
                    <ul className="space-y-0.5 text-cyan-100/90">
                      {process.grantedPermissions.map((permission) => <li key={permission}>{permission}</li>)}
                      {process.grantedPermissions.length === 0 && <li>—</li>}
                    </ul>
                  </div>
                  {process.hiddenPermissions.length > 0 && (
                    <div className="border-l border-violet-400/50 pl-1.5 text-violet-200">
                      <p className="mb-1 font-semibold">Hidden · Anomaly</p>
                      <ul className="space-y-0.5">
                        {process.hiddenPermissions.map((permission) => <li key={permission}>{permission}</li>)}
                      </ul>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Selection { path: string; file: VFileNode }

function VfsNode({ node, path, selected, onSelect }: {
  node: VNode;
  path: string;
  selected: string | undefined;
  onSelect: (selection: Selection) => void;
}) {
  if (node.type === 'file') {
    return (
      <button type="button" aria-pressed={selected === path} onClick={() => onSelect({ path, file: node })}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-slate-300 hover:bg-slate-800 aria-pressed:bg-cyan-400/10 aria-pressed:text-cyan-100">
        <FileCode2 size={13} className="shrink-0 text-slate-400" aria-hidden="true" />
        <span className="break-all">{node.name}</span>
      </button>
    );
  }

  return (
    <details className="group" open={path === '/' ? true : undefined}>
      <summary className="debug-folder flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-slate-200 hover:bg-slate-800">
        <ChevronRight size={12} className="debug-folder-chevron text-slate-400" aria-hidden="true" />
        <Folder size={13} className="text-cyan-300" aria-hidden="true" />{node.name}
      </summary>
      <ul className="ml-3 border-l border-slate-700/65 pl-2">
        {node.children.map((child) => (
          <li key={child.name}>
            <VfsNode node={child} path={`${path === '/' ? '' : path}/${child.name}`} selected={selected} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function VfsPanel() {
  const root = useKernelSelector((state) => state.vfsRoot);
  const [selection, setSelection] = useState<Selection>();
  return (
    <div className="space-y-4">
      <div className="debug-card font-mono text-xs" aria-label="VFS tree">
        <VfsNode node={root} path="/" selected={selection?.path} onSelect={setSelection} />
      </div>
      {selection ? (
        <div className="debug-card space-y-3" data-testid="debug-vfs-file">
          <h3 className="break-all font-mono text-xs text-cyan-200">{selection.path}</h3>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-200">
            {selection.file.content}
          </pre>
        </div>
      ) : <p className="px-1 text-xs text-slate-400">Select a file to read its contents.</p>}
    </div>
  );
}

function LogPanel() {
  const log = useKernelSelector((state) => state.dmesg);
  return (
    <ol className="space-y-2 font-mono text-[11px] leading-relaxed" aria-label="Kernel log, newest first">
      {[...log].reverse().map((entry) => (
        <li key={entry.seq} className="rounded-xl border border-slate-700/65 bg-slate-900/60 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-400">
            <span>#{entry.seq}</span>
            <time>{Math.round(entry.timestampMs)} ms</time>
            <span className={`debug-badge uppercase ${logColors[entry.level]}`}>{entry.level}</span>
            <span>{entry.source}</span>
          </div>
          <p className="mt-1 break-words text-slate-100">{entry.event}</p>
          {entry.detail && <p className="break-words text-slate-400">{entry.detail}</p>}
        </li>
      ))}
    </ol>
  );
}

export function DebugDrawer() {
  const { kernel } = useRuntime();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('Processes');

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  return (
    <div className="pointer-events-none fixed inset-0 z-50" onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}>
      <button type="button" data-testid="debug-toggle" aria-expanded={open} aria-controls="phone-debug-drawer"
        onClick={() => setOpen(!open)}
        className="debug-toggle pointer-events-auto absolute flex items-center gap-2 rounded-full border border-slate-600/80 bg-slate-900/90 px-3 py-2 text-xs font-medium text-slate-200 shadow-lg backdrop-blur-md hover:border-cyan-300/55 hover:text-cyan-100">
        {open ? <X size={14} aria-hidden="true" /> : <Terminal size={14} aria-hidden="true" />}
        调试
      </button>

      {open && (
        <aside id="phone-debug-drawer" data-testid="debug-drawer" aria-label="PhoneOS diagnostics"
          className="debug-drawer pointer-events-auto absolute flex touch-pan-y flex-col overflow-y-auto overscroll-contain rounded-2xl border border-slate-600/80 bg-slate-950/95 text-slate-100 shadow-2xl backdrop-blur-xl select-text">
          <header className="sticky top-0 z-10 space-y-3 border-b border-slate-700/65 bg-slate-950/95 px-4 pt-4 pb-3 backdrop-blur-md">
            <div className="flex items-center justify-between gap-2">
              <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
                <Terminal size={15} className="text-cyan-300" aria-hidden="true" /> PhoneOS 调试
              </h2>
              <button type="button" data-testid="debug-replay-btn"
                onClick={() => kernel.dispatch({ type: 'TRIGGER_INTRO_RIFT', payload: { reason: 'debug_replay' } })}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-cyan-300/40 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/20">
                <RotateCcw size={14} aria-hidden="true" /> 重播开场
              </button>
            </div>
            <nav className="flex gap-1 rounded-lg bg-slate-900 p-1" aria-label="Diagnostics views">
              {tabs.map((name) => (
                <button key={name} type="button" aria-pressed={tab === name} onClick={() => setTab(name)}
                  className="flex-1 rounded-md px-2 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 aria-pressed:bg-slate-700/70 aria-pressed:text-slate-100">
                  {name}
                </button>
              ))}
            </nav>
          </header>
          <div className="p-4">
            {tab === 'Processes' && <ProcessPanel />}
            {tab === 'VFS' && <VfsPanel />}
            {tab === 'dmesg' && <LogPanel />}
          </div>
        </aside>
      )}
    </div>
  );
}
