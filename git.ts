// Git object model, packfiles and pkt-lines. Standard library only.
// One rule governs everything here: pushed object bytes are stored verbatim and
// served verbatim, never re-serialized, so SHA-1s round-trip exactly.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { ZERO_OID } from './store.ts';

export function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

// Object id = SHA-1 over "<type> <size>\0" + bytes.
export function hashObject(type, data) {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([head, data]));
}

export function oidBuffer(hex) {
  return Buffer.from(hex, 'hex');
}

export function isZeroOid(oid) {
  return oid === ZERO_OID;
}

// ---------------------------------------------------------------- trees
// Entry: <mode> <name>\0<20-byte oid>. Sorted by git's rule: byte order of the
// name, a directory compared as if its name ended in '/'.

export function compareTreeNames(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return ab[i] - bb[i];
  }
  return ab.length - bb.length;
}

export function sortTreeEntries(entries) {
  return [...entries].sort((x, y) => {
    const xn = x.mode === '40000' ? `${x.name}/` : x.name;
    const yn = y.mode === '40000' ? `${y.name}/` : y.name;
    return compareTreeNames(xn, yn);
  });
}

export function parseTree(data) {
  const entries = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    const mode = data.subarray(off, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries) {
  const sorted = sortTreeEntries(entries);
  const parts = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(oidBuffer(e.oid));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits
export function parseCommit(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export function buildCommit({ tree, parents, author, committer, message }) {
  let text = `tree ${tree}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

// ---------------------------------------------------------------- tags
export function parseTag(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

// ---------------------------------------------------------------- object store
export function putObject(repo, type, data) {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo, oid) {
  return repo.objects.get(oid) ?? null;
}

// ---------------------------------------------------------------- reachability
// Walk commits from `tips`, collecting every reachable object. With `depth`,
// commits deeper than `depth` levels from a tip are not included; the commits
// exactly at the depth boundary are returned in `boundary` (for shallow-info).
// With `stopAt`, a commit in that set is included with its tree and blobs
// but its parents are not followed: that is the client's held set, given the
// shallow boundaries it already has (a depth-1 clone holds its tip, not the
// tip's parents, even though the parents are reachable from the tip).
// Returns { objects: Set<oid>, boundary: Set<oid> }.
export function collectReachable(repo, tips, depth = Infinity, stopAt = null) {
  const objects = new Set();
  const boundary = new Set();
  const queue = [];
  const seenCommit = new Set();
  for (const tip of tips) {
    if (!tip || isZeroOid(tip)) continue;
    queue.push({ oid: tip, d: 1 });
  }
  const visitTree = (treeOid) => {
    if (!treeOid || isZeroOid(treeOid) || objects.has(treeOid)) return;
    const entry = getObject(repo, treeOid);
    if (!entry || entry.type !== 'tree') return;
    objects.add(treeOid);
    for (const e of parseTree(entry.data)) {
      if (e.mode === '160000') continue; // gitlink: not followed
      if (e.mode === '40000') visitTree(e.oid);
      else objects.add(e.oid);
    }
  };
  while (queue.length > 0) {
    const { oid, d } = queue.shift();
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const entry = getObject(repo, oid);
    if (!entry) continue;
    if (entry.type === 'tag') {
      const tag = parseTag(entry.data);
      objects.add(oid);
      if (tag.object) {
        const target = getObject(repo, tag.object);
        if (target && target.type === 'commit') queue.push({ oid: tag.object, d });
        else if (target) objects.add(tag.object);
      }
      continue;
    }
    if (entry.type !== 'commit') {
      objects.add(oid);
      continue;
    }
    if (d > depth) {
      boundary.add(oid);
      continue;
    }
    objects.add(oid);
    const commit = parseCommit(entry.data);
    visitTree(commit.tree);
    if (stopAt && stopAt.has(oid)) continue;
    if (d === depth) {
      boundary.add(oid);
      continue;
    }
    for (const p of commit.parents) {
      if (!seenCommit.has(p)) queue.push({ oid: p, d: d + 1 });
    }
  }
  return { objects, boundary };
}

// All ancestors of a commit (itself included), newest-first by BFS order.
export function commitAncestors(repo, tip) {
  const out = [];
  const seen = new Set();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift();
    if (!oid || isZeroOid(oid) || seen.has(oid)) continue;
    seen.add(oid);
    const entry = getObject(repo, oid);
    if (!entry || entry.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(entry.data).parents) queue.push(p);
  }
  return out;
}

// Simple merge-base: the first commit reachable from `head` that is also an
// ancestor of `base`. Correct for the linear histories the suite builds.
export function mergeBase(repo, base, head) {
  const baseAncestors = new Set(commitAncestors(repo, base));
  for (const oid of commitAncestors(repo, head)) {
    if (baseAncestors.has(oid)) return oid;
  }
  return null;
}

export function isAncestor(repo, maybeAncestor, oid) {
  if (maybeAncestor === oid) return true;
  return commitAncestors(repo, oid).includes(maybeAncestor);
}

// Flatten a tree to a path -> { mode, oid } map (recursive).
export function flattenTree(repo, treeOid, prefix = '') {
  const out = new Map();
  if (!treeOid || isZeroOid(treeOid)) return out;
  const entry = getObject(repo, treeOid);
  if (!entry || entry.type !== 'tree') return out;
  for (const e of parseTree(entry.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [p, v] of flattenTree(repo, e.oid, path)) out.set(p, v);
    } else {
      out.set(path, { mode: e.mode, oid: e.oid });
    }
  }
  return out;
}

// Build a tree object from a path -> { mode, oid } map, creating intermediate
// trees. Returns the root tree oid.
export function buildTreeFromMap(repo, flat) {
  const build = (paths, prefix) => {
    const entries = [];
    const dirs = new Map();
    for (const [path, v] of paths) {
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: v.mode, name: rest, oid: v.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, []);
        dirs.get(dir).push([path, v]);
      }
    }
    for (const [dir, sub] of dirs) {
      const subOid = build(sub, prefix ? `${prefix}/${dir}` : dir);
      entries.push({ mode: '40000', name: dir, oid: subOid });
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build([...flat.entries()], '');
}

// Diff two trees (by oid): [{ path, status: 'added'|'modified'|'removed',
// oldOid, newOid }]. Counts added/removed lines from the blob contents.
export function diffTrees(repo, oldTreeOid, newTreeOid) {
  const oldMap = flattenTree(repo, oldTreeOid);
  const newMap = flattenTree(repo, newTreeOid);
  const out = [];
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  for (const path of paths) {
    const o = oldMap.get(path);
    const n = newMap.get(path);
    if (o && !n) out.push({ path, status: 'removed', oldOid: o.oid, newOid: null });
    else if (!o && n) out.push({ path, status: 'added', oldOid: null, newOid: n.oid });
    else if (o.oid !== n.oid) out.push({ path, status: 'modified', oldOid: o.oid, newOid: n.oid });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export function countLines(data) {
  if (!data || data.length === 0) return 0;
  const text = data.toString('utf8');
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
  if (text.length > 0 && text[text.length - 1] !== '\n') n++;
  return n;
}

// ---------------------------------------------------------------- packfiles
// Header varint (reference: writePackObjectHeader in the suite's git-client):
// first byte (type << 4) | (size & 0x0f), continuation 0x80 while more size
// bits follow, subsequent bytes 7 bits little-endian. Size is inflated size.
export const PACK_TYPES = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const PACK_TYPE_NAMES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

export function packObjectHeader(type, size) {
  const bytes = [];
  let s = size;
  bytes.push(((PACK_TYPES[type] ?? type) << 4) | (s & 0x0f));
  s >>= 4;
  while (s > 0) {
    bytes.push((s & 0x7f) | 0x80);
    s >>= 7;
  }
  // The continuation bit sits on every byte except the last.
  for (let i = bytes.length - 1; i > 0; i--) bytes[i - 1] |= 0x80;
  bytes[bytes.length - 1] &= 0x7f;
  return Buffer.from(bytes);
}

// objects: [{ oid, type, data }] in a deterministic order (sorted by oid).
// Plain objects only — no deltas.
export function writePack(objects) {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const obj of sorted) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// Parse a packfile. Returns { objects: [{oid, type, data}], error }.
// Delta entries (ofs/ref) are rejected: the suite's client never sends them.
export function readPack(buf) {
  const objects = [];
  if (!buf || buf.length < 32) return { objects, error: 'pack too short' };
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') return { objects, error: 'bad pack signature' };
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) return { objects, error: `unsupported pack version ${version}` };
  const count = buf.readUInt32BE(8);
  let off = 12;
  const byOffset = new Map();
  for (let i = 0; i < count; i++) {
    const startOff = off;
    let byte = buf[off++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const typeName = PACK_TYPE_NAMES[typeCode];
    if (!typeName) return { objects, error: `unknown pack object type ${typeCode}` };
    if (typeCode === 6) {
      return { objects, error: 'delta pack entries are not supported' };
    }
    if (typeCode === 7) {
      return { objects, error: 'delta pack entries are not supported' };
    }
    let data;
    let consumed;
    try {
      ({ data, consumed } = inflatePrefix(buf.subarray(off), size));
    } catch (e) {
      return { objects, error: `zlib inflate failed: ${e.message}` };
    }
    off += consumed;
    if (data.length !== size) return { objects, error: 'object size mismatch' };
    const oid = hashObject(typeName, data);
    objects.push({ oid, type: typeName, data });
    byOffset.set(startOff, oid);
  }
  if (off + 20 > buf.length) return { objects, error: 'pack truncated before trailer' };
  const trailer = buf.subarray(off, off + 20);
  const expect = createHash('sha1').update(buf.subarray(0, off)).digest();
  if (!trailer.equals(expect)) return { objects, error: 'pack trailer checksum mismatch' };
  return { objects, error: null };
}

// How many bytes of `buf` the zlib stream at its start occupies, and its data.
// Node's inflateSync stops at the end of the first stream and ignores what
// follows, so the stream's length is the smallest prefix that inflates to
// exactly `size` bytes (found by binary search; verified on this runtime).
export function inflatePrefix(buf, size) {
  const ok = (len) => {
    try {
      return inflateSync(buf.subarray(0, len)).length === size;
    } catch {
      return false;
    }
  };
  let lo = 1;
  let hi = buf.length;
  if (!ok(hi)) throw new Error('zlib stream does not inflate to the declared size');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return { data: inflateSync(buf.subarray(0, lo)), consumed: lo };
}

// ---------------------------------------------------------------- pkt-lines
// One packet: 4 lowercase hex length bytes (payload + 4), then the payload.
// 0000 flush, 0001 delim, 0002 response-end. Max packet 65,520 bytes total.
export const PKT_MAX = 65520;

export function pktLine(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([head, data]);
}

export function pktFlush() { return Buffer.from('0000', 'utf8'); }
export function pktDelim() { return Buffer.from('0001', 'utf8'); }
export function pktResponseEnd() { return Buffer.from('0002', 'utf8'); }

// Parse pkt-lines from the start of `buf`, stopping at the first flush
// packet. Bytes after the flush are NOT parsed (a receive-pack body carries
// a raw packfile there). Returns { lines, consumed, error }.
export function parsePktLinesUntilFlush(buf) {
  const lines = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len) || len < 0 || len > PKT_MAX) {
      return { lines, consumed: off, error: `bad pkt-line length ${hex} at offset ${off}` };
    }
    if (len === 0) {
      lines.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { lines, consumed: off + 4, error: null };
    }
    if (len === 1) {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      lines.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (off + len > buf.length) {
      return { lines, consumed: off, error: `truncated pkt-line at offset ${off}` };
    }
    lines.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { lines, consumed: off, error: 'no flush packet found' };
}

// Parse a buffer of pkt-lines into [{ kind: 'data'|'flush'|'delim'|'end',
// payload: Buffer }]. Stops at the first malformed packet and reports it.
export function parsePktLines(buf) {
  const out = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len) || len < 0 || len > PKT_MAX) {
      return { lines: out, error: `bad pkt-line length ${hex} at offset ${off}` };
    }
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (off + len > buf.length) {
      return { lines: out, error: `truncated pkt-line at offset ${off}` };
    }
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== buf.length) {
    return { lines: out, error: `trailing ${buf.length - off} bytes after pkt-lines` };
  }
  return { lines: out, error: null };
}

// Sideband: each pkt-line payload starts with a band byte (1 = pack data,
// 2 = progress, 3 = fatal error — never send band 3). Every pkt-line ≤ 65,520.
export function sidebandEncode(data, band = 1) {
  const out = [];
  let off = 0;
  while (off < data.length) {
    const chunk = data.subarray(off, off + PKT_MAX - 5);
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(pktLine(payload));
    off += chunk.length;
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return Buffer.concat(out);
}

// Reassemble band-1 bytes from a sideband-framed buffer; returns the payload
// or null on a band-3 fatal.
export function sidebandDecode(buf) {
  const { lines, error } = parsePktLines(buf);
  if (error) return { data: null, error };
  const parts = [];
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    if (line.payload.length === 0) continue;
    const band = line.payload[0];
    if (band === 3) return { data: null, error: line.payload.subarray(1).toString('utf8') };
    if (band === 1) parts.push(line.payload.subarray(1));
  }
  return { data: Buffer.concat(parts), error: null };
}
