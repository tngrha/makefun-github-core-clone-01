// GraphQL v4 at /api/graphql. A small hand-rolled executor for exactly the
// documents the suite sends (see the kit spec §4): no library, no schema
// engine — a tokenizer, a recursive-descent parser, and resolvers over the
// shared store. Unknown fields answer HTTP 200 with an errors array; an
// unknown repository answers data.repository = null with no errors.

import {
  VIEWER, store, getRepo, parseGlobalId, counters,
  repoGlobalId, issueGlobalId, pullGlobalId, commentGlobalId,
  issueCursor, parseIssueCursor,
} from './store.ts';
import {
  getObject, parseCommit, flattenTree, diffTrees, countLines, mergeBase,
} from './git.ts';
import { pullConflict, doSquashMerge } from './rest.ts';

// ---------------------------------------------------------------- tokenizer
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === '[' || c === ']' || c === ':' || c === '!' || c === '=') {
      tokens.push({ kind: c, value: c });
      i++;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ kind: 'number', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser
function parseDocument(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (kind) => {
    const t = next();
    if (t.kind !== kind) throw new Error(`expected ${kind}, got ${t.kind} (${t.value})`);
    return t;
  };

  function parseValue() {
    const t = next();
    if (t.kind === 'var') return { var: t.value };
    if (t.kind === 'string' || t.kind === 'number') return t.value;
    if (t.kind === '[') {
      const list = [];
      while (peek().kind !== ']') list.push(parseValue());
      expect(']');
      return list;
    }
    if (t.kind === '{') {
      const obj = {};
      while (peek().kind !== '}') {
        const key = next();
        if (key.kind !== 'name') throw new Error(`expected object key, got ${key.kind}`);
        expect(':');
        obj[key.value] = parseValue();
      }
      expect('}');
      return obj;
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return { enum: t.value };
    }
    throw new Error(`unexpected value token ${t.kind}`);
  }

  function parseArguments() {
    const args = {};
    expect('(');
    while (peek().kind !== ')') {
      const name = next();
      if (name.kind !== 'name') throw new Error(`expected argument name, got ${name.kind}`);
      expect(':');
      args[name.value] = parseValue();
    }
    expect(')');
    return args;
  }

  function parseSelectionSet() {
    expect('{');
    const selections = [];
    while (peek().kind !== '}') {
      if (peek().kind === '...') {
        next();
        let typeName = null;
        if (peek().kind === 'name' && peek().value === 'on') {
          next();
          typeName = next().value;
        }
        const set = parseSelectionSet();
        selections.push({ fragment: true, typeName, selections: set });
        continue;
      }
      const first = next();
      if (first.kind !== 'name') throw new Error(`expected field name, got ${first.kind}`);
      let alias = null;
      let name = first.value;
      if (peek().kind === ':') {
        next();
        alias = name;
        name = next().value;
      }
      const args = peek().kind === '(' ? parseArguments() : {};
      const set = peek().kind === '{' ? parseSelectionSet() : null;
      selections.push({ field: name, alias: alias ?? name, args, selections: set });
    }
    expect('}');
    return selections;
  }

  function parseVariableDefinitions() {
    const vars = {};
    if (peek().kind !== '(') return vars;
    expect('(');
    while (peek().kind !== ')') {
      const v = next();
      if (v.kind !== 'var') throw new Error(`expected variable, got ${v.kind}`);
      expect(':');
      // Skip the type (name, possibly [..], possibly !).
      let depth = 0;
      while (true) {
        const t = next();
        if (t.kind === '[') depth++;
        else if (t.kind === ']') depth--;
        else if (t.kind === '!' && depth === 0) break;
        else if (t.kind === 'name' && depth === 0) {
          // A type name; the next token may be '!' or the next variable.
          if (peek().kind === '!') { next(); }
          break;
        }
      }
      vars[v.value] = true;
    }
    expect(')');
    return vars;
  }

  function parseOperation() {
    let kind = 'query';
    let name = null;
    if (peek().kind === 'name' && (peek().value === 'query' || peek().value === 'mutation')) {
      kind = next().value;
      if (peek().kind === 'name') name = next().value;
    }
    parseVariableDefinitions();
    const selections = parseSelectionSet();
    return { kind, name, selections };
  }

  const operations = [];
  while (peek().kind !== 'eof') {
    operations.push(parseOperation());
  }
  return operations;
}

function resolveValue(value, variables) {
  if (value && typeof value === 'object') {
    if ('var' in value) return variables[value.var] ?? null;
    if ('enum' in value) return value.enum;
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, variables));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, variables);
    return out;
  }
  return value;
}

