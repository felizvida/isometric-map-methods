// Inline a small ES-module graph into one classic-free HTML file that opens from disk (no server, no network).
// Each module becomes a function returning its exports; `import {a, b} from './x.mjs'` becomes `const {a, b} = M3;`.
// Supports only what this toolkit uses: relative named imports, `export function|class|const|let`. Node.js only.
import fs from 'node:fs';
import path from 'node:path';

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';\s*$/gm;
const EXPORT = /^export\s+(?:async\s+)?(function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;

export function bundleModules(entry) {
  const order = [], ids = new Map();
  (function visit(file) {
    if (ids.has(file)) return;
    ids.set(file, null);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT)) {
      if (!m[2].startsWith('.')) throw new Error(`${file}: only relative imports can be bundled (${m[2]})`);
      visit(path.resolve(path.dirname(file), m[2]));
    }
    ids.set(file, order.length);
    order.push({file, src});
  })(path.resolve(entry));
  return order.map(({file, src}, k) => {
    const names = [...src.matchAll(EXPORT)].map((m) => m[2]);
    const body = src.replace(IMPORT, (_, list, spec) => `const {${list.trim()}} = M${ids.get(path.resolve(path.dirname(file), spec))};`)
                    .replace(/^export\s+/gm, '');
    return `// ---- ${path.basename(file)}\nconst M${k} = (() => {\n${body}\nreturn {${names.join(', ')}};\n})();`;
  }).join('\n');
}

/** index.html with its module script replaced by the bundle and `data` assigned to window.SCENE first. */
export function standaloneHTML(htmlFile, entry, data) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const tag = /<script type="module" src="[^"]+"><\/script>/;
  if (!tag.test(html)) throw new Error('index.html must load its entry with <script type="module" src="...">');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return html.replace(tag, () => `<script>window.SCENE = ${json};</script>\n<script type="module">\n${bundleModules(entry)}\n</script>`);
}
