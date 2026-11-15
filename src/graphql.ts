// GraphQL v4: a small lexer, parser and executor for the documents gh and
// github-mcp-server send. No schema library: the executor resolves the fixed
// surface (viewer, repository, issues, pull requests, node, __type and the
// five mutations) against the shared store, so GraphQL reads and writes are
// the same objects REST and MCP see.

import { decodeGlobalId, globalId, isoSecond, Store, VIEWER, type Issue, type PullRequest, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: src.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < src.length && isNameChar(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST and parser
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
}

export type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] };

export interface Operation {
  opType: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefaults: Record<string, ValueNode>;
  selections: SelectionNode[];
}

export interface FragmentDef {
  typeCondition: string;
  selections: SelectionNode[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
  }

  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${t.value}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ opType: 'query', name: null, varDefaults: {}, selections: this.parseSelectionSet() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        operations.push(this.parseOperation());
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${t.value} in document`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    const opType = this.next().value as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const varDefaults: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          varDefaults[varName] = this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    return { opType, name, varDefaults, selections: this.parseSelectionSet() };
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

type Obj =
  | { t: 'Query' }
  | { t: 'Mutation' }
  | { t: 'User' }
  | { t: 'Repository'; repo: Repo }
  | { t: 'Issue'; repo: Repo; issue: Issue }
  | { t: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { t: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { t: 'PullRequestConnection'; repo: Repo; prs: PullRequest[] }
  | { t: 'ChangedFilesConnection'; files: Array<{ path: string; additions: number; deletions: number }> }
  | { t: 'ChangedFile'; file: { path: string; additions: number; deletions: number } }
  | { t: 'PageInfo'; info: { hasNextPage: boolean; endCursor: string | null } }
  | { t: 'Ref'; name: string }
  | { t: 'Type'; name: string; fields: string[]; enumValues: string[] }
  | { t: 'FieldDef'; name: string }
  | { t: 'EnumValueDef'; name: string }
  | { t: 'IssuePayload'; repo: Repo; issue: Issue }
  | { t: 'PrPayload'; repo: Repo; pr: PullRequest }
  | { t: 'CommentPayload'; repo: Repo; comment: { id: number; body: string } }
  | { t: 'CommentEdge'; repo: Repo; comment: { id: number; body: string } }
  | { t: 'Comment'; repo: Repo; comment: { id: number; body: string } };

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string; path: Array<string | number> }>;
}

function valueOf(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = ctx.variables[node.name];
      return v === undefined ? null : v;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => valueOf(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = valueOf(v, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = valueOf(v, ctx);
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'isPrivate'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl'],
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Node: ['id'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function buildIssueConnection(store: Store, repo: Repo, args: Record<string, unknown>): Obj {
  let items = [...repo.items.values()].filter((i): i is Issue => i.kind === 'issue');
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((s) => String(s)));
    items = items.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  const keyOf = (i: Issue): number => {
    if (field === 'UPDATED_AT') return i.updatedSeq;
    if (field === 'COMMENTS') return (repo.comments.get(i.number) ?? []).length;
    return i.createdSeq;
  };
  items.sort((a, b) => {
    const d = keyOf(a) - keyOf(b);
    return d !== 0 ? d * direction : (a.number - b.number) * direction;
  });
  const afterNum = decodeCursor(args.after);
  if (afterNum !== null) {
    items = direction === 1 ? items.filter((i) => i.number > afterNum) : items.filter((i) => i.number < afterNum);
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : 30;
  const hasNextPage = items.length > first;
  const page = items.slice(0, first);
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  return { t: 'IssueConnection', repo, issues: page, pageInfo: { hasNextPage, endCursor } };
}

function resolveField(ctx: ExecCtx, parent: Obj, field: FieldNode, path: Array<string | number>): unknown {
  const store = ctx.store;
  const args = argsOf(field, ctx);
  const fail = (message: string): null => {
    ctx.errors.push({ message, path });
    return null;
  };
  const unknown = (): null => fail(`Cannot query field "${field.name}" on type "${parent.t}".`);

  if (field.name === '__typename') return parent.t === 'Type' ? '__Type' : parent.t;

  switch (parent.t) {
    case 'Query': {
      if (field.name === 'viewer') return { t: 'User' } satisfies Obj;
      if (field.name === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (owner !== VIEWER.login || typeof name !== 'string') return null;
        const repo = store.getRepo(name);
        return repo ? ({ t: 'Repository', repo } satisfies Obj) : null;
      }
      if (field.name === 'node') {
        const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
        if (!decoded) return null;
        const repo = store.getRepoById(decoded.dbId);
        if (!repo) return null;
        if (decoded.kind === 'Repository') return { t: 'Repository', repo } satisfies Obj;
        if (decoded.number !== null) {
          const item = repo.items.get(decoded.number);
          if (!item) return null;
          if (decoded.kind === 'Issue' && item.kind === 'issue') return { t: 'Issue', repo, issue: item } satisfies Obj;
          if (decoded.kind === 'PullRequest' && item.kind === 'pr') return { t: 'PullRequest', repo, pr: item } satisfies Obj;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        const fields = TYPE_FIELDS[name];
        const enumValues = TYPE_ENUM_VALUES[name];
        if (!fields && !enumValues) return null;
        return { t: 'Type', name, fields: fields ?? [], enumValues: enumValues ?? [] } satisfies Obj;
      }
      return unknown();
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = decoded ? store.getRepoById(decoded.dbId) : undefined;
        if (!repo || decoded?.kind !== 'Repository') return fail('createIssue: unknown repositoryId');
        if (typeof input.title !== 'string' || input.title === '') return fail('createIssue: title is required');
        const issue = store.createIssue(repo, input.title, typeof input.body === 'string' ? input.body : '', []);
        return { t: 'IssuePayload', repo, issue } satisfies Obj;
      }
      if (field.name === 'closeIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
        const repo = decoded ? store.getRepoById(decoded.dbId) : undefined;
        const item = repo && decoded?.number !== null ? repo.items.get(decoded!.number!) : undefined;
        if (!repo || !item || item.kind !== 'issue') return fail('closeIssue: unknown issueId');
        const ts = store.tick();
        item.state = 'closed';
        item.closedAt = isoSecond(ts);
        item.updatedSeq = ts;
        item.updatedAt = isoSecond(ts);
        return { t: 'IssuePayload', repo, issue: item } satisfies Obj;
      }
      if (field.name === 'createPullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = decoded ? store.getRepoById(decoded.dbId) : undefined;
        if (!repo || decoded?.kind !== 'Repository') return fail('createPullRequest: unknown repositoryId');
        const head = input.headRefName;
        const base = input.baseRefName;
        if (typeof head !== 'string' || typeof base !== 'string') return fail('createPullRequest: headRefName and baseRefName are required');
        if (!store.resolveRef(repo, head) || !store.resolveRef(repo, base)) return fail('createPullRequest: head or base branch does not exist');
        for (const existing of repo.items.values()) {
          if (existing.kind === 'pr' && existing.state === 'open' && existing.head === head && existing.base === base) {
            return { t: 'PrPayload', repo, pr: existing } satisfies Obj;
          }
        }
        if (typeof input.title !== 'string' || input.title === '') return fail('createPullRequest: title is required');
        const pr = store.createPullRequest(repo, input.title, typeof input.body === 'string' ? input.body : '', head, base);
        return { t: 'PrPayload', repo, pr } satisfies Obj;
      }
      if (field.name === 'mergePullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
        const repo = decoded ? store.getRepoById(decoded.dbId) : undefined;
        const item = repo && decoded?.number !== null ? repo.items.get(decoded!.number!) : undefined;
        if (!repo || !item || item.kind !== 'pr') return fail('mergePullRequest: unknown pullRequestId');
        if (item.merged) return { t: 'PrPayload', repo, pr: item } satisfies Obj;
        if (item.state !== 'open') return fail('mergePullRequest: pull request is closed');
        const sha = store.squashMerge(repo, item);
        if (sha === null) return fail('mergePullRequest: merge conflict');
        return { t: 'PrPayload', repo, pr: item } satisfies Obj;
      }
      if (field.name === 'addComment') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
        const repo = decoded ? store.getRepoById(decoded.dbId) : undefined;
        const item = repo && decoded?.number !== null ? repo.items.get(decoded!.number!) : undefined;
        if (!repo || !item) return fail('addComment: unknown subjectId');
        if (typeof input.body !== 'string' || input.body === '') return fail('addComment: body is required');
        const comment = store.addComment(repo, item.number, input.body);
        return { t: 'CommentPayload', repo, comment } satisfies Obj;
      }
      return unknown();
    }
    case 'User': {
      if (field.name === 'login') return VIEWER.login;
      return unknown();
    }
    case 'Repository': {
      const repo = parent.repo;
      if (field.name === 'id') return globalId('Repository', repo.dbId);
      if (field.name === 'databaseId') return repo.dbId;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${VIEWER.login}/${repo.name}`;
      if (field.name === 'owner') return { t: 'User' } satisfies Obj;
      if (field.name === 'defaultBranchRef') {
        return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? ({ t: 'Ref', name: repo.defaultBranch } satisfies Obj) : null;
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'isPrivate') return repo.isPrivate;
      if (field.name === 'issue') {
        const item = typeof args.number === 'number' ? repo.items.get(args.number) : undefined;
        return item && item.kind === 'issue' ? ({ t: 'Issue', repo, issue: item } satisfies Obj) : null;
      }
      if (field.name === 'issues') return buildIssueConnection(store, repo, args);
      if (field.name === 'pullRequest') {
        const item = typeof args.number === 'number' ? repo.items.get(args.number) : undefined;
        return item && item.kind === 'pr' ? ({ t: 'PullRequest', repo, pr: item } satisfies Obj) : null;
      }
      if (field.name === 'pullRequests') {
        const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : 30;
        const prs = [...repo.items.values()].filter((i): i is PullRequest => i.kind === 'pr').sort((a, b) => b.number - a.number);
        return { t: 'PullRequestConnection', repo, prs: prs.slice(0, first) } satisfies Obj;
      }
      return unknown();
    }
    case 'Issue': {
      const issue = parent.issue;
      if (field.name === 'id') return globalId('Issue', parent.repo.dbId, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return issue.body;
      return unknown();
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return parent.issues.map((issue) => ({ t: 'Issue', repo: parent.repo, issue }) satisfies Obj);
      if (field.name === 'pageInfo') return { t: 'PageInfo', info: parent.pageInfo } satisfies Obj;
      if (field.name === 'totalCount') return parent.issues.length;
      return unknown();
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.info.hasNextPage;
      if (field.name === 'endCursor') return parent.info.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return parent.info.endCursor;
      return unknown();
    }
    case 'PullRequest': {
      const pr = parent.pr;
      if (field.name === 'id') return globalId('PullRequest', parent.repo.dbId, pr.number);
      if (field.name === 'number') return pr.number;
      if (field.name === 'title') return pr.title;
      if (field.name === 'body') return pr.body;
      if (field.name === 'state') return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'merged') return pr.merged;
      if (field.name === 'headRefName') return pr.head;
      if (field.name === 'baseRefName') return pr.base;
      if (field.name === 'mergeable') return store.prMergeable(parent.repo, pr);
      if (field.name === 'files') {
        const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : 30;
        const headTip = store.resolveRef(parent.repo, pr.head);
        const baseTip = store.resolveRef(parent.repo, pr.base);
        let files: Array<{ path: string; additions: number; deletions: number }> = [];
        if (headTip && baseTip) {
          const headCommit = store.getCommit(headTip);
          const baseOid = store.mergeBase(headTip, baseTip);
          if (headCommit) {
            const baseTree = baseOid ? (store.getCommit(baseOid)?.tree ?? null) : null;
            files = store.diffTrees(baseTree, headCommit.tree);
          }
        }
        return { t: 'ChangedFilesConnection', files: files.slice(0, first) } satisfies Obj;
      }
      return unknown();
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return parent.prs.map((pr) => ({ t: 'PullRequest', repo: parent.repo, pr }) satisfies Obj);
      return unknown();
    }
    case 'ChangedFilesConnection': {
      if (field.name === 'nodes') return parent.files.map((file) => ({ t: 'ChangedFile', file }) satisfies Obj);
      return unknown();
    }
    case 'ChangedFile': {
      if (field.name === 'path') return parent.file.path;
      if (field.name === 'additions') return parent.file.additions;
      if (field.name === 'deletions') return parent.file.deletions;
      return unknown();
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name;
      return unknown();
    }
    case 'Type': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'fields') return parent.fields.map((name) => ({ t: 'FieldDef', name }) satisfies Obj);
      if (field.name === 'enumValues') return parent.enumValues.map((name) => ({ t: 'EnumValueDef', name }) satisfies Obj);
      return unknown();
    }
    case 'FieldDef':
    case 'EnumValueDef': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'description') return null;
      return unknown();
    }
    case 'IssuePayload': {
      if (field.name === 'issue') return { t: 'Issue', repo: parent.repo, issue: parent.issue } satisfies Obj;
      return unknown();
    }
    case 'PrPayload': {
      if (field.name === 'pullRequest') return { t: 'PullRequest', repo: parent.repo, pr: parent.pr } satisfies Obj;
      return unknown();
    }
    case 'CommentPayload': {
      if (field.name === 'commentEdge') return { t: 'CommentEdge', repo: parent.repo, comment: parent.comment } satisfies Obj;
      return unknown();
    }
    case 'CommentEdge': {
      if (field.name === 'node') return { t: 'Comment', repo: parent.repo, comment: parent.comment } satisfies Obj;
      return unknown();
    }
    case 'Comment': {
      if (field.name === 'id') return globalId('Comment', parent.repo.dbId, parent.comment.id);
      if (field.name === 'body') return parent.comment.body;
      return unknown();
    }
  }
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && 't' in (v as Record<string, unknown>);
}

