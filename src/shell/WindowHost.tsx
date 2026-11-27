import { LockScreenApp } from '../apps/lockscreen/LockScreenApp.tsx';
import { LOCKSCREEN_APP_ID } from '../apps/lockscreen/manifest.ts';
import { PET_APP_ID } from '../apps/pet/manifest.ts';
import { PetView } from '../apps/pet/PetView.tsx';
import { useKernelSelector } from '../bridge/useKernel.ts';

const views = new Map([
  [LOCKSCREEN_APP_ID, LockScreenApp],
  [PET_APP_ID, PetView],
]);

export function WindowHost() {
  const processes = useKernelSelector((snapshot) => snapshot.processes);
  const surfaces = useKernelSelector((snapshot) => snapshot.surfaces);

  return surfaces.map((surface) => {
    const View = views.get(surface.appId);
    if (!surface.visible || !View || !processes.some(({ pid, status }) => pid === surface.pid && status !== 'terminated')) {
      return null;
    }

    // Isolate each surface so descendant z-index values cannot reorder the WM stack.
    return (
      <div key={`${surface.id}:${surface.pid}`} data-surface={surface.id}
        className="pointer-events-none absolute inset-0 isolate">
        <View />
      </div>
    );
  });
}
