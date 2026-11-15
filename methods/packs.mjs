// Content-addressed data layers ("packs") and building appearance hashes, so a page can load only verified data and a
// review can tell geometry changes from label changes. Node.js only (node:crypto, node:fs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** JSON with object keys sorted at every level: the same data always gives the same bytes. */
export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('non-finite number in a pack');
  return JSON.stringify(value);
}

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const NAME = /^[a-z][a-z0-9-]*$/, FILE = /^([a-z][a-z0-9-]*)\.([0-9a-f]{12})\.json$/;

/**
 * Write layers {name: data} into `dir` as <name>.<sha256[:12]>.json plus meta.json {schema, packs: {name: {file,
 * sha256, bytes}}}. A file whose name carries its hash can be cached forever; only meta.json must be revalidated.
 * Refuses to overwrite a different file under the same name.
 */
export function writePacks(dir, layers) {
  fs.mkdirSync(dir, {recursive: true});
  const meta = {schema: 1, packs: {}};
  for (const name of Object.keys(layers).sort()) {
    if (!NAME.test(name)) throw new RangeError('bad pack name ' + name);
    const text = canonicalJSON(layers[name]), hash = sha256(text), file = `${name}.${hash.slice(0, 12)}.json`;
    const target = path.join(dir, file);
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== text) throw new Error('refusing to overwrite ' + file);
    fs.writeFileSync(target, text);
    meta.packs[name] = {file, sha256: hash, bytes: Buffer.byteLength(text)};
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');
  return meta;
}

/** Read and verify every pack listed in meta.json; any mismatch throws (fail closed). */
export function readPacks(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  if (meta.schema !== 1) throw new Error('unknown pack schema');
  const out = {};
  for (const [name, entry] of Object.entries(meta.packs)) {
    const m = FILE.exec(entry.file);
    if (!NAME.test(name) || !m || m[1] !== name) throw new Error('bad pack entry ' + name);
    const text = fs.readFileSync(path.join(dir, entry.file), 'utf8');
    const hash = sha256(text);
    if (hash !== entry.sha256 || hash.slice(0, 12) !== m[2] || Buffer.byteLength(text) !== entry.bytes) throw new Error('pack content differs from its manifest: ' + name);
    out[name] = JSON.parse(text);
  }
  return out;
}

/**
 * Two short hashes per record: g over the fields that change how it looks (geometry, heights, materials) and l over
 * label-only fields. A painted or cached rendering is stale for a record exactly when g changed.
 */
export function recordHashes(record, labelFields = ['name', 'label', 'altName', 'operator']) {
  const look = {}, label = {};
  for (const [k, v] of Object.entries(record)) (labelFields.includes(k) ? label : look)[k] = v;
  return {g: sha256(canonicalJSON(look)).slice(0, 12), l: sha256(canonicalJSON(label)).slice(0, 12)};
}

/** Compare two {id: record} maps: added, removed, shape (g changed) and label-only changes. */
export function diffRecords(before, after, labelFields) {
  const out = {added: [], removed: [], shape: [], label: []};
  for (const id of Object.keys(after)) {
    if (!(id in before)) { out.added.push(id); continue; }
    const a = recordHashes(before[id], labelFields), b = recordHashes(after[id], labelFields);
    if (a.g !== b.g) out.shape.push(id);
    else if (a.l !== b.l) out.label.push(id);
  }
  for (const id of Object.keys(before)) if (!(id in after)) out.removed.push(id);
  return out;
}