function executeSelections(ctx: ExecCtx, selections: SelectionNode[], parent: Obj, path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path });
        continue;
      }
      if (frag.typeCondition !== parent.t && frag.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelections(ctx, frag.selections, parent, path));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition !== null && sel.typeCondition !== parent.t && sel.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelections(ctx, sel.selections, parent, path));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    const value = resolveField(ctx, parent, sel, fieldPath);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((entry, index) => {
        if (isObj(entry)) return executeSelections(ctx, sel.selections, entry, [...fieldPath, index]);
        return entry;
      });
      continue;
    }
    if (isObj(value)) {
      out[key] = executeSelections(ctx, sel.selections, value, fieldPath);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export interface GraphQLEnvelope {
  data: unknown;
  errors?: Array<{ message: string; path?: Array<string | number> }>;
}

function executeOperation(store: Store, doc: Document, operationName: unknown, variables: Record<string, unknown>): GraphQLEnvelope {
  let op: Operation | undefined;
  if (typeof operationName === 'string' && operationName !== '') {
    op = doc.operations.find((o) => o.name === operationName);
    if (!op) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else {
    if (doc.operations.length !== 1) {
      return { data: null, errors: [{ message: 'Must provide operation name when multiple operations are present.' }] };
    }
    op = doc.operations[0];
  }
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, def] of Object.entries(op.varDefaults)) {
    if (vars[name] === undefined) {
      const tmp: ExecCtx = { store, variables: vars, fragments: doc.fragments, errors: [] };
      vars[name] = valueOf(def, tmp);
    }
  }
  const ctx: ExecCtx = { store, variables: vars, fragments: doc.fragments, errors: [] };
  const root: Obj = op.opType === 'mutation' ? { t: 'Mutation' } : { t: 'Query' };
  const data = executeSelections(ctx, op.selections, root, []);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

export interface GraphQLResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function jsonResult(status: number, body: unknown): GraphQLResult {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'),
  };
}

/** Handle POST /api/graphql (single operations and JSON-array batches). */
export function handleGraphQL(store: Store, method: string, pathname: string, bodyBytes: Buffer): GraphQLResult | null {
  if (pathname !== '/api/graphql') return null;
  if (method !== 'POST') return jsonResult(404, { message: 'Not Found' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyBytes.toString('utf8'));
  } catch {
    return jsonResult(400, { message: 'Problems parsing JSON' });
  }
  const runOne = (entry: unknown): GraphQLEnvelope => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'Must provide query string.' }] };
    }
    let doc: Document;
    try {
      doc = new Parser(tokenize(entry.query)).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax Error' }] };
    }
    const variables = isRecord(entry.variables) ? entry.variables : {};
    return executeOperation(store, doc, entry.operationName, variables);
  };
  if (Array.isArray(parsed)) {
    return jsonResult(200, parsed.map(runOne));
  }
  return jsonResult(200, runOne(parsed));
}
