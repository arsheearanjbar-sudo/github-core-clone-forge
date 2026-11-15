// REST v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests. Shapes are GitHub-like and generous (the suite
// checks asserted fields only); asserted fields are exact.

import {
  buildCommitBytes,
  countLines,
  globalId,
  hashObject,
  isoSecond,
  Store,
  VIEWER,
  ZERO_OID,
  type CommentRec,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface RestResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function json(status: number, body: unknown, headers: Record<string, string> = {}): RestResult {
  return { status, headers: { 'content-type': JSON_TYPE, ...headers }, body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

function err(status: number, message: string): RestResult {
  return json(status, { message });
}

function empty(status: number): RestResult {
  return { status, headers: {}, body: Buffer.alloc(0) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseBody(bytes: Buffer): Record<string, unknown> {
  if (bytes.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Problems parsing JSON');
  }
  if (!isRecord(parsed)) throw new Error('Problems parsing JSON');
  return parsed;
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

function ownerJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64'),
    avatar_url: '',
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  let openCount = 0;
  for (const item of repo.items.values()) if (item.state === 'open') openCount += 1;
  return {
    id: repo.dbId,
    node_id: globalId('Repository', repo.dbId),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: ownerJson(),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${VIEWER.login}/${repo.name}`,
    clone_url: `https://github.com/${VIEWER.login}/${repo.name}.git`,
    git_url: `git://github.com/${VIEWER.login}/${repo.name}.git`,
    ssh_url: `git@github.com:${VIEWER.login}/${repo.name}.git`,
    homepage: null,
    language: null,
    topics: [],
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openCount,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: Buffer.from(`Label:${label.id}`, 'utf8').toString('base64'), name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.dbId, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: ownerJson(),
    assignee: null,
    assignees: [],
    milestone: null,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { id: 0, name, color: 'ededed', description: '' };
    }),
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: `https://github.com/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
  };
}

export function prJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headSha = store.resolveRef(repo, pr.head) ?? ZERO_OID;
  const baseSha = store.resolveRef(repo, pr.base) ?? ZERO_OID;
  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    ref,
    sha,
    label: `${VIEWER.login}:${ref}`,
    user: ownerJson(),
    repo: { id: repo.dbId, name: repo.name, full_name: `${VIEWER.login}/${repo.name}` },
  });
  return {
    id: pr.id,
    node_id: globalId('PullRequest', repo.dbId, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: ownerJson(),
    assignee: null,
    assignees: [],
    milestone: null,
    labels: [],
    head: refJson(pr.head, headSha),
    base: refJson(pr.base, baseSha),
    merged: pr.merged,
    mergeable: pr.state === 'open' ? store.prMergeable(repo, pr) === 'MERGEABLE' : null,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeSha,
    merged_by: pr.merged ? ownerJson() : null,
    draft: false,
    comments: (repo.comments.get(pr.number) ?? []).length,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    author_association: 'OWNER',
    html_url: `https://github.com/${VIEWER.login}/${repo.name}/pull/${pr.number}`,
  };
}

function commentJson(repo: Repo, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('Comment', repo.dbId, comment.id),
    body: comment.body,
    user: ownerJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function commitJson(store: Store, oid: string): Record<string, unknown> | null {
  const commit = store.getCommit(oid);
  if (!commit) return null;
  const ident = (name: string, email: string, ts: number): Record<string, unknown> => ({ name, email, date: isoSecond(ts) });
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`, 'utf8').toString('base64'),
    commit: {
      message: commit.message,
      author: ident(commit.authorName, commit.authorEmail, commit.authorTs),
      committer: ident(commit.committerName, commit.committerEmail, commit.committerTs),
      tree: { sha: commit.tree },
    },
    author: ownerJson(),
    committer: ownerJson(),
    parents: commit.parents.map((p) => ({ sha: p })),
  };
}

function branchJson(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha }, protected: false };
}

function refJson(ref: string, oid: string, type: string): Record<string, unknown> {
  return { ref, node_id: Buffer.from(`Ref:${ref}`, 'utf8').toString('base64'), object: { sha: oid, type } };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

function paginate<T>(items: T[], query: URLSearchParams, host: string, pathname: string): { page: T[]; headers: Record<string, string> } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const params = new URLSearchParams(query);
    params.set('page', String(page + 1));
    params.set('per_page', String(perPage));
    headers.link = `<http://${host}${pathname}?${params.toString()}>; rel="next"`;
  }
  return { page: slice, headers };
}

// ---------------------------------------------------------------------------
// contents helpers
// ---------------------------------------------------------------------------

/** Navigate a tree by path segments; returns the entry kind, oid and mode, or null. */
function lookupPath(
  store: Store,
  treeOid: string,
  segments: string[],
): { kind: 'file' | 'dir'; oid: string; mode: string; treeOid: string } | null {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entries = store.getTree(current);
    if (!entries) return null;
    const entry = entries.find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      if (entry.mode === '40000') return { kind: 'dir', oid: entry.oid, mode: entry.mode, treeOid: entry.oid };
      return { kind: 'file', oid: entry.oid, mode: entry.mode, treeOid: current };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { kind: 'dir', oid: current, mode: '40000', treeOid: current };
}

function commitOnBranch(
  store: Store,
  repo: Repo,
  branch: string,
  mutate: (flat: Map<string, { oid: string; mode: string }>) => void,
  message: string,
): string {
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) {
    // A new branch starts from the default branch tip, or from nothing when unborn.
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const flat = new Map<string, { oid: string; mode: string }>();
  if (tip) {
    const commit = store.getCommit(tip);
    if (commit) {
      for (const [path, value] of store.flattenTree(commit.tree)) flat.set(path, value);
    }
  }
  mutate(flat);
  const treeOid = store.buildTreeFromFlat(flat);
  const ts = store.tick();
  const parents = tip ? [tip] : [];
  const commitOid = store.putObject('commit', buildCommitBytes(treeOid, parents, ts, message));
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = isoSecond(ts);
  return commitOid;
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

export function handleRest(
  store: Store,
  method: string,
  pathname: string,
  query: URLSearchParams,
  bodyBytes: Buffer,
  host: string,
): RestResult | null {
  const rawSegments = pathname.split('/').filter((s) => s !== '');
  if (rawSegments.length < 2 || rawSegments[0] !== 'api' || rawSegments[1] !== 'v3') return null;
  let segments: string[];
  try {
    segments = rawSegments.map((s) => decodeURIComponent(s));
  } catch {
    return err(404, 'Not Found');
  }

  // API root and meta are public; auth is enforced by the caller for the rest.
  if (segments.length === 2) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(
      200,
      { current_user_url: '/api/v3/user', current_user_repos_url: '/api/v3/user/repos', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (segments.length === 3 && segments[2] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0' });
  }

  let body: Record<string, unknown> | null = null;
  const needBody = (): Record<string, unknown> => {
    if (body === null) body = parseBody(bodyBytes);
    return body;
  };

  try {
    if (segments[2] === 'user' && segments.length === 3) {
      if (method !== 'GET') return err(404, 'Not Found');
      return json(200, {
        ...ownerJson(),
        name: VIEWER.name,
        email: VIEWER.email,
        created_at: isoSecond(1_735_689_600),
        updated_at: isoSecond(1_735_689_600),
        public_repos: store.repos.size,
        followers: 0,
        following: 0,
      });
    }
    if (segments[2] === 'users' && segments.length === 4) {
      if (method !== 'GET') return err(404, 'Not Found');
      if (segments[3] !== VIEWER.login) return err(404, 'Not Found');
      return json(200, { ...ownerJson(), name: VIEWER.name, email: VIEWER.email, type: 'User' });
    }
    if (segments[2] === 'user' && segments[3] === 'repos' && segments.length === 4) {
      if (method === 'GET') {
        const { page, headers } = paginate(store.listRepos(), query, host, pathname);
        return json(200, page.map((r) => repoJson(r)), headers);
      }
      if (method === 'POST') {
        const input = needBody();
        const name = input.name;
        if (typeof name !== 'string' || name === '') return err(422, 'name is required');
        if (store.getRepo(name)) return err(422, `Repository ${name} already exists`);
        const repo = store.createRepo(name, input.private === true, typeof input.description === 'string' ? input.description : '');
        return json(201, repoJson(repo));
      }
      return err(404, 'Not Found');
    }

    if (segments[2] !== 'repos' || segments.length < 5) return err(404, 'Not Found');
    const owner = segments[3];
    const repoName = segments[4];
    if (owner !== VIEWER.login) return err(404, 'Not Found');
    const repo = store.getRepo(repoName);
    if (!repo) return err(404, 'Not Found');
    const rest = segments.slice(5);

    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(repo));
      if (method === 'PATCH') {
        const input = needBody();
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.isPrivate = input.private;
        const ts = store.tick();
        repo.updatedAt = isoSecond(ts);
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repoName);
        return empty(204);
      }
      return err(404, 'Not Found');
    }

    const head = rest[0];

    // branches
    if (head === 'branches') {
      if (method !== 'GET') return err(404, 'Not Found');
      if (rest.length === 1) {
        const branches: Array<Record<string, unknown>> = [];
        for (const [ref, oid] of [...repo.refs.entries()].sort()) {
          if (ref.startsWith('refs/heads/')) branches.push(branchJson(ref.slice('refs/heads/'.length), oid));
        }
        const { page, headers } = paginate(branches, query, host, pathname);
        return json(200, page, headers);
      }
      const branch = rest.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) return err(404, 'Not Found');
      return json(200, branchJson(branch, oid));
    }

    // commits
    if (head === 'commits' && rest.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const refParam = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, refParam);
      if (!tip) {
        if (query.get('sha') === null) return json(200, []);
        return err(404, 'Not Found');
      }
      const walked = store.commitWalk(tip);
      const { page, headers } = paginate(walked, query, host, pathname);
      const out: Array<Record<string, unknown>> = [];
      for (const oid of page) {
        const c = commitJson(store, oid);
        if (c) out.push(c);
      }
      return json(200, out, headers);
    }

    // git refs
    if (head === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const input = needBody();
        const ref = input.ref;
        const sha = input.sha;
        if (typeof ref !== 'string' || !ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
        if (typeof sha !== 'string' || !store.getObject(sha)) return err(422, 'Invalid sha');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        const rec = store.getObject(sha)!;
        return json(201, refJson(ref, sha, rec.type));
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const all = [...repo.refs.entries()].sort().map(([ref, oid]) => refJson(ref, oid, store.getObject(oid)?.type ?? 'commit'));
          return json(200, all);
        }
        const ref = `refs/${rest.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (oid) return json(200, refJson(ref, oid, store.getObject(oid)?.type ?? 'commit'));
        const prefixed = [...repo.refs.entries()].sort().filter(([r]) => r.startsWith(ref));
        if (prefixed.length > 0) {
          return json(200, prefixed.map(([r, o]) => refJson(r, o, store.getObject(o)?.type ?? 'commit')));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // contents
    if (head === 'contents') {
      const pathParts = rest.slice(1);
      const filePath = pathParts.join('/');
      if (method === 'GET') {
        const refParam = query.get('ref') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, refParam);
        if (!tip) return err(404, 'Not Found');
        const commit = store.getCommit(tip);
        if (!commit) return err(404, 'Not Found');
        if (pathParts.length === 0) {
          const entries = store.getTree(commit.tree) ?? [];
          return json(
            200,
            entries.map((e) => ({
              type: e.mode === '40000' ? 'dir' : 'file',
              name: e.name,
              path: e.name,
              sha: e.oid,
              size: e.mode === '40000' ? 0 : (store.getObject(e.oid)?.size ?? 0),
            })),
          );
        }
        const found = lookupPath(store, commit.tree, pathParts);
        if (!found) return err(404, 'Not Found');
        if (found.kind === 'dir') {
          const entries = store.getTree(found.oid) ?? [];
          return json(
            200,
            entries.map((e) => ({
              type: e.mode === '40000' ? 'dir' : 'file',
              name: e.name,
              path: `${filePath}/${e.name}`,
              sha: e.oid,
              size: e.mode === '40000' ? 0 : (store.getObject(e.oid)?.size ?? 0),
            })),
          );
        }
        const data = store.objectData(found.oid);
        if (data === null) return err(404, 'Not Found');
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: pathParts[pathParts.length - 1],
          path: filePath,
          sha: found.oid,
          content: data.toString('base64'),
        });
      }
      if (method === 'PUT') {
        const input = needBody();
        if (pathParts.length === 0 || pathParts.includes('..')) return err(422, 'Invalid path');
        const message = input.message;
        if (typeof message !== 'string' || message === '') return err(422, 'message is required');
        if (typeof input.content !== 'string') return err(422, 'content is required');
        let bytes: Buffer;
        try {
          bytes = Buffer.from(input.content, 'base64');
        } catch {
          return err(422, 'content is not valid base64');
        }
        const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
        const blobOid = hashObject('blob', bytes);
        let existingOid: string | undefined;
        const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip) {
          const commit = store.getCommit(tip);
          if (commit) {
            const flat = store.flattenTree(commit.tree);
            existingOid = flat.get(filePath)?.oid;
          }
        }
        const expectedSha = input.sha;
        if (typeof expectedSha === 'string' && expectedSha !== '') {
          if (!existingOid || existingOid !== expectedSha) return err(409, 'sha does not match the current file');
        }
        const isUpdate = existingOid !== undefined;
        store.putObject('blob', bytes);
        const commitOid = commitOnBranch(
          store,
          repo,
          branch,
          (flat) => {
            const prev = flat.get(filePath);
            flat.set(filePath, { oid: blobOid, mode: prev?.mode ?? '100644' });
          },
          message,
        );
        return json(isUpdate ? 200 : 201, {
          content: { name: pathParts[pathParts.length - 1], path: filePath, sha: blobOid, size: bytes.length, encoding: 'base64' },
          commit: { sha: commitOid, message },
        });
      }
      if (method === 'DELETE') {
        const input = needBody();
        if (pathParts.length === 0) return err(422, 'Invalid path');
        const message = typeof input.message === 'string' ? input.message : '';
        const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return err(404, 'Not Found');
        const commit = store.getCommit(tip);
        if (!commit) return err(404, 'Not Found');
        const flat = store.flattenTree(commit.tree);
        const existing = flat.get(filePath);
        if (!existing) return err(404, 'Not Found');
        const expectedSha = input.sha;
        if (typeof expectedSha === 'string' && expectedSha !== '' && expectedSha !== existing.oid) {
          return err(409, 'sha does not match the current file');
        }
        const commitOid = commitOnBranch(store, repo, branch, (f) => f.delete(filePath), message);
        return json(200, { commit: { sha: commitOid, message } });
      }
      return err(404, 'Not Found');
    }

    // labels
    if (head === 'labels' && rest.length === 1) {
      if (method === 'GET') return json(200, [...repo.labels.values()].map((l) => labelJson(l)));
      if (method === 'POST') {
        const input = needBody();
        const name = input.name;
        if (typeof name !== 'string' || name === '') return err(422, 'name is required');
        const existing = repo.labels.get(name);
        if (existing) return json(201, labelJson(existing));
        const label: Label = {
          id: repo.nextLabelId++,
          name,
          color: typeof input.color === 'string' ? input.color : 'ededed',
          description: typeof input.description === 'string' ? input.description : '',
        };
        repo.labels.set(name, label);
        return json(201, labelJson(label));
      }
      return err(404, 'Not Found');
    }

    // issues
    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          const sign = direction === 'asc' ? 1 : -1;
          const items = [...repo.items.values()].filter((i): i is Issue => i.kind === 'issue');
          const filtered = state === 'all' ? items : items.filter((i) => i.state === state);
          const keyOf = (i: Issue): number => {
            if (sort === 'updated') return i.updatedSeq;
            if (sort === 'comments') return (repo.comments.get(i.number) ?? []).length;
            return i.createdSeq;
          };
          filtered.sort((a, b) => {
            const d = keyOf(a) - keyOf(b);
            return d !== 0 ? d * sign : (a.number - b.number) * sign;
          });
          const { page, headers } = paginate(filtered, query, host, pathname);
          return json(200, page.map((i) => issueJson(store, repo, i)), headers);
        }
        if (method === 'POST') {
          const input = needBody();
          const title = input.title;
          if (typeof title !== 'string' || title === '') return err(422, 'title is required');
          const labels: string[] = [];
          if (input.labels !== undefined) {
            if (!Array.isArray(input.labels)) return err(422, 'labels must be an array');
            for (const label of input.labels) {
              if (typeof label !== 'string') return err(422, 'labels must be names');
              if (!repo.labels.has(label)) return err(422, `Label ${label} does not exist`);
              labels.push(label);
            }
          }
          const issue = store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', labels);
          return json(201, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num) || num <= 0) return err(404, 'Not Found');
      const item = repo.items.get(num);
      if (rest.length === 2) {
        if (!item || item.kind !== 'issue') return err(404, 'Not Found');
        if (method === 'GET') return json(200, issueJson(store, repo, item));
        if (method === 'PATCH') {
          const input = needBody();
          if (typeof input.title === 'string') item.title = input.title;
          if (typeof input.body === 'string') item.body = input.body;
          if (input.state === 'open' || input.state === 'closed') {
            item.state = input.state;
            item.closedAt = input.state === 'closed' ? isoSecond(store.tick()) : null;
          }
          if (input.labels !== undefined) {
            if (!Array.isArray(input.labels)) return err(422, 'labels must be an array');
            const labels: string[] = [];
            for (const label of input.labels) {
              if (typeof label !== 'string' || !repo.labels.has(label)) return err(422, `Label ${String(label)} does not exist`);
              labels.push(label);
            }
            item.labels = labels;
          }
          const ts = store.tick();
          item.updatedSeq = ts;
          item.updatedAt = isoSecond(ts);
          return json(200, issueJson(store, repo, item));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!item) return err(404, 'Not Found');
        if (method === 'GET') {
          return json(200, (repo.comments.get(num) ?? []).map((c) => commentJson(repo, c)));
        }
        if (method === 'POST') {
          const input = needBody();
          if (typeof input.body !== 'string' || input.body === '') return err(422, 'body is required');
          const comment = store.addComment(repo, num, input.body);
          return json(201, commentJson(repo, comment));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // pull requests
    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const items = [...repo.items.values()].filter((i): i is PullRequest => i.kind === 'pr');
          const filtered = state === 'all' ? items : items.filter((p) => p.state === state);
          filtered.sort((a, b) => b.number - a.number);
          const { page, headers } = paginate(filtered, query, host, pathname);
          return json(200, page.map((p) => prJson(store, repo, p)), headers);
        }
        if (method === 'POST') {
          const input = needBody();
          const title = input.title;
          const headRef = input.head;
          const baseRef = input.base;
          if (typeof title !== 'string' || title === '') return err(422, 'title is required');
          if (typeof headRef !== 'string' || headRef === '' || typeof baseRef !== 'string' || baseRef === '') {
            return err(422, 'head and base are required');
          }
          if (!store.resolveRef(repo, headRef) || !store.resolveRef(repo, baseRef)) {
            return err(422, 'head or base branch does not exist');
          }
          for (const existing of repo.items.values()) {
            if (existing.kind === 'pr' && existing.state === 'open' && existing.head === headRef && existing.base === baseRef) {
              return err(422, 'A pull request already exists for this head branch');
            }
          }
          const pr = store.createPullRequest(repo, title, typeof input.body === 'string' ? input.body : '', headRef, baseRef);
          return json(201, prJson(store, repo, pr));
        }
        return err(404, 'Not Found');
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num) || num <= 0) return err(404, 'Not Found');
      const item = repo.items.get(num);
      if (!item || item.kind !== 'pr') return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return json(200, prJson(store, repo, item));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') return err(404, 'Not Found');
        const headTip = store.resolveRef(repo, item.head);
        const baseTip = store.resolveRef(repo, item.base);
        if (!headTip || !baseTip) return err(404, 'Not Found');
        const headCommit = store.getCommit(headTip);
        if (!headCommit) return err(404, 'Not Found');
        const baseOid = store.mergeBase(headTip, baseTip);
        const baseTree = baseOid ? (store.getCommit(baseOid)?.tree ?? null) : null;
        const diff = store.diffTrees(baseTree, headCommit.tree);
        return json(
          200,
          diff.map((d) => ({
            sha: headTip,
            filename: d.path,
            status: d.status,
            additions: d.additions,
            deletions: d.deletions,
            changes: d.additions + d.deletions,
          })),
        );
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') return err(404, 'Not Found');
        if (item.state !== 'open') return err(405, 'Pull request is already closed');
        const sha = store.squashMerge(repo, item);
        if (sha === null) return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
        return json(200, { sha, merged: true, message: `Pull request #${num} successfully merged` });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  } catch (e) {
    if (e instanceof Error && e.message === 'Problems parsing JSON') return err(400, e.message);
    throw e;
  }
}
