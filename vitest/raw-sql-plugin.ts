import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

function sqlFilePath(id: string): string | null {
  const [withoutHash] = id.split('#');
  const [filePath] = withoutHash.split('?');
  return filePath.endsWith('.sql') ? filePath : null;
}

export function rawSqlPlugin(): Plugin {
  return {
    name: 'raw-sql',
    enforce: 'pre',
    async load(id) {
      const filePath = sqlFilePath(id);
      if (filePath === null) {
        return null;
      }

      const content = await readFile(filePath, 'utf8');
      return `export default ${JSON.stringify(content)};`;
    },
  };
}
