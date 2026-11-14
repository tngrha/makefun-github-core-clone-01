// REST v3 (GitHub API) under /api/v3. Every reply is application/json with a
// non-empty X-GitHub-Request-Id; errors are {"message": "<string>"}.
// Auth is enforced by app.ts before this router runs (except GET / and /meta,
// which the starter answers without a token).

import {
  VIEWER, FIXED_TS, FIXED_ISO, ZERO_OID,
  nextIssueId, nextCommentId, nextPullId, nextRequestId,
  store, getRepo, createRepoRecord, deleteRepoRecord, listViewerRepos,
} from './store.ts';
import {
  hashObject, putObject, getObject, parseCommit, buildCommit,
  parseTree, buildTree, flattenTree, buildTreeFromMap, diffTrees, countLines,
  mergeBase, commitAncestors,
} from './git.ts';

export function requestId() {
  return nextRequestId();
}

export function repoJson(repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(repo, issue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: (issue.labels ?? []).map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(repo, pull) {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt ?? null,
    merge_commit_sha: pull.mergeCommitSha ?? null,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ---------------------------------------------------------------- helpers
function branchTip(repo, branch) {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function branchHeadCommit(repo, branch) {
  const tip = branchTip(repo, branch);
  if (!tip) return null;
  const obj = getObject(repo, tip);
  return obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
}

// Set (or replace) a file path in a tree; returns the new root tree oid.
function setPathInTree(repo, treeOid, path, blobOid) {
  const flat = flattenTree(repo, treeOid);
  flat.set(path, { mode: '100644', oid: blobOid });
  return buildTreeFromMap(repo, flat);
}

function deletePathFromTree(repo, treeOid, path) {
  const flat = flattenTree(repo, treeOid);
  if (!flat.has(path)) return null;
  flat.delete(path);
  return buildTreeFromMap(repo, flat);
}

// The tree oid at `path` inside a tree ('' = the root tree itself), or null.
function treeAtPath(repo, treeOid, path) {
  if (!path) return treeOid;
  let cur = treeOid;
  for (const part of path.split('/')) {
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'tree') return null;
    const next = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!next) return null;
    cur = next.oid;
  }
  return cur;
}

function authorLine() {
  return `${VIEWER.name} <${VIEWER.email}> ${FIXED_TS} +0000`;
}

// Build a server-side commit (contents API, squash merges) with a fixed
// timestamp and the token owner's identity. Returns the commit oid.
function makeServerCommit(repo, { tree, parents, message }) {
  const data = buildCommit({
    tree,
    parents,
    author: authorLine(),
    committer: authorLine(),
    message,
  });
  return putObject(repo, 'commit', data);
}

// PR conflict test: a path changed on BOTH sides differently since the
// merge-base (modified both ways, or deleted on one side and modified on the
// other) is a conflict.
export function pullConflict(repo, pull) {
  const base = mergeBase(repo, pull.baseSha, pull.headSha);
  if (!base) return false;
  const baseTree = parseCommit(getObject(repo, base).data).tree;
  const headTree = parseCommit(getObject(repo, pull.headSha).data).tree;
  const baseTipTree = parseCommit(getObject(repo, pull.baseSha).data).tree;
  const baseMap = flattenTree(repo, baseTree);
  const headMap = flattenTree(repo, headTree);
  const tipMap = flattenTree(repo, baseTipTree);
  const paths = new Set([...baseMap.keys(), ...headMap.keys(), ...tipMap.keys()]);
  for (const path of paths) {
    const b = baseMap.get(path)?.oid ?? null;
    const h = headMap.get(path)?.oid ?? null;
    const t = tipMap.get(path)?.oid ?? null;
    const headChanged = h !== b;
    const tipChanged = t !== b;
    if (headChanged && tipChanged && h !== t) return true;
  }
  return false;
}

// The squash merge itself: apply the head's changes onto the base tip's tree.
export function squashMergeTree(repo, pull) {
  const base = mergeBase(repo, pull.baseSha, pull.headSha);
  const baseTree = base ? parseCommit(getObject(repo, base).data).tree : ZERO_OID;
  const headTree = parseCommit(getObject(repo, pull.headSha).data).tree;
  const baseTipTree = parseCommit(getObject(repo, pull.baseSha).data).tree;
  const baseMap = flattenTree(repo, baseTree);
  const headMap = flattenTree(repo, headTree);
  const merged = flattenTree(repo, baseTipTree);
  for (const [path, v] of headMap) {
    if ((baseMap.get(path)?.oid ?? null) !== v.oid) merged.set(path, v);
  }
  for (const path of baseMap.keys()) {
    if (!headMap.has(path) && merged.has(path)) merged.delete(path);
  }
  return buildTreeFromMap(repo, merged);
}

export function doSquashMerge(repo, pull) {
  const tree = squashMergeTree(repo, pull);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n`;
  const sha = makeServerCommit(repo, { tree, parents: [pull.baseSha], message });
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = sha;
  pull.state = 'closed';
  pull.baseSha = sha;
  pull.updatedAt = FIXED_ISO;
  return sha;
}

// ---------------------------------------------------------------- router
// ctx: { method, path (segments, decoded), query: URLSearchParams, body }
// Returns { status, headers, body } where body is a value to JSON-stringify
// (or null for an empty body, e.g. 204). Throws never: malformed bodies are
// caught by the caller and turned into a 400 before this runs.

export function handleRest(ctx) {
  const { method, segments, query } = ctx;
  const seg = segments;
  const json = (status, body, extraHeaders) => ({ status, body, headers: extraHeaders ?? {} });

  // GET /api/v3/ and /api/v3
  if (seg.length === 0) {
    if (method !== 'GET') return json(404, { message: 'Not Found' });
    return json(200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return json(404, { message: 'Not Found' });
    return json(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return json(404, { message: 'Not Found' });
    return json(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
  }

  // /api/v3/user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') {
      const body = ctx.body ?? {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) return json(422, { message: 'name is required' });
      const repo = createRepoRecord(name, body.private === true, body.description);
      if (!repo) return json(422, { message: `Repository ${name} already exists` });
      return json(201, repoJson(repo));
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Number(query.get('per_page') ?? 30) || 30);
      const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
      const all = listViewerRepos();
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers = {};
      if (start + perPage < all.length) {
        const next = `${ctx.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers.link = `<${next}>; rel="next"`;
      }
      return json(200, slice.map(repoJson), headers);
    }
    return json(404, { message: 'Not Found' });
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1];
    const name = seg[2];
    const repo = getRepo(owner, name);
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return json(404, { message: 'Not Found' });
        return json(200, repoJson(repo));
      }
      if (method === 'PATCH') {
        if (!repo) return json(404, { message: 'Not Found' });
        const body = ctx.body ?? {};
        if (typeof body.description === 'string') repo.description = body.description;
        repo.updatedAt = FIXED_ISO;
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        if (!repo) return json(404, { message: 'Not Found' });
        deleteRepoRecord(owner, name);
        return { status: 204, body: null, headers: {} };
      }
      return json(404, { message: 'Not Found' });
    }

    if (!repo) return json(404, { message: 'Not Found' });

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = ctx.body ?? {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
          return json(422, { message: 'invalid ref or sha' });
        }
        if (repo.refs.has(ref)) return json(422, { message: 'Reference already exists' });
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha }, url: '' });
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) return json(404, { message: 'Not Found' });
        return json(200, { ref, object: { sha }, url: '' });
      }
      return json(404, { message: 'Not Found' });
    }

    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const out = [];
        for (const [ref, sha] of repo.refs) {
          if (ref.startsWith('refs/heads/')) {
            out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
          }
        }
        out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return json(200, out);
      }
      if (method === 'GET' && rest.length >= 2) {
        const sha = repo.refs.get(`refs/heads/${rest.slice(1).join('/')}`);
        if (!sha) return json(404, { message: 'Not Found' });
        return json(200, { name: rest.slice(1).join('/'), commit: { sha } });
      }
      return json(404, { message: 'Not Found' });
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = branchTip(repo, ref) ?? (repo.refs.get(ref) ?? null);
      if (!tip) return json(200, []);
      const out = [];
      const seen = new Set();
      let cur = tip;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const obj = getObject(repo, cur);
        if (!obj || obj.type !== 'commit') break;
        const c = parseCommit(obj.data);
        out.push({
          sha: cur,
          commit: {
            // The API returns the message without its trailing newline(s);
            // the stored commit bytes keep them (git convention).
            message: c.message.replace(/\n+$/, ''),
            author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
            committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
          },
        });
        cur = c.parents[0] ?? null;
      }
      return json(200, out);
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const branch = query.get('ref') ?? (ctx.body?.branch ?? repo.defaultBranch);
      if (method === 'GET') {
        const tip = branchTip(repo, branch);
        if (!tip) return json(404, { message: 'Not Found' });
        const commit = parseCommit(getObject(repo, tip).data);
        const flat = flattenTree(repo, commit.tree);
        const entry = flat.get(path);
        if (entry) {
          const blob = getObject(repo, entry.oid);
          return json(200, {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: path.split('/').pop(),
            path,
            content: blob.data.toString('base64'),
            sha: entry.oid,
          });
        }
        // Directory listing: walk to the tree at `path` and list its entries
        // directly, so each entry's sha is its real object id.
        const dirTree = treeAtPath(repo, commit.tree, path);
        if (dirTree) {
          const out = parseTree(getObject(repo, dirTree).data).map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: path ? `${path}/${e.name}` : e.name,
            sha: e.oid,
          }));
          out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          return json(200, out);
        }
        return json(404, { message: 'Not Found' });
      }
      if (method === 'PUT') {
        const body = ctx.body ?? {};
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        let bytes;
        try {
          bytes = Buffer.from(contentB64, 'base64');
        } catch {
          return json(422, { message: 'content is not valid base64' });
        }
        const useBranch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const tip = branchTip(repo, useBranch);
        const blobOid = hashObject('blob', bytes);
        if (body.sha && tip) {
          const commit = parseCommit(getObject(repo, tip).data);
          const flat = flattenTree(repo, commit.tree);
          const current = flat.get(path);
          if (current && current.oid !== body.sha) {
            return json(409, { message: 'sha does not match the current file version' });
          }
          if (!current && body.sha) {
            return json(409, { message: 'sha does not match the current file version' });
          }
        }
        const isUpdate = !!tip && !!flattenTree(repo, parseCommit(getObject(repo, tip).data).tree).get(path);
        putObject(repo, 'blob', bytes);
        const baseTree = tip ? parseCommit(getObject(repo, tip).data).tree : ZERO_OID;
        const newTree = setPathInTree(repo, baseTree, path, blobOid);
        const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
        const commitSha = makeServerCommit(repo, {
          tree: newTree,
          parents: tip ? [tip] : [],
          message: message.endsWith('\n') ? message : `${message}\n`,
        });
        repo.refs.set(`refs/heads/${useBranch}`, commitSha);
        return json(isUpdate ? 200 : 201, {
          content: { name: path.split('/').pop(), path, sha: blobOid, size: bytes.length, encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const body = ctx.body ?? {};
        const useBranch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const tip = branchTip(repo, useBranch);
        if (!tip) return json(404, { message: 'Not Found' });
        const commit = parseCommit(getObject(repo, tip).data);
        const flat = flattenTree(repo, commit.tree);
        if (!flat.has(path)) return json(404, { message: 'Not Found' });
        if (body.sha && flat.get(path).oid !== body.sha) {
          return json(409, { message: 'sha does not match the current file version' });
        }
        const newTree = deletePathFromTree(repo, commit.tree, path);
        const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
        const commitSha = makeServerCommit(repo, {
          tree: newTree,
          parents: [tip],
          message: message.endsWith('\n') ? message : `${message}\n`,
        });
        repo.refs.set(`refs/heads/${useBranch}`, commitSha);
        return json(200, { commit: { sha: commitSha, message } });
      }
      return json(404, { message: 'Not Found' });
    }

    // labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method !== 'POST') return json(404, { message: 'Not Found' });
      const body = ctx.body ?? {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) return json(422, { message: 'name is required' });
      const label = { name, color: typeof body.color === 'string' ? body.color : 'ededed' };
      repo.labels.set(name, label);
      return json(201, label);
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = ctx.body ?? {};
          const title = typeof body.title === 'string' ? body.title : '';
          if (!title) return json(422, { message: 'title is required' });
          const labels = Array.isArray(body.labels) ? body.labels : [];
          for (const l of labels) {
            const labelName = typeof l === 'string' ? l : l?.name;
            if (labelName && !repo.labels.has(labelName)) {
              return json(422, { message: `label ${labelName} does not exist` });
            }
          }
          const issue = {
            id: nextIssueId(),
            number: repo.issueSeq++,
            title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            labels: labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean),
            createdAt: FIXED_ISO,
            updatedAt: FIXED_ISO,
          };
          repo.issues.push(issue);
          repo.comments.set(issue.number, []);
          return json(201, issueJson(repo, issue));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          const perPage = Math.max(1, Number(query.get('per_page') ?? 30) || 30);
          let list = repo.issues.filter((i) => state === 'all' || i.state === state);
          if (sort === 'created') {
            list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          return json(200, list.slice(0, perPage).map((i) => issueJson(repo, i)));
        }
        return json(404, { message: 'Not Found' });
      }
      const num = Number(rest[1]);
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!issue) return json(404, { message: 'Not Found' });
          return json(200, issueJson(repo, issue));
        }
        if (method === 'PATCH') {
          if (!issue) return json(404, { message: 'Not Found' });
          const body = ctx.body ?? {};
          if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
          issue.updatedAt = FIXED_ISO;
          return json(200, issueJson(repo, issue));
        }
        return json(404, { message: 'Not Found' });
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return json(404, { message: 'Not Found' });
        if (method === 'POST') {
          const body = ctx.body ?? {};
          const comment = { id: nextCommentId(), body: typeof body.body === 'string' ? body.body : '' };
          repo.comments.get(issue.number).push(comment);
          return json(201, { id: comment.id, body: comment.body });
        }
        if (method === 'GET') {
          return json(200, (repo.comments.get(issue.number) ?? []).map((c) => ({ id: c.id, body: c.body })));
        }
        return json(404, { message: 'Not Found' });
      }
      return json(404, { message: 'Not Found' });
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = ctx.body ?? {};
          const headRaw = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : '';
          const head = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
          const headSha = branchTip(repo, head);
          const baseSha = branchTip(repo, base);
          if (!head || !base || !headSha || !baseSha) {
            return json(422, { message: 'head and base branches must exist' });
          }
          const dup = repo.pulls.find((p) => p.head === head && p.state === 'open');
          if (dup) return json(422, { message: 'a pull request from this head already exists' });
          const pull = {
            id: nextPullId(),
            number: repo.pullSeq++,
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            head,
            headSha,
            base,
            baseSha,
            createdAt: FIXED_ISO,
            updatedAt: FIXED_ISO,
          };
          repo.pulls.push(pull);
          return json(201, pullJson(repo, pull));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const perPage = Math.max(1, Number(query.get('per_page') ?? 30) || 30);
          const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
          return json(200, list.slice(0, perPage).map((p) => pullJson(repo, p)));
        }
        return json(404, { message: 'Not Found' });
      }
      const num = Number(rest[1]);
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!pull) return json(404, { message: 'Not Found' });
          return json(200, pullJson(repo, pull));
        }
        return json(404, { message: 'Not Found' });
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) return json(404, { message: 'Not Found' });
        const headTree = parseCommit(getObject(repo, pull.headSha).data).tree;
        const baseTree = parseCommit(getObject(repo, pull.baseSha).data).tree;
        const diffs = diffTrees(repo, baseTree, headTree);
        const out = diffs.map((d) => {
          let additions = 0;
          let deletions = 0;
          if (d.status === 'added' || d.status === 'modified') {
            const blob = getObject(repo, d.newOid);
            additions = countLines(blob?.data);
          }
          if (d.status === 'removed' || d.status === 'modified') {
            const blob = getObject(repo, d.oldOid);
            deletions = countLines(blob?.data);
          }
          return {
            filename: d.path,
            status: d.status === 'modified' ? 'modified' : d.status,
            additions,
            deletions,
            changes: additions + deletions,
          };
        });
        return json(200, out);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) return json(404, { message: 'Not Found' });
        if (pull.merged) return json(405, { message: 'pull request is already merged' });
        // Refresh the tips (branches may have moved since the PR opened).
        pull.headSha = branchTip(repo, pull.head) ?? pull.headSha;
        pull.baseSha = branchTip(repo, pull.base) ?? pull.baseSha;
        if (pullConflict(repo, pull)) {
          return json(405, { message: 'merge conflict: head and base both changed the same file' });
        }
        const sha = doSquashMerge(repo, pull);
        return json(200, { sha, merged: true, message: `Pull request #${pull.number} merged` });
      }
      return json(404, { message: 'Not Found' });
    }
  }

  return json(404, { message: 'Not Found' });
}
