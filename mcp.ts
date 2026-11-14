// MCP (Model Context Protocol) at /mcp. JSON-RPC 2.0 over Streamable HTTP,
// modern era only (revision 2026-07-28): server/discover answers without a
// handshake or a session, so the client never calls initialize. Plain JSON
// responses are sufficient (no SSE). Every tool acts on the same store as
// REST, so a repo or issue created over MCP reads back over /api/v3.

import {
  VIEWER,
  getRepo, createRepoRecord,
  nextIssueId, nextPullId, repoGlobalId, issueGlobalId, pullGlobalId,
} from './store.ts';
import { repoJson } from './rest.ts';
import { pullConflict, doSquashMerge } from './rest.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------- tools
// The six canonical tools, in a fixed order, with the exact property names
// the suite maps its arguments onto. This array is built once: two
// tools/list calls answer the same list, byte for byte.
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_JSON = JSON.stringify({ tools: TOOLS });

// Argument synonyms, per tool (the suite maps its semantic names onto the
// schema's property names; with the canonical names the mapping is exact,
// and these synonyms are only belt and braces).
const SYNONYMS = {
  owner: ['owner', 'owner_login', 'org', 'user', 'login'],
  repo: ['repo', 'repository', 'repo_name'],
  name: ['name', 'repo', 'repository'],
  title: ['title', 'issue_title'],
  body: ['body', 'description', 'content', 'text'],
  head: ['head', 'head_ref', 'source_branch', 'from', 'branch'],
  base: ['base', 'base_ref', 'target'],
  pull_number: ['pull_number', 'pr_number', 'number'],
  private: ['private', 'is_private'],
  description: ['description'],
  state: ['state'],
};

function normalizeArgs(toolName, args) {
  const out = {};
  const wanted = {
    create_repo: ['name', 'description', 'private'],
    get_repo: ['owner', 'repo'],
    create_issue: ['owner', 'repo', 'title', 'body'],
    list_issues: ['owner', 'repo', 'state'],
    create_pull_request: ['owner', 'repo', 'title', 'body', 'head', 'base'],
    merge_pull_request: ['owner', 'repo', 'pull_number'],
  }[toolName] ?? [];
  for (const key of wanted) {
    for (const syn of SYNONYMS[key] ?? [key]) {
      if (args[syn] !== undefined) { out[key] = args[syn]; break; }
    }
  }
  // full_name ("owner/repo") fills owner+repo when no separate repo exists.
  if (typeof args.full_name === 'string' && !out.repo) {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      out.owner = out.owner ?? parts[0];
      out.repo = parts[1];
    }
  }
  return out;
}

// ---------------------------------------------------------------- results
function toolResult(obj) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
  };
}

function toolError(message) {
  const obj = { error: message };
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
    isError: true,
  };
}

function missingArg(name) {
  return toolError(`missing required argument: ${name}`);
}

// ---------------------------------------------------------------- dispatch
function callTool(name, rawArgs) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  const args = normalizeArgs(name, rawArgs ?? {});

  if (name === 'create_repo') {
    if (!args.name) return { result: missingArg('name') };
    const repo = createRepoRecord(args.name, args.private === true, args.description);
    if (!repo) return { result: toolError(`Repository ${args.name} already exists`) };
    return { result: toolResult(repoJson(repo)) };
  }

  // All other tools need owner + repo.
  if (!args.owner || !args.repo) {
    return { result: missingArg(!args.owner ? 'owner' : 'repo') };
  }
  const repo = getRepo(args.owner, args.repo);
  if (!repo) return { result: toolError(`Repository ${args.owner}/${args.repo} not found`) };

  if (name === 'get_repo') {
    return { result: toolResult(repoJson(repo)) };
  }

  if (name === 'create_issue') {
    if (!args.title) return { result: missingArg('title') };
    const issue = {
      id: nextIssueId(),
      number: repo.issueSeq++,
      title: args.title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      createdAt: '2023-11-14T22:13:20Z',
      updatedAt: '2023-11-14T22:13:20Z',
    };
    repo.issues.push(issue);
    repo.comments.set(issue.number, []);
    return { result: toolResult(issueJsonMcp(repo, issue)) };
  }

  if (name === 'list_issues') {
    const state = args.state ?? 'open';
    const list = repo.issues
      .filter((i) => state === 'all' || i.state === state)
      .map((i) => issueJsonMcp(repo, i));
    return { result: toolResult(list) };
  }

  if (name === 'create_pull_request') {
    if (!args.title) return { result: missingArg('title') };
    if (!args.head) return { result: missingArg('head') };
    if (!args.base) return { result: missingArg('base') };
    const headSha = repo.refs.get(`refs/heads/${args.head}`);
    const baseSha = repo.refs.get(`refs/heads/${args.base}`);
    if (!headSha || !baseSha) {
      return { result: toolError('head and base branches must exist') };
    }
    const dup = repo.pulls.find((p) => p.head === args.head && p.state === 'open');
    if (dup) return { result: toolError('a pull request from this head already exists') };
    const pull = {
      id: nextPullId(),
      number: repo.pullSeq++,
      title: args.title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: args.head,
      headSha,
      base: args.base,
      baseSha,
      createdAt: '2023-11-14T22:13:20Z',
      updatedAt: '2023-11-14T22:13:20Z',
    };
    repo.pulls.push(pull);
    return { result: toolResult(pullJsonMcp(repo, pull)) };
  }

  if (name === 'merge_pull_request') {
    const num = Number(args.pull_number);
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return { result: toolError(`pull request #${args.pull_number} not found`) };
    if (pull.merged) return { result: toolError('pull request is already merged') };
    pull.headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
    pull.baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
    if (pullConflict(repo, pull)) {
      return { result: toolError('merge conflict: head and base both changed the same file') };
    }
    doSquashMerge(repo, pull);
    return { result: toolResult(pullJsonMcp(repo, pull)) };
  }

  return { rpcError: { code: -32602, message: `unknown tool: ${name}` } };
}

// The MCP checks read these objects the same way they read REST objects.
function issueJsonMcp(repo, issue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: (issue.labels ?? []).map((n) => ({ name: n })),
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJsonMcp(repo, pull) {
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

// ---------------------------------------------------------------- entry point
// Returns { status, body } where body is already a JS value to stringify
// (or null for an empty 200). The caller sets Content-Type: application/json.
export function handleMcp(bodyText) {
  let req;
  try {
    req = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }

  // A notification (no id) needs no result.
  if (req.id === undefined || req.id === null) {
    return { status: 200, body: {} };
  }

  const ok = (result) => ({ status: 200, body: { jsonrpc: '2.0', id: req.id, result } });
  const err = (code, message, data) => ({
    status: 200,
    body: { jsonrpc: '2.0', id: req.id, error: { code, message, ...(data ? { data } : {}) } },
  });

  if (req.method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return ok({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (req.method === 'tools/list') {
    // The same bytes every call (the tools array is a module constant).
    return { status: 200, body: { jsonrpc: '2.0', id: req.id, result: JSON.parse(TOOLS_JSON) } };
  }

  if (req.method === 'tools/call') {
    const params = req.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    const out = callTool(name, params.arguments ?? {});
    if (out.rpcError) return err(out.rpcError.code, out.rpcError.message);
    return ok(out.result);
  }

  if (req.method === 'initialize') {
    return ok({
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (req.method === 'ping') {
    return ok({});
  }

  return err(-32601, `method not found: ${req.method}`);
}
