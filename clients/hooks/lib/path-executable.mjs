import { dirname, parse, sep } from 'node:path';

const NETWORK_FILESYSTEMS = new Set([
  '9p',
  'afs',
  'beegfs',
  'ceph',
  'cifs',
  'coda',
  'curlftpfs',
  'davfs',
  'davfs2',
  'glusterfs',
  'gpfs',
  'gvfsd-fuse',
  'lustre',
  'ncpfs',
  'nfs',
  'nfs4',
  'orangefs',
  'rclone',
  's3fs',
  'smb2',
  'smb3',
  'smbfs',
  'smbnetfs',
  'sshfs',
]);

export function readMountTable(platform, storage) {
  if (platform !== 'linux') return [];
  try {
    const mounts = new Map();
    for (const line of storage.readFileSync('/proc/self/mountinfo', 'utf-8').split('\n')) {
      const [fields, filesystem] = line.split(' - ', 2);
      const mount = fields.split(' ', 6)[4];
      const type = filesystem?.split(' ', 1)[0];
      if (!mount || !type) continue;
      const point = mount.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
      const network = NETWORK_FILESYSTEMS.has(type.replace(/^fuse(?:blk)?\./, ''));
      const kind = network ? 'network' : type.startsWith('fuse') || type === 'autofs' ? 'unknown' : 'local';
      if (mounts.get(point) !== 'network') mounts.set(point, kind);
    }
    return [...mounts].sort(([a], [b]) => b.length - a.length);
  } catch {
    return [];
  }
}

function mountKind(path, mounts) {
  return (
    mounts.find(([point]) => path === point || path.startsWith(point === '/' ? '/' : point + '/'))?.[1] ?? 'unknown'
  );
}

function isLocalExecutable(path, storage, mounts) {
  if (mountKind(dirname(path), mounts) !== 'local' || mountKind(path, mounts) !== 'local') return false;

  const { root } = parse(path);
  let prefix = root;
  try {
    // Following an unchecked ancestor could take this syscall onto a remote mount.
    for (const component of path.slice(root.length).split(sep)) {
      prefix += (prefix === root ? '' : sep) + component;
      if (mountKind(prefix, mounts) !== 'local') return false;
      const entry = storage.lstatSync(prefix);
      if (entry.isSymbolicLink()) return false;
      if (prefix === path ? !entry.isFile() : !entry.isDirectory()) return false;
    }
    storage.assertExecutableSync(path);
    return true;
  } catch {
    return false;
  }
}

export function findLocalExecutable(paths, storage, mounts) {
  for (const path of paths) {
    if (isLocalExecutable(path, storage, mounts)) return path;
  }
  return null;
}
