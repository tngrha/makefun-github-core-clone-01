// Git smart HTTP: info/refs (v0 + v2), protocol v2 ls-refs/fetch, v0
// receive-pack. Paths: /<owner>/<repo>.git/info/refs?service=<service> (GET)
// and /<owner>/<repo>.git/<service> (POST). No git binary anywhere: the pack
// writer/reader and the object store are git.ts, the store is store.ts.

import {
  isZeroOid, getObject, parseCommit, parseTag, collectReachable,
  writePack, readPack, hashObject,
  pktLine, pktFlush, pktDelim, parsePktLines, parsePktLinesUntilFlush, sidebandEncode,
} from './git.ts';
import { getRepo, ZERO_OID } from './store.ts';

const AGENT = 'makefun-forge/1.0';

// Pack cache for the clone workload: the depth-1 pack of a tip is a pure
// function of immutable objects, so it is correct forever once built.
const packCache = new Map();

function cachedPack(repo, tip, depth) {
  const key = `${repo.id}:${tip}:${depth}`;
  let pack = packCache.get(key);
  if (!pack) {
    const { objects } = collectReachable(repo, [tip], depth);
    const list = [];
    for (const oid of objects) {
      const entry = getObject(repo, oid);
      if (entry) list.push({ oid, type: entry.type, data: entry.data });
    }
    pack = writePack(list);
    packCache.set(key, pack);
  }
  return pack;
}

// ---------------------------------------------------------------- refs
// All refs of a repo, sorted, as [{ ref, oid }]. HEAD is not a ref here.
function listRefs(repo) {
  const out = [];
  for (const [ref, oid] of repo.refs) out.push({ ref, oid });
  out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return out;
}

function peeledCommit(repo, oid) {
  const entry = getObject(repo, oid);
  if (!entry) return null;
  if (entry.type === 'commit') return oid;
  if (entry.type === 'tag') {
    const tag = parseTag(entry.data);
    return peeledCommit(repo, tag.object);
  }
  return null;
}

function isAnnotatedTag(repo, oid) {
  const entry = getObject(repo, oid);
  return !!entry && entry.type === 'tag';
}

// ---------------------------------------------------------------- info/refs
function v2Capabilities() {
  return [
    'version 2',
    `agent=${AGENT}`,
    'ls-refs=unborn',
    'fetch=shallow filter',
    'object-format=sha1',
  ];
}

function v0UploadCaps() {
  return `symref=HEAD:refs/heads/main agent=${AGENT} object-format=sha1 side-band-64k`;
}

