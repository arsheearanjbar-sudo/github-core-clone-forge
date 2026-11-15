// MCP: JSON-RPC 2.0 over Streamable HTTP at /mcp. Speaks the modern
// 2026-07-28 era (`server/discover`, no handshake, no session) and answers the
// legacy `initialize` handshake too. Six tools share the store with REST and
// GraphQL, so MCP-created objects are the same objects everywhere.

import { issueJson, prJson, repoJson } from './rest.ts';
import { Store, VIEWER, type Issue, type PullRequest } from './store.ts';

export interface McpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string }>; required: string[] };
}

/** The tool list, built once: two tools/list answers serialise byte for byte. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token user.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonResult(status: number, body: unknown): McpResult {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'),
  };
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return jsonResult(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): McpResult {
  return jsonResult(200, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolOk(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolFail(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** First present value under any of the names (the suite maps to the first). */
function pick(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const v = args[name];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function missingArg(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function resolveRepo(store: Store, args: Record<string, unknown>): { repo: ReturnType<Store['getRepo']>; error: string | null } {
  let owner = pick(args, ['owner', 'owner_login', 'org', 'user', 'login']);
  let repoName = pick(args, ['repo', 'repository', 'repo_name', 'repository_name']);
  if ((owner === undefined || repoName === undefined) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = owner ?? parts[0];
      repoName = repoName ?? parts[1];
    }
  }
  if (typeof owner !== 'string' || typeof repoName !== 'string') return { repo: undefined, error: 'owner and repo are required' };
  if (owner !== VIEWER.login) return { repo: undefined, error: `unknown owner ${owner}` };
  const repo = store.getRepo(repoName);
  if (!repo) return { repo: undefined, error: `repository ${repoName} does not exist` };
  return { repo, error: null };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const requiredOf: Record<string, string[]> = {
    create_repo: ['name'],
    get_repo: ['owner', 'repo'],
    create_issue: ['owner', 'repo', 'title'],
    list_issues: ['owner', 'repo'],
    create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
    merge_pull_request: ['owner', 'repo', 'pull_number'],
  };
  const synonymOf: Record<string, string[]> = {
    owner: ['owner', 'owner_login', 'org', 'user', 'login'],
    repo: ['repo', 'repository', 'repo_name', 'repository_name'],
    title: ['title', 'issue_title', 'subject'],
    head: ['head', 'head_ref', 'head_branch', 'source_branch'],
    base: ['base', 'base_ref', 'base_branch', 'target_branch'],
    pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number'],
    name: ['name', 'repo', 'repository'],
  };
  for (const key of requiredOf[name] ?? []) {
    if (missingArg(pick(args, synonymOf[key] ?? [key]))) return toolFail(`Missing required argument: ${key}`);
  }

  if (name === 'create_repo') {
    const repoName = pick(args, ['name']) as string;
    const owner = pick(args, ['owner', 'owner_login', 'org', 'user', 'login']);
    if (owner !== undefined && owner !== VIEWER.login) return toolFail(`unknown owner ${String(owner)}`);
    const existing = store.getRepo(repoName);
    if (existing) return toolOk(repoJson(existing));
    const description = pick(args, ['description', 'about', 'summary']);
    const isPrivate = pick(args, ['private', 'is_private']);
    const repo = store.createRepo(repoName, isPrivate === true, typeof description === 'string' ? description : '');
    return toolOk(repoJson(repo));
  }

  const { repo, error } = resolveRepo(store, args);
  if (!repo) return toolFail(error ?? 'repository not found');

  if (name === 'get_repo') return toolOk(repoJson(repo));

  if (name === 'create_issue') {
    const title = pick(args, ['title', 'issue_title', 'subject']) as string;
    const body = pick(args, ['body', 'issue_body', 'description', 'content', 'text']);
    const issue = store.createIssue(repo, title, typeof body === 'string' ? body : '', []);
    return toolOk(issueJson(store, repo, issue));
  }

  if (name === 'list_issues') {
    const state = pick(args, ['state', 'status']);
    const wanted = typeof state === 'string' && state !== '' ? state : 'open';
    const items = [...repo.items.values()]
      .filter((i): i is Issue => i.kind === 'issue')
      .filter((i) => (wanted === 'all' ? true : i.state === wanted))
      .sort((a, b) => a.number - b.number);
    return toolOk(items.map((i) => issueJson(store, repo, i)));
  }

  if (name === 'create_pull_request') {
    const title = pick(args, ['title', 'issue_title', 'subject']) as string;
    const body = pick(args, ['body', 'issue_body', 'description', 'content', 'text']);
    const head = pick(args, ['head', 'head_ref', 'head_branch', 'source_branch']) as string;
    const base = pick(args, ['base', 'base_ref', 'base_branch', 'target_branch']) as string;
    if (!store.resolveRef(repo, head) || !store.resolveRef(repo, base)) return toolFail('head or base branch does not exist');
    for (const existing of repo.items.values()) {
      if (existing.kind === 'pr' && existing.state === 'open' && existing.head === head && existing.base === base) {
        return toolOk(prJson(store, repo, existing));
      }
    }
    const pr = store.createPullRequest(repo, title, typeof body === 'string' ? body : '', head, base);
    return toolOk(prJson(store, repo, pr));
  }

  if (name === 'merge_pull_request') {
    const raw = pick(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number']);
    const number = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(number) || number <= 0) return toolFail('pull_number must be a positive integer');
    const item = repo.items.get(number);
    if (!item || item.kind !== 'pr') return toolFail(`pull request #${number} does not exist`);
    const pr: PullRequest = item;
    if (pr.merged) return toolOk(prJson(store, repo, pr));
    if (pr.state !== 'open') return toolFail(`pull request #${number} is closed`);
    const sha = store.squashMerge(repo, pr);
    if (sha === null) return toolFail('merge conflict: the pull request cannot be merged cleanly');
    return toolOk(prJson(store, repo, pr));
  }

  return toolFail(`unknown tool ${name}`);
}

function handleOne(store: Store, request: unknown): McpResult | null {
  if (!isRecord(request)) return rpcError(null, -32600, 'Invalid Request');
  const id = 'id' in request ? request.id : undefined;
  const method = request.method;
  if (typeof method !== 'string') return id === undefined ? null : rpcError(id, -32600, 'Invalid Request');
  // Notifications (no id) get no JSON-RPC answer.
  if (id === undefined) return null;
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const offered = params.protocolVersion;
    const negotiated = typeof offered === 'string' && SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = params.name;
    if (typeof toolName !== 'string' || toolName === '') return rpcError(id, -32602, 'tools/call needs a tool name');
    if (!TOOL_NAMES.has(toolName)) return rpcError(id, -32601, `unknown tool ${toolName}`);
    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      return rpcResult(id, callTool(store, toolName, args));
    } catch (e) {
      return rpcResult(id, toolFail(e instanceof Error ? e.message : 'tool failed'));
    }
  }
  if (method === 'ping') return rpcResult(id, {});
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** Handle POST /mcp. Returns null when the path is not the MCP endpoint. */
export function handleMcp(store: Store, method: string, pathname: string, bodyBytes: Buffer): McpResult | null {
  if (pathname !== '/mcp') return null;
  if (method === 'DELETE') return { status: 200, headers: {}, body: Buffer.alloc(0) };
  if (method !== 'POST') return jsonResult(404, { message: 'Not Found' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyBytes.toString('utf8'));
  } catch {
    return {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`, 'utf8'),
    };
  }
  if (Array.isArray(parsed)) {
    const results: unknown[] = [];
    for (const entry of parsed) {
      const r = handleOne(store, entry);
      if (r !== null) results.push(JSON.parse(r.body.toString('utf8')));
    }
    return jsonResult(200, results);
  }
  const result = handleOne(store, parsed);
  if (result === null) return { status: 202, headers: {}, body: Buffer.alloc(0) };
  return result;
}
