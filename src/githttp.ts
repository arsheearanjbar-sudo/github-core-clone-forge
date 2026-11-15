// Git smart HTTP: info/refs advertisements, upload-pack (protocol v2 and v0),
// and receive-pack (v0). The packfile codec lives in gitpack.ts; the store in
// store.ts. Every handler answers with the exact content types and pkt-line
// framing the suite's git client parses.

import type { IncomingHttpHeaders } from 'node:http';
import {
  decodePktLines,
  decodeUntilFlush,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  sidebandPackets,
  writePack,
} from './gitpack.ts';
import { isOid, Store, VIEWER, ZERO_OID, type Repo } from './store.ts';

export interface GitResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function jsonResult(status: number, message: string): GitResult {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'),
  };
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The default branch tip, or ZERO when the repository is unborn. */
function headOid(store: Store, repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

function v0Advertisement(store: Store, repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = headOid(store, repo);
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const rec = store.getObject(oid);
      if (rec && rec.type === 'tag') {
        const peeled = store.peel(oid);
        if (peeled) parts.push(pktLine(`${peeled.oid} ${name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(store: Store, repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const include = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (args.unborn && include('HEAD')) {
      const symref = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      lines.push(pktLine(`unborn HEAD${symref}\n`));
    }
  } else {
    if (include('HEAD')) {
      const symref = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      lines.push(pktLine(`${headOid(store, repo)} HEAD${symref}\n`));
    }
    for (const [name, oid] of refs) {
      if (!include(name)) continue;
      let extra = '';
      if (args.peel) {
        const rec = store.getObject(oid);
        if (rec && rec.type === 'tag') {
          const peeled = store.peel(oid);
          if (peeled) extra = ` peeled:${peeled.oid}`;
        }
      }
      lines.push(pktLine(`${oid} ${name}${extra}\n`));
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------------------
// fetch planning (shared by v2 and v0)
// ---------------------------------------------------------------------------

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

interface FetchPlan {
  sendOids: string[];
  shallowOut: string[];
  unshallowOut: string[];
}

/** The closure of trees and blobs under a tree, skipping gitlinks. */
function treeClosure(store: Store, treeOid: string, out: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    out.add(oid);
    const entries = store.getTree(oid);
    if (!entries) continue;
    for (const e of entries) {
      if (e.mode === '40000') stack.push(e.oid);
      else if (e.mode === '160000') continue;
      else out.add(e.oid);
    }
  }
}

function computeFetch(store: Store, repo: Repo, args: FetchArgs): FetchPlan {
  const includeCommits = new Set<string>();
  const includeObjects = new Set<string>();
  const depthOf = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  const limit = args.depth ?? Number.POSITIVE_INFINITY;

  const seedCommit = (oid: string): void => {
    if (!depthOf.has(oid)) {
      depthOf.set(oid, 0);
      queue.push({ oid, depth: 0 });
    }
  };

  for (const want of args.wants) {
    const rec = store.getObject(want);
    if (!rec) continue;
    if (rec.type === 'commit') seedCommit(want);
    else if (rec.type === 'tag') {
      includeObjects.add(want);
      const peeled = store.peel(want);
      if (peeled && peeled.type === 'commit') seedCommit(peeled.oid);
      else if (peeled && peeled.type === 'tree') treeClosure(store, peeled.oid, includeObjects);
      else if (peeled) includeObjects.add(peeled.oid);
    } else if (rec.type === 'tree') {
      treeClosure(store, want, includeObjects);
    } else {
      includeObjects.add(want);
    }
  }

  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (depthOf.get(oid) !== depth) continue;
    if (depth >= limit) continue;
    const commit = store.getCommit(oid);
    if (!commit) continue;
    if (args.deepenSince !== null && commit.committerTs < args.deepenSince) continue;
    includeCommits.add(oid);
    includeObjects.add(oid);
    treeClosure(store, commit.tree, includeObjects);
    for (const p of commit.parents) {
      if (!depthOf.has(p)) {
        depthOf.set(p, depth + 1);
        queue.push({ oid: p, depth: depth + 1 });
      }
    }
  }

  // The exclusion closure: everything the client already has. Traversal stops
  // at the parents of commits the client declared as shallow boundaries.
  const exclude = new Set<string>();
  const boundaries = new Set(args.shallow);
  const haveSeeds: string[] = [...args.haves];
  for (const ref of args.deepenNot) {
    const resolved = store.resolveRef(repo, ref) ?? repo.refs.get(ref);
    if (resolved) haveSeeds.push(resolved);
  }
  const seenHave = new Set<string>();
  const haveQueue: string[] = [];
  for (const have of haveSeeds) {
    const rec = store.getObject(have);
    if (!rec) continue;
    if (rec.type === 'tag') {
      const peeled = store.peel(have);
      if (peeled && peeled.type === 'commit') haveQueue.push(peeled.oid);
      else if (peeled) exclude.add(peeled.oid);
      exclude.add(have);
    } else if (rec.type === 'commit') {
      haveQueue.push(have);
    } else if (rec.type === 'tree') {
      treeClosure(store, have, exclude);
    } else {
      exclude.add(have);
    }
  }
  while (haveQueue.length > 0) {
    const oid = haveQueue.shift()!;
    if (seenHave.has(oid)) continue;
    seenHave.add(oid);
    exclude.add(oid);
    const commit = store.getCommit(oid);
    if (!commit) continue;
    treeClosure(store, commit.tree, exclude);
    if (boundaries.has(oid)) continue;
    for (const p of commit.parents) haveQueue.push(p);
  }

  const send = new Set<string>();
  for (const oid of includeObjects) if (!exclude.has(oid)) send.add(oid);

  const shallowOut: string[] = [];
  for (const oid of send) {
    if (!includeCommits.has(oid)) continue;
    const commit = store.getCommit(oid);
    if (!commit) continue;
    for (const p of commit.parents) {
      if (store.getObject(p) && !includeCommits.has(p)) {
        shallowOut.push(oid);
        break;
      }
    }
  }
  const unshallowOut: string[] = [];
  for (const boundary of boundaries) {
    if (!includeCommits.has(boundary)) continue;
    const commit = store.getCommit(boundary);
    if (!commit) continue;
    if (commit.parents.every((p) => includeCommits.has(p))) unshallowOut.push(boundary);
  }
  shallowOut.sort();
  unshallowOut.sort();
  return { sendOids: [...send].sort(), shallowOut, unshallowOut };
}

function buildPack(store: Store, oids: string[]): Buffer {
  const entries: Array<{ oid: string; rec: NonNullable<ReturnType<Store['getObject']>> }> = [];
  for (const oid of oids) {
    const rec = store.getObject(oid);
    if (rec) entries.push({ oid, rec });
  }
  return writePack(entries);
}

function fetchV2Response(store: Store, plan: FetchPlan): Buffer {
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim(), pktLine('shallow-info\n')];
  for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktDelim(), pktLine('packfile\n'));
  parts.push(...sidebandPackets(buildPack(store, plan.sendOids)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV0Response(store: Store, plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(buildPack(store, plan.sendOids)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function parseFetchArgsV2(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n >= 0) args.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number(line.slice(13).trim());
      if (Number.isInteger(n)) args.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
  }
  return args;
}

function handleUploadPack(store: Store, repo: Repo, body: Buffer): GitResult {
  const packets = decodePktLines(body);
  const dataLines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const first = dataLines[0] ?? '';
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length).replace(/\n$/, '').trim();
    // Arguments live after the delim packet.
    const delimAt = packets.findIndex((p) => p.kind === 'delim');
    const argPackets = delimAt >= 0 ? packets.slice(delimAt + 1) : packets.slice(1);
    const argLines = argPackets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
    if (command === 'ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const raw of argLines) {
        const line = raw.replace(/\n$/, '');
        if (line === 'peel') lsArgs.peel = true;
        else if (line === 'symrefs') lsArgs.symrefs = true;
        else if (line === 'unborn') lsArgs.unborn = true;
        else if (line.startsWith('ref-prefix ')) lsArgs.prefixes.push(line.slice('ref-prefix '.length));
      }
      return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: handleLsRefs(store, repo, lsArgs) };
    }
    if (command === 'fetch') {
      const args = parseFetchArgsV2(argLines);
      const plan = computeFetch(store, repo, args);
      return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: fetchV2Response(store, plan) };
    }
    return jsonResult(400, `unknown git protocol v2 command ${JSON.stringify(command)}`);
  }
  // Protocol v0: wants/shallow/deepen, flush, haves/done, flush.
  const flushAt = packets.findIndex((p) => p.kind === 'flush');
  const firstSection = (flushAt >= 0 ? packets.slice(0, flushAt) : packets).filter((p) => p.kind === 'data');
  const secondSection = (flushAt >= 0 ? packets.slice(flushAt + 1) : []).filter((p) => p.kind === 'data');
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const p of firstSection) {
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      args.wants.push(rest.split(' ')[0]);
    } else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n >= 0) args.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number(line.slice(13).trim());
      if (Number.isInteger(n)) args.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
  }
  for (const p of secondSection) {
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
  }
  const plan = computeFetch(store, repo, args);
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: fetchV0Response(store, plan) };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitResult {
  const { packets, restOffset } = decodeUntilFlush(body);
  const commandPackets = packets.filter((p) => p.kind === 'data');
  const commands: PushCommand[] = [];
  let sideband = false;
  commandPackets.forEach((p, index) => {
    const text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const head = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    if (index === 0 && nul >= 0) {
      const caps = text.slice(nul + 1).replace(/\n$/, '').split(' ');
      sideband = caps.includes('side-band-64k');
    }
    const parts = head.split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  });

  let unpackError: string | null = null;
  const packBytes = body.subarray(restOffset);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => {
        const data = store.objectData(oid);
        const rec = store.getObject(oid);
        return data && rec ? { type: rec.type, data } : null;
      });
      for (const obj of objects) store.putObjectPacked(obj.type, obj.size, obj.deflated, obj.data);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpacker error\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        if (!current) reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) reportLines.push(`ng ${cmd.ref} old value does not match\n`);
        else {
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
      } else if (cmd.oldOid === ZERO_OID) {
        if (current) reportLines.push(`ng ${cmd.ref} already exists\n`);
        else if (!store.getObject(cmd.newOid)) reportLines.push(`ng ${cmd.ref} object not found\n`);
        else {
          repo.refs.set(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
      } else {
        if (!current) reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        else if (cmd.oldOid !== current) reportLines.push(`ng ${cmd.ref} old value does not match\n`);
        else if (!store.getObject(cmd.newOid)) reportLines.push(`ng ${cmd.ref} object not found\n`);
        else if (cmd.newOid === current) reportLines.push(`ok ${cmd.ref}\n`);
        else {
          const newPeeled = store.peel(cmd.newOid);
          const oldPeeled = store.peel(cmd.oldOid);
          if (!newPeeled || newPeeled.type !== 'commit' || !oldPeeled || oldPeeled.type !== 'commit') {
            reportLines.push(`ng ${cmd.ref} invalid object type\n`);
          } else if (!store.isAncestor(oldPeeled.oid, newPeeled.oid)) {
            reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
          } else {
            repo.refs.set(cmd.ref, cmd.newOid);
            reportLines.push(`ok ${cmd.ref}\n`);
          }
        }
      }
    }
  }

  const reportStream = Buffer.concat([...reportLines.map((l) => pktLine(l)), pktFlush()]);
  const out = sideband ? Buffer.concat([...sidebandPackets(reportStream), pktFlush()]) : reportStream;
  return { status: 200, headers: { 'content-type': RECEIVE_RESULT }, body: out };
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * Handle a git smart-HTTP request. Returns null when the path is not a git
 * path at all; anything else (including unknown repos) gets an answer here.
 */
export function handleGit(
  store: Store,
  method: string,
  pathname: string,
  query: URLSearchParams,
  headers: IncomingHttpHeaders,
  body: Buffer,
): GitResult | null {
  const segments = pathname.split('/').filter((s) => s !== '');
  let action: string;
  if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
    action = 'info/refs';
  } else if (
    segments.length === 3 &&
    (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
  ) {
    action = segments[2];
  } else {
    return null;
  }
  const [owner, repoDotGit] = segments;
  if (!repoDotGit.endsWith('.git')) return null;
  const repoName = repoDotGit.slice(0, -4);
  if (owner !== VIEWER.login) return jsonResult(404, 'Not Found');
  const repo = store.getRepo(repoName);
  if (!repo) return jsonResult(404, 'Not Found');

  try {
    if (action === 'info/refs') {
      if (method !== 'GET') return jsonResult(404, 'Not Found');
      const service = query.get('service') ?? '';
      const protocol = String(headers['git-protocol'] ?? '');
      if (service === 'git-upload-pack') {
        if (protocol.includes('version=2')) {
          return { status: 200, headers: { 'content-type': UPLOAD_AD }, body: v2Advertisement() };
        }
        const caps = 'side-band-64k shallow thin-pack ofs-delta symref=HEAD:refs/heads/main';
        return { status: 200, headers: { 'content-type': UPLOAD_AD }, body: v0Advertisement(store, repo, service, caps) };
      }
      if (service === 'git-receive-pack') {
        const caps = 'report-status side-band-64k delete-refs ofs-delta';
        return { status: 200, headers: { 'content-type': RECEIVE_AD }, body: v0Advertisement(store, repo, service, caps) };
      }
      return jsonResult(404, 'Not Found');
    }
    if (method !== 'POST') return jsonResult(404, 'Not Found');
    if (action === 'git-upload-pack') return handleUploadPack(store, repo, body);
    return handleReceivePack(store, repo, body);
  } catch (err) {
    // A malformed git body must never take the server down: answer 400 and stay up.
    return jsonResult(400, err instanceof Error ? err.message : 'bad git request');
  }
}