function resolveArgs(args, variables) {
  const out = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, variables);
  return out;
}

// ---------------------------------------------------------------- lookups
function findRepoById(id) {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

function findIssueById(id) {
  for (const repo of store.repos.values()) {
    const issue = repo.issues.find((i) => i.id === id);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullById(id) {
  for (const repo of store.repos.values()) {
    const pull = repo.pulls.find((p) => p.id === id);
    if (pull) return { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------- introspection
const INTROSPECTION = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: null,
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'ORGANIZATION'];

// ---------------------------------------------------------------- execution
// A resolved object carries __kind so the executor knows which fields it has.
function gqlRepo(repo) {
  return { __kind: 'Repository', __repo: repo };
}

function gqlIssue(repo, issue) {
  return { __kind: 'Issue', __repo: repo, __issue: issue };
}

function gqlPull(repo, pull) {
  return { __kind: 'PullRequest', __repo: repo, __pull: pull };
}

function stateUpper(state) {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullFiles(repo, pull) {
  const headTree = parseCommit(getObject(repo, pull.headSha).data).tree;
  const baseTree = parseCommit(getObject(repo, pull.baseSha).data).tree;
  return diffTrees(repo, baseTree, headTree).map((d) => ({ path: d.path }));
}

function pullMergeable(repo, pull) {
  return pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

function listIssuesGql(repo, args) {
  let list = [...repo.issues];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy ?? {};
  const field = orderBy.field ?? 'CREATED_AT';
  const direction = orderBy.direction ?? 'ASC';
  if (field === 'CREATED_AT' || field === 'UPDATED_AT') {
    list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  } else if (field === 'COMMENTS') {
    list.sort((a, b) => {
      const ca = (repo.comments.get(a.number) ?? []).length;
      const cb = (repo.comments.get(b.number) ?? []).length;
      return direction === 'DESC' ? cb - ca : ca - cb;
    });
  }
  const after = parseIssueCursor(args.after ?? null);
  if (after > 0) {
    // In DESC order the cursor is the last number seen; in ASC order likewise.
    if (direction === 'DESC') list = list.filter((i) => i.number < after);
    else list = list.filter((i) => i.number > after);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const nodes = list.slice(0, first);
  const hasNextPage = list.length > nodes.length;
  const endCursor = nodes.length > 0 ? issueCursor(nodes[nodes.length - 1].number) : '';
  return {
    __kind: 'IssueConnection',
    nodes: nodes.map((i) => gqlIssue(repo, i)),
    pageInfo: { __kind: 'PageInfo', hasNextPage, endCursor },
  };
}

function execSelections(kind, value, selections, variables, errors) {
  const out = {};
  for (const sel of selections) {
    if (sel.fragment) {
      if (sel.typeName && value?.__kind !== sel.typeName) continue;
      const sub = execSelections(kind, value, sel.selections, variables, errors);
      Object.assign(out, sub);
      continue;
    }
    const args = resolveArgs(sel.args, variables);
    const key = sel.alias;
    const result = execField(kind, value, sel.field, args, sel.selections, variables, errors);
    if (result === undefined) {
      errors.push({ message: `Cannot query field "${sel.field}" on type "${kind}"` });
      out[key] = null;
      continue;
    }
    out[key] = result;
  }
  return out;
}

function execField(kind, value, field, args, sub, variables, errors) {
  // Query root
  if (kind === 'Query') {
    if (field === 'viewer') {
      const viewer = { __kind: 'User', login: VIEWER.login };
      return sub ? execSelections('User', viewer, sub, variables, errors) : viewer;
    }
    if (field === 'repository') {
      const repo = getRepo(args.owner, args.name);
      if (!repo) return null;
      const wrapped = gqlRepo(repo);
      return sub ? execSelections('Repository', wrapped, sub, variables, errors) : wrapped;
    }
    if (field === 'node') {
      const parsed = parseGlobalId(args.id);
      if (!parsed) return null;
      let wrapped = null;
      if (parsed.kind === 'Repository') {
        const repo = findRepoById(parsed.num);
        if (repo) wrapped = gqlRepo(repo);
      } else if (parsed.kind === 'Issue') {
        const found = findIssueById(parsed.num);
        if (found) wrapped = gqlIssue(found.repo, found.issue);
      } else if (parsed.kind === 'PullRequest') {
        const found = findPullById(parsed.num);
        if (found) wrapped = gqlPull(found.repo, found.pull);
      }
      if (!wrapped) return null;
      return sub ? execSelections(wrapped.__kind, wrapped, sub, variables, errors) : wrapped;
    }
    if (field === '__type') {
      return execTypeField(args.name, sub, variables, errors);
    }
    return undefined;
  }

  if (kind === 'User') {
    if (field === 'login') return value.login;
    return undefined;
  }

  if (kind === 'Repository') {
    const repo = value.__repo;
    if (field === 'id') return repoGlobalId(repo);
    if (field === 'databaseId') return repo.id;
    if (field === 'name') return repo.name;
    if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (field === 'owner') {
      const owner = { __kind: 'User', login: repo.owner };
      return sub ? execSelections('User', owner, sub, variables, errors) : owner;
    }
    if (field === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      const ref = { __kind: 'Ref', name: repo.defaultBranch };
      return sub ? execSelections('Ref', ref, sub, variables, errors) : ref;
    }
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'issue') {
      const issue = repo.issues.find((i) => i.number === args.number);
      if (!issue) return null;
      const wrapped = gqlIssue(repo, issue);
      return sub ? execSelections('Issue', wrapped, sub, variables, errors) : wrapped;
    }
    if (field === 'issues') {
      const conn = listIssuesGql(repo, args);
      return sub ? execSelections('IssueConnection', conn, sub, variables, errors) : conn;
    }
    if (field === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
      const nodes = repo.pulls.filter((p) => p.state === 'open').slice(0, first);
      const conn = {
        __kind: 'PullRequestConnection',
        nodes: nodes.map((p) => gqlPull(repo, p)),
        pageInfo: { __kind: 'PageInfo', hasNextPage: false, endCursor: '' },
      };
      return sub ? execSelections('PullRequestConnection', conn, sub, variables, errors) : conn;
    }
    if (field === 'pullRequest') {
      const pull = repo.pulls.find((p) => p.number === args.number);
      if (!pull) return null;
      const wrapped = gqlPull(repo, pull);
      return sub ? execSelections('PullRequest', wrapped, sub, variables, errors) : wrapped;
    }
    return undefined;
  }

  if (kind === 'Issue') {
    const issue = value.__issue;
    if (field === 'id') return issueGlobalId(issue);
    if (field === 'number') return issue.number;
    if (field === 'title') return issue.title;
    if (field === 'state') return stateUpper(issue.state);
    if (field === 'body') return issue.body ?? '';
    return undefined;
  }

  if (kind === 'PullRequest') {
    const pull = value.__pull;
    const repo = value.__repo;
    if (field === 'id') return pullGlobalId(pull);
    if (field === 'number') return pull.number;
    if (field === 'headRefName') return pull.head;
    if (field === 'baseRefName') return pull.base;
    if (field === 'mergeable') return pullMergeable(repo, pull);
    if (field === 'state') return pull.merged ? 'MERGED' : stateUpper(pull.state);
    if (field === 'merged') return pull.merged;
    if (field === 'files') {
      const first = typeof args.first === 'number' ? args.first : 10;
      const nodes = pullFiles(repo, pull).slice(0, first).map((f) => ({ __kind: 'File', path: f.path }));
      const conn = { __kind: 'FileConnection', nodes };
      return sub ? execSelections('FileConnection', conn, sub, variables, errors) : conn;
    }
    return undefined;
  }

  if (kind === 'IssueConnection') {
    if (field === 'nodes') {
      return value.nodes.map((n) => execSelections('Issue', n, sub, variables, errors));
    }
    if (field === 'pageInfo') {
      return sub ? execSelections('PageInfo', value.pageInfo, sub, variables, errors) : value.pageInfo;
    }
    return undefined;
  }

  if (kind === 'PullRequestConnection') {
    if (field === 'nodes') {
      return value.nodes.map((n) => execSelections('PullRequest', n, sub, variables, errors));
    }
    if (field === 'pageInfo') {
      return sub ? execSelections('PageInfo', value.pageInfo, sub, variables, errors) : value.pageInfo;
    }
    return undefined;
  }

  if (kind === 'FileConnection') {
    if (field === 'nodes') {
      return value.nodes.map((n) => execSelections('File', n, sub, variables, errors));
    }
    return undefined;
  }

  if (kind === 'File') {
    if (field === 'path') return value.path;
    return undefined;
  }

  if (kind === 'PageInfo') {
    if (field === 'hasNextPage') return value.hasNextPage;
    if (field === 'endCursor') return value.endCursor;
    return undefined;
  }

  if (kind === 'Ref') {
    if (field === 'name') return value.name;
    return undefined;
  }

  // Mutation payload wrappers (createIssue / closeIssue / createPullRequest /
  // mergePullRequest / addComment): their fields resolve to a wrapped object.
  if (PAYLOAD_FIELDS[kind]) {
    const inner = PAYLOAD_FIELDS[kind](value, field);
    if (inner === undefined) return undefined;
    if (inner && typeof inner === 'object' && inner.__kind && sub) {
      return execSelections(inner.__kind, inner, sub, variables, errors);
    }
    return inner;
  }

  if (kind === 'CommentEdge') {
    if (field === 'node') {
      const node = value.node;
      return sub ? execSelections('Comment', node, sub, variables, errors) : node;
    }
    return undefined;
  }

  if (kind === 'Comment') {
    if (field === 'id') return value.id;
    if (field === 'body') return value.body;
    return undefined;
  }

  return undefined;
}

function execTypeField(name, sub, variables, errors) {
  if (name === 'SearchType') {
    const out = {};
    for (const sel of sub ?? []) {
      if (sel.field === 'enumValues') {
        out[sel.alias] = SEARCH_TYPE_VALUES.map((n) => ({ name: n }));
      }
    }
    return out;
  }
  const fields = INTROSPECTION[name];
  if (!fields) return null;
  const out = {};
  for (const sel of sub ?? []) {
    if (sel.field === 'fields') {
      out[sel.alias] = fields.map((n) => ({ name: n }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- mutations
function execMutation(operation, variables, errors) {
  const out = {};
  for (const sel of operation.selections) {
    const args = resolveArgs(sel.args, variables);
    const input = args.input ?? {};
    const key = sel.alias;
    if (sel.field === 'createIssue') {
      const parsed = parseGlobalId(input.repositoryId);
      const repo = parsed?.kind === 'Repository' ? findRepoById(parsed.num) : null;
      if (!repo) {
        errors.push({ message: 'repository not found' });
        out[key] = null;
        continue;
      }
      const issue = {
        id: 0,
        number: repo.issueSeq++,
        title: input.title ?? '',
        body: input.body ?? '',
        state: 'open',
        labels: [],
        createdAt: '2023-11-14T22:13:20Z',
        updatedAt: '2023-11-14T22:13:20Z',
      };
      // Issue ids come from the store's global counter (same as REST).
      issue.id = nextIssueIdForGql();
      repo.issues.push(issue);
      repo.comments.set(issue.number, []);
      const wrapped = gqlIssue(repo, issue);
      out[key] = sel.selections
        ? execSelections('CreateIssuePayload', { __kind: 'CreateIssuePayload', __issue: wrapped }, sel.selections, variables, errors)
        : { issue: wrapped };
      continue;
    }
    if (sel.field === 'closeIssue') {
      const parsed = parseGlobalId(input.issueId);
      const found = parsed?.kind === 'Issue' ? findIssueById(parsed.num) : null;
      if (!found) {
        errors.push({ message: 'issue not found' });
        out[key] = null;
        continue;
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = '2023-11-14T22:13:20Z';
      const wrapped = gqlIssue(found.repo, found.issue);
      out[key] = sel.selections
        ? execSelections('CloseIssuePayload', { __kind: 'CloseIssuePayload', __issue: wrapped }, sel.selections, variables, errors)
        : { issue: wrapped };
      continue;
    }
    if (sel.field === 'createPullRequest') {
      const parsed = parseGlobalId(input.repositoryId);
      const repo = parsed?.kind === 'Repository' ? findRepoById(parsed.num) : null;
      if (!repo) {
        errors.push({ message: 'repository not found' });
        out[key] = null;
        continue;
      }
      const head = input.headRefName ?? '';
      const base = input.baseRefName ?? '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        errors.push({ message: 'head and base branches must exist' });
        out[key] = null;
        continue;
      }
      const dup = repo.pulls.find((p) => p.head === head && p.state === 'open');
      if (dup) {
        errors.push({ message: 'a pull request from this head already exists' });
        out[key] = null;
        continue;
      }
      const pull = {
        id: nextPullIdForGql(),
        number: repo.pullSeq++,
        title: input.title ?? '',
        body: '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head,
        headSha,
        base,
        baseSha,
        createdAt: '2023-11-14T22:13:20Z',
        updatedAt: '2023-11-14T22:13:20Z',
      };
      repo.pulls.push(pull);
      const wrapped = gqlPull(repo, pull);
      out[key] = sel.selections
        ? execSelections('CreatePullRequestPayload', { __kind: 'CreatePullRequestPayload', __pull: wrapped }, sel.selections, variables, errors)
        : { pullRequest: wrapped };
      continue;
    }
    if (sel.field === 'mergePullRequest') {
      const parsed = parseGlobalId(input.pullRequestId);
      const found = parsed?.kind === 'PullRequest' ? findPullById(parsed.num) : null;
      if (!found) {
        errors.push({ message: 'pull request not found' });
        out[key] = null;
        continue;
      }
      const { repo, pull } = found;
      if (pull.merged) {
        errors.push({ message: 'pull request is already merged' });
        out[key] = null;
        continue;
      }
      pull.headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
      pull.baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
      if (pullConflict(repo, pull)) {
        errors.push({ message: 'merge conflict: head and base both changed the same file' });
        out[key] = null;
        continue;
      }
      doSquashMerge(repo, pull);
      const wrapped = gqlPull(repo, pull);
      out[key] = sel.selections
        ? execSelections('MergePullRequestPayload', { __kind: 'MergePullRequestPayload', __pull: wrapped }, sel.selections, variables, errors)
        : { pullRequest: wrapped };
      continue;
    }
    if (sel.field === 'addComment') {
      const parsed = parseGlobalId(input.subjectId);
      const found = parsed?.kind === 'Issue' ? findIssueById(parsed.num) : null;
      if (!found) {
        errors.push({ message: 'issue not found' });
        out[key] = null;
        continue;
      }
      const comment = { id: nextCommentIdForGql(), body: input.body ?? '' };
      found.repo.comments.get(found.issue.number).push(comment);
      const node = { __kind: 'Comment', id: commentGlobalId(comment), body: comment.body };
      const edge = { __kind: 'CommentEdge', node };
      const payload = { __kind: 'AddCommentPayload', __edge: edge };
      out[key] = sel.selections
        ? execSelections('AddCommentPayload', payload, sel.selections, variables, errors)
        : { commentEdge: edge };
      continue;
    }
    errors.push({ message: `Cannot query field "${sel.field}" on type "Mutation"` });
    out[key] = null;
  }
  return out;
}

// Payload field resolvers (createIssue / closeIssue / createPullRequest /
// mergePullRequest / addComment return a wrapper whose fields are resolved
// here, so the selections under the mutation name work).
const PAYLOAD_FIELDS = {
  CreateIssuePayload: (payload, field) => (field === 'issue' ? payload.__issue : undefined),
  CloseIssuePayload: (payload, field) => (field === 'issue' ? payload.__issue : undefined),
  CreatePullRequestPayload: (payload, field) => (field === 'pullRequest' ? payload.__pull : undefined),
  MergePullRequestPayload: (payload, field) => (field === 'pullRequest' ? payload.__pull : undefined),
  AddCommentPayload: (payload, field) => (field === 'commentEdge' ? payload.__edge : undefined),
};

// The global counters live in store.ts; these thin wrappers keep this file's
// imports explicit.
function nextIssueIdForGql() { return counters.issueId++; }
function nextPullIdForGql() { return counters.pullId++; }
function nextCommentIdForGql() { return counters.commentId++; }

// ---------------------------------------------------------------- entry point
// body: the parsed JSON request body (one operation object or an array).
// Returns the response object (or array) to JSON-stringify.
export function handleGraphQL(body) {
  if (Array.isArray(body)) {
    return body.map((op) => runOperation(op));
  }
  return runOperation(body);
}

function runOperation(op) {
  try {
    if (!op || typeof op.query !== 'string') {
      return { data: null, errors: [{ message: 'query is required' }] };
    }
    const variables = op.variables ?? {};
    const operations = parseDocument(op.query);
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'empty document' }] };
    }
    const operation = operations[0];
    const errors = [];
    let data;
    if (operation.kind === 'mutation') {
      data = execMutation(operation, variables, errors);
    } else {
      // Payload objects (issue/pull under a mutation) are handled by
      // execSelections via the payload kinds below.
      data = execSelections('Query', null, operation.selections, variables, errors);
    }
    if (errors.length > 0) return { data, errors };
    return { data };
  } catch (e) {
    return { data: null, errors: [{ message: e.message }] };
  }
}
