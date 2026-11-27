import { failure, success } from './types.ts';
import type { SyscallResult, VDirEntry, VDirNode, VFileNode, VNode } from './types.ts';

function file(name: string, content: string): VFileNode {
  return Object.freeze({ type: 'file', name, content });
}

function directory(name: string, ...children: VNode[]): VDirNode {
  return Object.freeze({ type: 'dir', name, children: Object.freeze(children) });
}

const root = directory('/',
  directory('system',
    file('os.conf', 'device=phone\nlayout=single\nclock=logical\nboot_target=lockscreen\n'),
    file('permissions.policy', 'default=deny\ngrant=manifest.requestedPermissions + host approval\nhiddenPermissions=metadata only\n'),
  ),
  directory('proc',
    file('README.txt', 'Process records are maintained by the live scheduler. This mounted image is read-only.\n'),
  ),
  directory('var', directory('log',
    file('boot.log', '[boot] Phone hardware profile loaded.\n[boot] Read-only system image mounted.\n[boot] Live kernel events are available in dmesg.\n'),
  )),
  directory('apps',
    directory('lockscreen', file('manifest.json', JSON.stringify({
      appId: 'system.lockscreen',
      name: 'Lock Screen',
      version: '1.0.0',
      defaultLayer: 'system',
      singleton: true,
      requestedPermissions: ['hal:vibrate', 'ipc:send', 'ipc:subscribe', 'dmesg:write'],
    }, null, 2) + '\n')),
    directory('unknown.pet',
      file('anomaly.note', 'Origin: unverified. The package index preserves its identifier, but the signature field is empty.\n'),
    ),
  ),
  directory('home', directory('user',
    file('notes.txt', 'Charge the phone. The slider sticks again after a cold boot.\n'),
  )),
);

export class Vfs {
  getTree(): VDirNode {
    return root;
  }

  list(path: string): SyscallResult<readonly VDirEntry[]> {
    const result = this.#lookup(path);
    if (!result.ok) return result;
    if (result.data.type !== 'dir') {
      return failure('INVALID_STATE', `Path is not a directory: ${path}`);
    }

    const entries = result.data.children.map(({ type, name }) => Object.freeze({ type, name }));
    return success(Object.freeze(entries));
  }

  read(path: string): SyscallResult<string> {
    const result = this.#lookup(path);
    if (!result.ok) return result;
    if (result.data.type !== 'file') {
      return failure('INVALID_STATE', `Path is not a file: ${path}`);
    }

    return success(result.data.content);
  }

  write(_path: string, _content: string): SyscallResult<void> {
    return failure('UNSUPPORTED', 'The file system is read-only.');
  }

  unlock(_path: string): SyscallResult<void> {
    return failure('UNSUPPORTED', 'File system unlocking is unavailable.');
  }

  #lookup(path: string): SyscallResult<VNode> {
    if (typeof path !== 'string' || path.includes('\0')) {
      return failure('INVALID_STATE', 'Invalid file system path.');
    }

    const segments: string[] = [];
    for (const segment of path.split('/')) {
      if (segment === '..') segments.pop();
      else if (segment !== '' && segment !== '.') segments.push(segment);
    }

    let node: VNode = root;
    for (const segment of segments) {
      if (node.type !== 'dir') return failure('NOT_FOUND', `No such path: ${path}`);

      const child: VNode | undefined = node.children.find(({ name }) => name === segment);
      if (!child) return failure('NOT_FOUND', `No such path: ${path}`);
      node = child;
    }

    return success(node);
  }
}
