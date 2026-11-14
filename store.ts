// The forge's store: one in-memory truth shared by REST, GraphQL and MCP.
// Determinism: every id comes from a counter, every timestamp is a fixed string,
// nothing here reads a wall clock or randomness, so a replay of the same requests
// on a fresh process produces the same state. The trial's scenario always uses the
// same seed, so the token owner is always the same viewer; the token itself carries
// no login, so the viewer is a fixed fact of this forge (see the kit's wire.ts).

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

// The fixed timestamp every server-built object carries (contents commits, squash
// merges, created_at/updated_at/merged_at). Pushed commits are safe: the client
// builds their author/committer lines with its own fixed timestamps and the server
// stores those bytes verbatim.
export const FIXED_TS = 1700000000;
export const FIXED_ISO = '2023-11-14T22:13:20Z';

export const ZERO_OID = '0000000000000000000000000000000000000000';

// Global counters. Repo ids start at 1 and are never reused after a DELETE;
// issue and comment ids are global across repos for the same reason. PR and issue
// numbers are per-repo counters starting at 1.
export const counters = {
  repoId: 1,
  issueId: 1,
  commentId: 1,
  pullId: 1,
  requestId: 1,
};

export function nextRepoId() { return counters.repoId++; }
export function nextIssueId() { return counters.issueId++; }
export function nextCommentId() { return counters.commentId++; }
export function nextPullId() { return counters.pullId++; }
export function nextRequestId() { return `req-${counters.requestId++}`; }

export function makeRepo(id, name, owner, priv, description) {
  return {
    id,
    name,
    owner,
    private: !!priv,
    description: description ?? '',
    defaultBranch: 'main',
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    objects: new Map(), // oid -> { type: 'commit'|'tree'|'blob'|'tag', data: Buffer }
    refs: new Map(), // 'refs/heads/main' -> oid
    labels: new Map(), // name -> { name, color }
    issues: [], // in creation order; numbers 1..n per repo
    pulls: [], // in creation order; numbers 1..n per repo
    issueSeq: 1,
    pullSeq: 1,
    comments: new Map(), // issue number -> [{ id, body }]
  };
}

export const store = {
  repos: new Map(), // 'owner/name' -> repo
};

export function repoKey(owner, name) { return `${owner}/${name}`; }

export function getRepo(owner, name) {
  return store.repos.get(repoKey(owner, name)) ?? null;
}

// A repository belongs to the login the token names: the same name under another
// owner is a 404, never a 403. Repos are created through REST under the viewer.
export function createRepoRecord(name, priv, description) {
  const key = repoKey(VIEWER.login, name);
  if (store.repos.has(key)) return null;
  const repo = makeRepo(nextRepoId(), name, VIEWER.login, priv, description);
  store.repos.set(key, repo);
  return repo;
}

export function deleteRepoRecord(owner, name) {
  return store.repos.delete(repoKey(owner, name));
}

export function listViewerRepos() {
  const out = [];
  for (const repo of store.repos.values()) {
    if (repo.owner === VIEWER.login) out.push(repo);
  }
  return out;
}

// Opaque stable global ids for GraphQL: base64url of 'Type:<numeric id>'.
// Never the plain database id, and decodable by node(id:).
export function globalId(kind, n) {
  return Buffer.from(`${kind}:${n}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id) {
  try {
    const text = Buffer.from(String(id), 'base64url').toString('utf8');
    const i = text.indexOf(':');
    if (i < 1) return null;
    return { kind: text.slice(0, i), num: Number(text.slice(i + 1)) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo) { return globalId('Repository', repo.id); }
export function issueGlobalId(issue) { return globalId('Issue', issue.id); }
export function pullGlobalId(pull) { return globalId('PullRequest', pull.id); }
export function commentGlobalId(comment) { return globalId('IssueComment', comment.id); }

// Deterministic cursor for GraphQL issue pagination: the last issue number seen.
export function issueCursor(number) {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

export function parseIssueCursor(cursor) {
  if (!cursor) return 0;
  try {
    const text = Buffer.from(String(cursor), 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}
