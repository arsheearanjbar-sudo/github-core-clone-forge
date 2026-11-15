// The forge's single in-memory store: git objects, refs, repositories, issues,
// pull requests, labels and comments. Every surface (git, REST, GraphQL, MCP)
// reads and writes this one store, so an object created on one surface is the
// same object on every other. All timestamps come from a deterministic logical
// clock: identical request sequences produce identical responses.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const SCENARIO_EPOCH_SEC = 1_735_689_600;

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObjectRec {
  type: ObjType;
  /** Inflated byte length, as the pack header declares it. */
  size: number;
  /** The zlib stream, kept verbatim so pack assembly never re-deflates. */
  deflated: Buffer;
  /** Inflated bytes, decoded lazily on first parse and then cached. */
  data: Buffer | null;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  committerName: string;
  committerEmail: string;
  committerTs: number;
  message: string;
}

export interface ParsedTag {
  target: string;
  targetType: ObjType;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRequest {
  kind: 'pr';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  createdSeq: number;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export type IssueOrPr = Issue | PullRequest;

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  dbId: number;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  nextLabelId: number;
  nextNumber: number;
  items: Map<number, IssueOrPr>;
  nextCommentId: number;
  comments: Map<number, CommentRec[]>;
}

/** SHA-1 of a git object header plus its bytes: the object's id. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Format a logical-clock second as a GitHub-style UTC timestamp (no millis). */
export function isoSecond(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

/** Opaque Relay-style global ids: base64 of a typed key, never the bare number. */
export function globalId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'Comment', dbId: number, number?: number): string {
  const key = number === undefined ? `${kind}:${dbId}` : `${kind}:${dbId}:${number}`;
  return Buffer.from(key, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; dbId: number; number: number | null } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const kind = parts[0];
  const dbId = Number(parts[1]);
  if (!Number.isInteger(dbId) || dbId <= 0) return null;
  if (parts.length === 3) {
    const number = Number(parts[2]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { kind, dbId, number };
  }
  return { kind, dbId, number: null };
}

/** Parse a commit object's headers. The raw bytes stay authoritative; this reads structure. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const parseIdent = (ident: string): { name: string; email: string; ts: number } => {
    const lt = ident.indexOf('<');
    const gt = ident.indexOf('>', lt);
    const name = lt > 0 ? ident.slice(0, lt).trim() : ident.trim();
    const email = lt >= 0 && gt > lt ? ident.slice(lt + 1, gt) : '';
    const tail = gt >= 0 ? ident.slice(gt + 1).trim().split(/\s+/) : [];
    const ts = tail.length > 0 ? Number(tail[0]) : 0;
    return { name, email, ts: Number.isFinite(ts) ? ts : 0 };
  };
  const a = parseIdent(author);
  const c = parseIdent(committer);
  return {
    tree,
    parents,
    authorName: a.name,
    authorEmail: a.email,
    authorTs: a.ts,
    committerName: c.name,
    committerEmail: c.email,
    committerTs: c.ts,
    message,
  };
}

/** Build canonical commit bytes: tree, parents, author, committer, blank line, message. */
export function buildCommitBytes(tree: string, parents: string[], ts: number, message: string): Buffer {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return Buffer.from(out, 'utf8');
}

/** Parse a tree object's binary entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directory names compare with a trailing slash. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Encode tree entries in git order. */
export function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse an annotated tag object's target. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  let target = '';
  let targetType: ObjType = 'commit';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) target = line.slice(7).trim();
    else if (line.startsWith('type ')) {
      const t = line.slice(5).trim();
      if (t === 'commit' || t === 'tree' || t === 'blob' || t === 'tag') targetType = t;
    }
  }
  return { target, targetType };
}

export class Store {
  readonly objects = new Map<string, GitObjectRec>();
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  private nextRepoId = 1;
  private nextEntityId = 1;
  private clock = 0;
  private commitCache = new Map<string, ParsedCommit>();
  private treeCache = new Map<string, TreeEntry[]>();
  private tagCache = new Map<string, ParsedTag>();
  private flattenCache = new Map<string, Map<string, { oid: string; mode: string }>>();