function v0ReceiveCaps() {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

function infoRefs(repo, service, wantV2) {
  const refs = listRefs(repo);
  if (service === 'git-upload-pack' && wantV2) {
    const parts = [];
    for (const cap of v2Capabilities()) parts.push(pktLine(`${cap}\n`));
    parts.push(pktFlush());
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: Buffer.concat(parts),
    };
  }
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload ? v0UploadCaps() : v0ReceiveCaps();
  const serviceLine = isUpload ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const parts = [pktLine(serviceLine), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const { ref, oid } of refs) {
      const line = first ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`;
      parts.push(pktLine(line));
      first = false;
      if (isAnnotatedTag(repo, oid)) {
        const peeled = peeledCommit(repo, oid);
        if (peeled) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return {
    status: 200,
    contentType: isUpload
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement',
    body: Buffer.concat(parts),
  };
}

// ---------------------------------------------------------------- ls-refs (v2)
function lsRefs(repo, args) {
  const peel = args.has('peel');
  const symrefs = args.has('symrefs');
  const unborn = args.has('unborn');
  const prefixes = args.getAll('ref-prefix');
  const refs = listRefs(repo);
  const out = [];
  const include = (ref) => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  if (refs.length === 0) {
    if (unborn && include('HEAD')) {
      out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
    out.push(pktFlush());
    return Buffer.concat(out);
  }
  const mainTip = repo.refs.get('refs/heads/main');
  if (symrefs && mainTip && include('HEAD')) {
    out.push(pktLine(`${mainTip} HEAD symref-target:refs/heads/main\n`));
  }
  for (const { ref, oid } of refs) {
    if (!include(ref)) continue;
    let line = `${oid} ${ref}`;
    if (symrefs && ref === 'refs/heads/main') line += ' symref-target:refs/heads/main';
    if (peel && isAnnotatedTag(repo, oid)) {
      const peeled = peeledCommit(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- fetch (v2)
function doFetch(repo, args) {
  const wants = args.getAll('want');
  const haves = args.getAll('have');
  const shallowLines = args.getAll('shallow');
  const deepen = args.has('deepen') ? Number(args.get('deepen')) : null;

  const parts = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  if (haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    let acked = false;
    for (const have of haves) {
      const entry = getObject(repo, have);
      if (!entry) continue;
      // ACK a have that is an ancestor of a want.
      const isAncestor = wants.some((w) => {
        if (w === have) return true;
        const queue = [w];
        const seen = new Set();
        while (queue.length > 0) {
          const cur = queue.shift();
          if (cur === have) return true;
          if (seen.has(cur)) continue;
          seen.add(cur);
          const obj = getObject(repo, cur);
          if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
        }
        return false;
      });
      if (isAncestor) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
    parts.push(pktLine('ready\n'));
  }
  // The section ends here: a delim resets the client's section state, so the
  // next section header is read as a header, not as an acknowledgments line.
  parts.push(pktDelim());

  // shallow-info
  const depth = deepen !== null ? deepen : Infinity;
  const shallowOut = [];
  const unshallowOut = [];
  if (deepen !== null) {
    const { boundary } = collectReachable(repo, wants, depth);
    for (const oid of boundary) shallowOut.push(oid);
    // Old boundaries that are now included stop being shallow.
    for (const old of shallowLines) {
      const { objects } = collectReachable(repo, wants, depth);
      if (objects.has(old)) unshallowOut.push(old);
    }
  }
  parts.push(pktDelim());
  parts.push(pktLine('shallow-info\n'));
  for (const oid of shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));

  // packfile
  parts.push(pktDelim());
  parts.push(pktLine('packfile\n'));
  let pack;
  if (wants.length === 1 && deepen === 1 && haves.length === 0) {
    pack = cachedPack(repo, wants[0], 1);
  } else {
    const { objects: wantObjects } = collectReachable(repo, wants, depth);
    // What the client already holds: reachable from its haves, but never
    // past its current shallow boundaries (a depth-1 clone holds its tip,
    // not the tip's parents).
    const { objects: haveObjects } = haves.length > 0
      ? collectReachable(repo, haves, Infinity, new Set(shallowLines))
      : { objects: new Set() };
    const list = [];
    for (const oid of wantObjects) {
      if (haveObjects.has(oid)) continue;
      const entry = getObject(repo, oid);
      if (entry) list.push({ oid, type: entry.type, data: entry.data });
    }
    pack = writePack(list);
  }
  parts.push(sidebandEncode(pack, 1));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack (v0)
function doReceivePack(repo, body) {
  const { lines, consumed, error } = parsePktLinesUntilFlush(body);
  if (error) return { status: 400, body: Buffer.from('bad pkt-line\n'), contentType: 'text/plain' };
  const commands = [];
  for (const line of lines) {
    if (line.kind === 'flush') break;
    if (line.kind !== 'data') continue;
    let text = line.payload.toString('utf8');
    if (commands.length === 0) {
      const nul = text.indexOf('\0');
      if (nul !== -1) text = text.slice(0, nul);
    }
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) continue;
    commands.push({ old: parts[0], new: parts[1], ref: parts[2] });
  }
  const packBuf = body.subarray(consumed);

  const report = [];
  let unpackOk = true;
  let unpackError = null;
  const hasPack = commands.some((c) => !isZeroOid(c.new));
  if (hasPack) {
    if (packBuf.length < 32) {
      unpackOk = false;
      unpackError = 'missing packfile';
    } else {
      const { objects, error: packError } = readPack(packBuf);
      if (packError) {
        unpackOk = false;
        unpackError = packError;
      } else {
        for (const obj of objects) {
          if (!repo.objects.has(obj.oid)) {
            repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
          }
        }
      }
    }
  }

  const results = [];
  if (!unpackOk) {
    report.push(pktLine(`unpack ${unpackError}\n`));
    for (const c of commands) report.push(pktLine(`ng ${c.ref} unpacker error\n`));
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-result',
      body: Buffer.concat([sidebandEncode(Buffer.concat(report), 1), pktFlush()]),
    };
  }
  report.push(pktLine('unpack ok\n'));
  for (const c of commands) {
    const current = repo.refs.get(c.ref);
    let ok = false;
    if (isZeroOid(c.new)) {
      // delete
      ok = !!current && current === c.old;
      if (ok) repo.refs.delete(c.ref);
    } else if (isZeroOid(c.old)) {
      // create
      ok = !current;
      if (ok) repo.refs.set(c.ref, c.new);
    } else {
      // update: old must match and new must descend from old
      ok = !!current && current === c.old && isDescendant(repo, c.old, c.new);
      if (ok) repo.refs.set(c.ref, c.new);
    }
    results.push(ok ? `ok ${c.ref}` : `ng ${c.ref} non-fast-forward`);
  }
  for (const line of results) report.push(pktLine(`${line}\n`));
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: Buffer.concat([sidebandEncode(Buffer.concat(report), 1), pktFlush()]),
  };
}

function isDescendant(repo, ancestor, oid) {
  if (ancestor === oid) return true;
  const queue = [oid];
  const seen = new Set();
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    if (obj && obj.type === 'tag') queue.push(parseTag(obj.data).object);
  }
  return false;
}

// ---------------------------------------------------------------- entry point
// Returns { status, contentType, body } or { status: 404 } for a missing repo.
// The caller (app.ts) wraps it in the HTTP response; auth is checked there.
export function handleGit(owner, name, service, method, query, body, protocolVersion) {
  const repo = getRepo(owner, name);
  if (!repo) return { status: 404, contentType: 'application/json', body: null };

  if (method === 'GET' && service === 'info/refs') {
    const svc = query.get('service') ?? '';
    if (svc !== 'git-upload-pack' && svc !== 'git-receive-pack') {
      return { status: 400, contentType: 'application/json', body: null };
    }
    const wantV2 = svc === 'git-upload-pack' && protocolVersion === '2';
    return infoRefs(repo, svc, wantV2);
  }

  if (method === 'POST' && service === 'git-upload-pack') {
    if (protocolVersion === '2') {
      const { lines, error } = parsePktLines(body);
      if (error) return { status: 400, contentType: 'text/plain', body: Buffer.from('bad pkt-line\n') };
      let command = null;
      const map = new Map();
      const args = {
        has: (k) => map.has(k),
        get: (k) => (map.get(k) ?? [])[0] ?? null,
        getAll: (k) => map.get(k) ?? [],
      };
      let inArgs = false;
      for (const line of lines) {
        if (line.kind === 'delim') { inArgs = true; continue; }
        if (line.kind === 'flush') break;
        if (line.kind !== 'data') continue;
        const text = line.payload.toString('utf8').trim();
        if (!inArgs) {
          const m = /^command=(.+)$/.exec(text);
          if (m) command = m[1];
          continue;
        }
        const eq = text.indexOf(' ');
        const key = eq === -1 ? text : text.slice(0, eq);
        const value = eq === -1 ? '' : text.slice(eq + 1);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(value);
      }
      if (command === 'ls-refs') {
        return {
          status: 200,
          contentType: 'application/x-git-upload-pack-result',
          body: lsRefs(repo, args),
        };
      }
      if (command === 'fetch') {
        return {
          status: 200,
          contentType: 'application/x-git-upload-pack-result',
          body: doFetch(repo, args),
        };
      }
      return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown command\n') };
    }
    // v0 upload-pack: not exercised when we answer v2, but parse it anyway.
    return { status: 400, contentType: 'text/plain', body: Buffer.from('protocol v0 fetch is not supported\n') };
  }

  if (method === 'POST' && service === 'git-receive-pack') {
    return doReceivePack(repo, body);
  }

  return { status: 404, contentType: 'application/json', body: null };
}