  /** Next logical-clock second, starting at the scenario epoch. */
  tick(): number {
    const ts = SCENARIO_EPOCH_SEC + this.clock;
    this.clock += 1;
    return ts;
  }

  /** Store a fresh object from inflated bytes; returns its id. */
  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, size: data.length, deflated: deflateSync(data), data });
    }
    return oid;
  }

  /** Store an object whose deflated bytes are already known (from a pack). */
  putObjectPacked(type: ObjType, size: number, deflated: Buffer, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, size, deflated, data });
    }
    return oid;
  }

  getObject(oid: string): GitObjectRec | undefined {
    return this.objects.get(oid);
  }

  /** Inflated bytes for an object, decoding lazily. */
  objectData(oid: string): Buffer | null {
    const rec = this.objects.get(oid);
    if (!rec) return null;
    if (rec.data === null) rec.data = inflateSync(rec.deflated);
    return rec.data;
  }

  getCommit(oid: string): ParsedCommit | null {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const data = this.objectData(oid);
    if (data === null) return null;
    const rec = this.objects.get(oid);
    if (!rec || rec.type !== 'commit') return null;
    const parsed = parseCommit(data);
    this.commitCache.set(oid, parsed);
    return parsed;
  }

  getTree(oid: string): TreeEntry[] | null {
    const cached = this.treeCache.get(oid);
    if (cached) return cached;
    const data = this.objectData(oid);
    if (data === null) return null;
    const rec = this.objects.get(oid);
    if (!rec || rec.type !== 'tree') return null;
    const parsed = parseTree(data);
    this.treeCache.set(oid, parsed);
    return parsed;
  }

  getTag(oid: string): ParsedTag | null {
    const cached = this.tagCache.get(oid);
    if (cached) return cached;
    const data = this.objectData(oid);
    if (data === null) return null;
    const rec = this.objects.get(oid);
    if (!rec || rec.type !== 'tag') return null;
    const parsed = parseTag(data);
    this.tagCache.set(oid, parsed);
    return parsed;
  }

  /** Follow annotated tags until a non-tag object. Returns the peeled id and type. */
  peel(oid: string): { oid: string; type: ObjType } | null {
    let current = oid;
    const seen = new Set<string>();
    for (;;) {
      const rec = this.objects.get(current);
      if (!rec) return null;
      if (rec.type !== 'tag') return { oid: current, type: rec.type };
      if (seen.has(current)) return null;
      seen.add(current);
      const tag = this.getTag(current);
      if (!tag || !tag.target) return null;
      current = tag.target;
    }
  }

  /** All ancestors of a commit (itself included), via parent links. */
  ancestors(start: string): Set<string> {
    const out = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      out.add(oid);
      const commit = this.getCommit(oid);
      if (commit) for (const p of commit.parents) stack.push(p);
    }
    return out;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestors(descendant).has(ancestor);
  }

  /** The merge-base: the first common ancestor found walking from `a`. */
  mergeBase(a: string, b: string): string | null {
    const bAncestors = this.ancestors(b);
    const seen = new Set<string>();
    const queue = [a];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (bAncestors.has(oid)) return oid;
      const commit = this.getCommit(oid);
      if (commit) for (const p of commit.parents) queue.push(p);
    }
    return null;
  }

  /** Commits reachable from a tip, newest first (depth-first, parents in order). */
  commitWalk(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (oid: string): void => {
      if (seen.has(oid)) return;
      seen.add(oid);
      const commit = this.getCommit(oid);
      if (!commit) return;
      out.push(oid);
      for (const p of commit.parents) visit(p);
    };
    visit(tip);
    return out;
  }

  /** Flatten a tree to path -> {oid, mode}, memoised per tree id. Gitlinks are skipped. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const cached = this.flattenCache.get(treeOid);
    if (cached) return cached;
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const entries = this.getTree(oid);
      if (!entries) return;
      for (const e of entries) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else if (e.mode === '160000') continue;
        else out.set(path, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, '');
    this.flattenCache.set(treeOid, out);
    return out;
  }

  /** Build nested trees from a flat path map; returns the root tree id. */
  buildTreeFromFlat(flat: Map<string, { oid: string; mode: string }>): string {
    const buildLevel = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, value] of flat) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: value.mode, name: rest, oid: value.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (!sub) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, value);
        }
      }
      for (const [dir, sub] of dirs) {
        const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
        entries.push({ mode: '40000', name: dir, oid: buildLevel(childPrefix) });
      }
      return this.putObject('tree', buildTreeBytes(entries));
    };
    return buildLevel('');
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const ts = this.tick();
    const repo: Repo = {
      dbId: this.nextRepoId++,
      name,
      isPrivate,
      description,
      defaultBranch: 'main',
      createdSeq: ts,
      createdAt: isoSecond(ts),
      updatedAt: isoSecond(ts),
      refs: new Map(),
      labels: new Map(),
      nextLabelId: 1,
      nextNumber: 1,
      items: new Map(),
      nextCommentId: 1,
      comments: new Map(),
    };
    this.repos.set(name, repo);
    this.reposById.set(repo.dbId, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    const repo = this.repos.get(name);
    if (!repo) return false;
    this.repos.delete(name);
    this.reposById.delete(repo.dbId);
    return true;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  getRepoById(dbId: number): Repo | undefined {
    return this.reposById.get(dbId);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.dbId - b.dbId);
  }

  /** Resolve a branch name, full ref, or commit id to a commit id. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isOid(ref) && this.objects.has(ref)) {
      const peeled = this.peel(ref);
      return peeled && peeled.type === 'commit' ? peeled.oid : ref;
    }
    const direct = repo.refs.get(ref);
    if (direct) {
      const peeled = this.peel(direct);
      return peeled ? peeled.oid : direct;
    }
    const headed = repo.refs.get(`refs/heads/${ref}`);
    if (headed) {
      const peeled = this.peel(headed);
      return peeled ? peeled.oid : headed;
    }
    const tagged = repo.refs.get(`refs/tags/${ref}`);
    if (tagged) {
      const peeled = this.peel(tagged);
      return peeled ? peeled.oid : tagged;
    }
    return null;
  }

  nextEntity(): number {
    return this.nextEntityId++;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const ts = this.tick();
    const issue: Issue = {
      kind: 'issue',
      id: this.nextEntity(),
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: ts,
      updatedSeq: ts,
      createdAt: isoSecond(ts),
      updatedAt: isoSecond(ts),
      closedAt: null,
    };
    repo.items.set(issue.number, issue);
    return issue;
  }

  createPullRequest(repo: Repo, title: string, body: string, head: string, base: string): PullRequest {
    const ts = this.tick();
    const pr: PullRequest = {
      kind: 'pr',
      id: this.nextEntity(),
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      head,
      base,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      createdSeq: ts,
      updatedSeq: ts,
      createdAt: isoSecond(ts),
      updatedAt: isoSecond(ts),
      closedAt: null,
    };
    repo.items.set(pr.number, pr);
    return pr;
  }

  addComment(repo: Repo, number: number, body: string): CommentRec {
    const ts = this.tick();
    const comment: CommentRec = {
      id: repo.nextCommentId++,
      body,
      createdAt: isoSecond(ts),
      updatedAt: isoSecond(ts),
    };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    return comment;
  }

  /** File-level three-way merge of flat trees. A path changed on both sides to different bytes conflicts. */
  threeWayMerge(
    base: Map<string, { oid: string; mode: string }>,
    ours: Map<string, { oid: string; mode: string }>,
    theirs: Map<string, { oid: string; mode: string }>,
  ): { flat: Map<string, { oid: string; mode: string }>; conflict: boolean } {
    const flat = new Map<string, { oid: string; mode: string }>();
    let conflict = false;
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (x: { oid: string } | undefined, y: { oid: string } | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      if (same(t, b)) {
        if (o) flat.set(path, o);
      } else if (same(o, b)) {
        if (t) flat.set(path, t);
      } else if (same(o, t)) {
        if (o) flat.set(path, o);
      } else {
        conflict = true;
        if (o) flat.set(path, o);
      }
    }
    return { flat, conflict };
  }

  /** Whether a pull request merges cleanly, without changing anything. */
  prMergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const headTip = this.resolveRef(repo, pr.head);
    const baseTip = this.resolveRef(repo, pr.base);
    if (!headTip || !baseTip) return 'UNKNOWN';
    const headCommit = this.getCommit(headTip);
    const baseCommit = this.getCommit(baseTip);
    if (!headCommit || !baseCommit) return 'UNKNOWN';
    const baseOid = this.mergeBase(headTip, baseTip);
    if (!baseOid) return 'UNKNOWN';
    const mergeBaseCommit = this.getCommit(baseOid);
    if (!mergeBaseCommit) return 'UNKNOWN';
    const merged = this.threeWayMerge(
      this.flattenTree(mergeBaseCommit.tree),
      this.flattenTree(baseCommit.tree),
      this.flattenTree(headCommit.tree),
    );
    return merged.conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Squash-merge a pull request onto its base branch. Returns the squash commit id, or null on conflict. */
  squashMerge(repo: Repo, pr: PullRequest): string | null {
    const headTip = this.resolveRef(repo, pr.head);
    const baseTip = this.resolveRef(repo, pr.base);
    if (!headTip || !baseTip) return null;
    const headCommit = this.getCommit(headTip);
    const baseCommit = this.getCommit(baseTip);
    if (!headCommit || !baseCommit) return null;
    const baseOid = this.mergeBase(headTip, baseTip);
    if (!baseOid) return null;
    const baseCommitObj = this.getCommit(baseOid);
    if (!baseCommitObj) return null;
    const merged = this.threeWayMerge(
      this.flattenTree(baseCommitObj.tree),
      this.flattenTree(baseCommit.tree),
      this.flattenTree(headCommit.tree),
    );
    if (merged.conflict) return null;
    const treeOid = this.buildTreeFromFlat(merged.flat);
    const ts = this.tick();
    const message = `${pr.title} (#${pr.number})\n`;
    const commitOid = this.putObject('commit', buildCommitBytes(treeOid, [baseTip], ts, message));
    repo.refs.set(`refs/heads/${pr.base}`, commitOid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = isoSecond(ts);
    pr.mergeSha = commitOid;
    pr.closedAt = isoSecond(ts);
    pr.updatedSeq = ts;
    pr.updatedAt = isoSecond(ts);
    repo.updatedAt = isoSecond(ts);
    return commitOid;
  }

  /** Diff two trees: per-path status with line counts, sorted by path. */
  diffTrees(
    baseTree: string | null,
    headTree: string,
  ): Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> {
    const baseFlat = baseTree ? this.flattenTree(baseTree) : new Map<string, { oid: string; mode: string }>();
    const headFlat = this.flattenTree(headTree);
    const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> = [];
    const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      if (b && h && b.oid === h.oid) continue;
      if (!b && h) {
        out.push({ path, status: 'added', additions: countLines(this.objectData(h.oid)), deletions: 0 });
      } else if (b && !h) {
        out.push({ path, status: 'removed', additions: 0, deletions: countLines(this.objectData(b.oid)) });
      } else if (b && h) {
        const counts = diffLineCounts(this.objectData(b.oid), this.objectData(h.oid));
        out.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
      }
    }
    return out;
  }
}

/** Line count of blob bytes (a trailing newline does not add an empty line). */
export function countLines(data: Buffer | null): number {
  if (!data || data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Added/removed line counts via common prefix and suffix lines. */
export function diffLineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const split = (data: Buffer | null): string[] => {
    if (!data || data.length === 0) return [];
    const lines = data.toString('utf8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = split(oldData);
  const newLines = split(newData);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { additions: newLines.length - prefix - suffix, deletions: oldLines.length - prefix - suffix };
}
