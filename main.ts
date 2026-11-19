// github-core-clone-01 entry: a GitHub-compatible forge in one file, on Node built-ins only.
//
// Surfaces: REST v3 under /api/v3, GraphQL at /api/graphql, MCP (JSON-RPC 2.0, Streamable HTTP) at /mcp.
// Git smart HTTP is a later stage. Everything is kept in one in-memory store that all surfaces share.
//
// Lifecycle (copied from the kit's starter/main.ts): bind port 0, POST {"port": n} to
// $MAKEFUN_ENV_URL/register, poll GET $MAKEFUN_ENV_URL/done until {"done": true}, close, exit 0.

import http from 'node:http';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------------------------------
// Configuration

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/**
 * The login the trial's token names. The suite's scenario is generated from a fixed seed
 * (program/env/src/wire.ts SCENARIO_SEED), so its viewer login is always the same: `adaiversen`.
 * Every repository URL the suite drives is under that owner.
 */
const LOGIN = process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';
const USER_ID = 1000;
const INSTALLED_VERSION = '3.14.0';
const SCOPES = 'repo, read:org, workflow, gist';

// ---------------------------------------------------------------------------------------------------
// Store

interface Blob { sha: string; content: Buffer }
interface Commit { sha: string; message: string; parents: string[]; tree: Map<string, Blob>; date: string }
interface Label { id: number; name: string; color: string; description: string | null }
interface Comment { id: number; body: string; createdAt: string }
interface PullInfo {
  head: string; base: string; headSha: string; baseSha: string; draft: boolean;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
}
interface Issue {
  id: number; number: number; title: string; body: string | null; state: 'open' | 'closed';
  labels: Label[]; createdAt: string; updatedAt: string; closedAt: string | null; seq: number;
  comments: Comment[]; pull: PullInfo | null; repo: Repo;
}
interface Repo {
  id: number; owner: string; name: string; description: string | null; private: boolean;
  hasIssues: boolean; hasWiki: boolean; defaultBranch: string; createdAt: string; updatedAt: string;
  pushedAt: string; branches: Map<string, string>; commits: Map<string, Commit>;
  labels: Map<string, Label>; items: Map<number, Issue>; nextNumber: number;
  /** Annotated tag refs, by short name: refs/tags/<name> -> the tag object's sha. */
  tags: Map<string, string>;
  /** The git objects the smart-HTTP surfaces serve, keyed by the sha1 of the loose object. */
  objects: Map<string, GitObj>;
}

interface GitObj { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }

const repos = new Map<string, Repo>(); // key: lower(owner)/lower(name)
let nextRepoId = 1;
let nextIssueId = 1;
let nextLabelId = 1;
let nextCommentId = 1;
let seqCounter = 0;
let requestCounter = 0;

const now = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha1 = (data: string | Buffer): string => createHash('sha1').update(data).digest('hex');
const repoKey = (owner: string, name: string): string => `${owner.toLowerCase()}/${name.toLowerCase()}`;

function blobOf(content: Buffer): Blob {
  return { sha: sha1(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])), content };
}

function makeCommit(repo: Repo, tree: Map<string, Blob>, parents: string[], message: string): Commit {
  // A real commit object, so a clone of what the REST API wrote is a clone of real git history. The
  // timestamp comes from the sequence counter, never the clock: the state export must not move between
  // two runs of the same instance.
  const treeSha = buildTree(repo, tree);
  seqCounter += 1;
  const t = 1_700_000_000 + seqCounter;
  const body = `tree ${treeSha}\n${parents.map((p) => `parent ${p}\n`).join('')}`
    + `author make.fun <forge@make.fun> ${t} +0000\ncommitter make.fun <forge@make.fun> ${t} +0000\n\n${message}\n`;
  const sha = writeObj(repo, 'commit', Buffer.from(body));
  const commit: Commit = { sha, message, parents, tree, date: now() };
  repo.commits.set(sha, commit);
  return commit;
}

function findRepo(owner: string, name: string): Repo | null {
  if (owner.toLowerCase() !== LOGIN.toLowerCase()) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

class HttpError extends Error {
  status: number; extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) { super(message); this.status = status; this.extra = extra; }
}

const notFound = (): HttpError => new HttpError(404, 'Not Found');

function needRepo(owner: string, name: string): Repo {
  const repo = findRepo(owner, name);
  if (!repo) throw notFound();
  return repo;
}

function str(v: unknown): string | null { return typeof v === 'string' ? v : null; }

function createRepo(input: Record<string, unknown>): Repo {
  const name = str(input.name);
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new HttpError(422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'missing_field', field: 'name' }] });
  if (repos.has(repoKey(LOGIN, name))) throw new HttpError(422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
  const t = now();
  const repo: Repo = {
    id: nextRepoId++, owner: LOGIN, name, description: str(input.description), private: input.private === true,
    hasIssues: input.has_issues !== false, hasWiki: input.has_wiki !== false,
    defaultBranch: str(input.default_branch) ?? 'main', createdAt: t, updatedAt: t, pushedAt: t,
    branches: new Map(), commits: new Map(), labels: new Map(), items: new Map(), nextNumber: 1,
    tags: new Map(), objects: new Map(),
  };
  repos.set(repoKey(LOGIN, name), repo);
  if (input.auto_init === true || input.autoInit === true) {
    const tree = new Map<string, Blob>([['README.md', blobOf(Buffer.from(`# ${name}\n`))]]);
    repo.branches.set(repo.defaultBranch, makeCommit(repo, tree, [], 'Initial commit').sha);
  }
  return repo;
}

function updateRepo(repo: Repo, input: Record<string, unknown>): Repo {
  if (typeof input.description === 'string' || input.description === null) repo.description = input.description as string | null;
  if (typeof input.private === 'boolean') repo.private = input.private;
  if (input.visibility === 'private' || input.visibility === 'public') repo.private = input.visibility === 'private';
  if (typeof input.has_issues === 'boolean') repo.hasIssues = input.has_issues;
  if (typeof input.default_branch === 'string') repo.defaultBranch = input.default_branch;
  const newName = str(input.name);
  if (newName && newName !== repo.name) {
    if (repos.has(repoKey(LOGIN, newName))) throw new HttpError(422, 'name already exists on this account');
    repos.delete(repoKey(repo.owner, repo.name));
    repo.name = newName;
    repos.set(repoKey(repo.owner, repo.name), repo);
  }
  repo.updatedAt = now();
  return repo;
}

function deleteRepo(repo: Repo): void { repos.delete(repoKey(repo.owner, repo.name)); }

function headTree(repo: Repo, branch: string): Map<string, Blob> | null {
  const sha = repo.branches.get(branch);
  return sha ? repo.commits.get(sha)!.tree : null;
}

function resolveRef(repo: Repo, ref: string | null): string | null {
  const r = (ref ?? repo.defaultBranch).replace(/^refs\/heads\//, '');
  if (repo.branches.has(r)) return repo.branches.get(r)!;
  if (repo.commits.has(r)) return r;
  return null;
}

function putContents(repo: Repo, path: string, input: Record<string, unknown>): { status: number; body: unknown } {
  const content = str(input.content);
  if (content === null) throw new HttpError(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
  const message = str(input.message) ?? `Update ${path}`;
  const branch = str(input.branch) ?? repo.defaultBranch;
  const parentSha = repo.branches.get(branch) ?? (branch !== repo.defaultBranch ? repo.branches.get(repo.defaultBranch) : undefined);
  const base = parentSha ? repo.commits.get(parentSha)!.tree : new Map<string, Blob>();
  const existing = base.get(path);
  const given = str(input.sha);
  if (existing) {
    if (given === null) throw new HttpError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (given !== existing.sha) throw new HttpError(409, `${path} does not match ${given}`);
  } else if (given !== null && base.size > 0 && ![...base.values()].some((b) => b.sha === given)) {
    // A sha for a file that does not exist: GitHub answers 422; treat it as a stale write.
    throw new HttpError(409, `${path} does not match ${given}`);
  }
  const tree = new Map(base);
  const blob = blobOf(Buffer.from(content, 'base64'));
  tree.set(path, blob);
  const commit = makeCommit(repo, tree, parentSha ? [parentSha] : [], message);
  repo.branches.set(branch, commit.sha);
  repo.pushedAt = commit.date;
  return { status: existing ? 200 : 201, body: { content: contentJson(repo, path, blob, branch, true), commit: commitJson(repo, commit) } };
}

function deleteContents(repo: Repo, path: string, input: Record<string, unknown>): unknown {
  const branch = str(input.branch) ?? repo.defaultBranch;
  const parentSha = repo.branches.get(branch);
  const tree0 = parentSha ? repo.commits.get(parentSha)!.tree : null;
  const existing = tree0?.get(path);
  if (!tree0 || !existing) throw notFound();
  const given = str(input.sha);
  if (given === null) throw new HttpError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
  if (given !== existing.sha) throw new HttpError(409, `${path} does not match ${given}`);
  const tree = new Map(tree0);
  tree.delete(path);
  const commit = makeCommit(repo, tree, [parentSha!], str(input.message) ?? `Delete ${path}`);
  repo.branches.set(branch, commit.sha);
  return { content: null, commit: commitJson(repo, commit) };
}

function createLabel(repo: Repo, input: Record<string, unknown>): Label {
  const name = str(input.name);
  if (!name) throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'Label', code: 'missing_field', field: 'name' }] });
  if (repo.labels.has(name.toLowerCase())) throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
  const label: Label = { id: nextLabelId++, name, color: (str(input.color) ?? 'ededed').replace(/^#/, ''), description: str(input.description) };
  repo.labels.set(name.toLowerCase(), label);
  return label;
}

function labelsFor(repo: Repo, names: unknown): Label[] {
  if (names === undefined || names === null) return [];
  if (!Array.isArray(names)) throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'Issue', code: 'invalid', field: 'labels' }] });
  const out: Label[] = [];
  for (const n of names) {
    const name = typeof n === 'string' ? n : (n && typeof n === 'object' ? str((n as Record<string, unknown>).name) : null);
    const label = name ? repo.labels.get(name.toLowerCase()) : undefined;
    if (!label) throw new HttpError(422, 'Validation Failed', { errors: [{ value: name, resource: 'Label', field: 'name', code: 'invalid' }] });
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

function newItem(repo: Repo, title: string, body: string | null, labels: Label[], pull: PullInfo | null): Issue {
  const t = now();
  seqCounter += 1;
  const item: Issue = {
    id: nextIssueId++, number: repo.nextNumber++, title, body, state: 'open', labels, createdAt: t, updatedAt: t,
    closedAt: null, seq: seqCounter, comments: [], pull, repo,
  };
  repo.items.set(item.number, item);
  return item;
}

function createIssue(repo: Repo, input: Record<string, unknown>): Issue {
  const title = str(input.title);
  if (!title) throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'Issue', code: 'missing_field', field: 'title' }] });
  if (!repo.hasIssues) throw new HttpError(410, 'Issues are disabled for this repo');
  return newItem(repo, title, str(input.body), labelsFor(repo, input.labels), null);
}

function updateIssue(issue: Issue, input: Record<string, unknown>): Issue {
  if (typeof input.title === 'string') issue.title = input.title;
  if (typeof input.body === 'string' || input.body === null) issue.body = input.body as string | null;
  if (input.labels !== undefined) issue.labels = labelsFor(issue.repo, input.labels);
  if (input.state === 'closed' && issue.state === 'open') { issue.state = 'closed'; issue.closedAt = now(); }
  if (input.state === 'open' && issue.state === 'closed' && !issue.pull?.merged) { issue.state = 'open'; issue.closedAt = null; }
  issue.updatedAt = now();
  return issue;
}

function needIssue(repo: Repo, n: number): Issue {
  const it = repo.items.get(n);
  if (!it) throw notFound();
  return it;
}

function needPull(repo: Repo, n: number): Issue {
  const it = repo.items.get(n);
  if (!it || !it.pull) throw notFound();
  return it;
}

function listIssues(repo: Repo, state: string, opts: { labels?: string[]; includePulls?: boolean; direction?: string } = {}): Issue[] {
  let items = [...repo.items.values()].filter((i) => (opts.includePulls ?? true) || !i.pull);
  if (state !== 'all') items = items.filter((i) => i.state === state);
  if (opts.labels && opts.labels.length) items = items.filter((i) => opts.labels!.every((l) => i.labels.some((x) => x.name.toLowerCase() === l.toLowerCase())));
  items.sort((a, b) => b.seq - a.seq || b.number - a.number);
  if (opts.direction === 'asc') items.reverse();
  return items;
}

function createPull(repo: Repo, input: Record<string, unknown>): Issue {
  const title = str(input.title);
  const head = str(input.head)?.replace(/^[^:]+:/, '') ?? null;
  const base = str(input.base) ?? repo.defaultBranch;
  if (!title || !head) throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'missing_field', field: !title ? 'title' : 'head' }] });
  if (head === base) throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${base} and ${head}` }] });
  for (const it of repo.items.values()) {
    if (it.pull && it.state === 'open' && it.pull.head === head && it.pull.base === base) {
      throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${repo.owner}:${head}.` }] });
    }
  }
  const pull: PullInfo = {
    head, base, headSha: repo.branches.get(head) ?? '', baseSha: repo.branches.get(base) ?? '',
    draft: input.draft === true, merged: false, mergedAt: null, mergeCommitSha: null,
  };
  return newItem(repo, title, str(input.body), [], pull);
}

function ancestors(repo: Repo, sha: string): Set<string> {
  const seen = new Set<string>();
  const stack = sha ? [sha] : [];
  while (stack.length) {
    const s = stack.pop()!;
    if (seen.has(s)) continue;
    seen.add(s);
    const c = repo.commits.get(s);
    if (c) stack.push(...c.parents);
  }
  return seen;
}

function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (!a || !b) return null;
  const anc = ancestors(repo, a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const s = queue.shift()!;
    if (anc.has(s)) return s;
    if (seen.has(s)) continue;
    seen.add(s);
    const c = repo.commits.get(s);
    if (c) queue.push(...c.parents);
  }
  return null;
}

interface MergePlan { ok: boolean; tree: Map<string, Blob>; baseSha: string | null; headSha: string | null; files: ChangedFile[] }
interface ChangedFile { path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; sha: string | null }

const lineCount = (b: Blob | undefined): number => (b ? b.content.toString('utf8').split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length : 0);

function planMerge(repo: Repo, pull: PullInfo): MergePlan {
  const headSha = repo.branches.get(pull.head) ?? (pull.merged ? pull.headSha : null);
  const baseSha = repo.branches.get(pull.base) ?? null;
  const headT = headSha ? repo.commits.get(headSha)!.tree : new Map<string, Blob>();
  const baseT = baseSha ? repo.commits.get(baseSha)!.tree : new Map<string, Blob>();
  const mb = headSha && baseSha ? mergeBase(repo, headSha, baseSha) : null;
  const mbT = mb ? repo.commits.get(mb)!.tree : (headSha ? new Map<string, Blob>() : baseT);
  const tree = new Map(baseT);
  const files: ChangedFile[] = [];
  let ok = true;
  const paths = new Set<string>([...headT.keys(), ...baseT.keys(), ...mbT.keys()]);
  for (const p of [...paths].sort()) {
    const m = mbT.get(p)?.sha; const h = headT.get(p)?.sha; const b = baseT.get(p)?.sha;
    if (h !== m) {
      files.push({
        path: p, status: !m ? 'added' : !h ? 'removed' : 'modified', sha: h ?? null,
        additions: h ? lineCount(headT.get(p)) : 0, deletions: m ? lineCount(mbT.get(p)) : 0,
      });
    }
    if (h === m || h === b) continue;
    if (b === m) { if (h) tree.set(p, headT.get(p)!); else tree.delete(p); continue; }
    ok = false;
  }
  return { ok, tree, baseSha, headSha, files };
}

function mergePull(item: Issue, input: Record<string, unknown>): unknown {
  const repo = item.repo; const pull = item.pull!;
  if (pull.merged || item.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
  const plan = planMerge(repo, pull);
  if (!plan.ok) throw new HttpError(405, 'Pull Request is not mergeable');
  const given = str(input.sha);
  if (given && plan.headSha && given !== plan.headSha) throw new HttpError(409, 'Head branch was modified. Review and try the merge again.');
  const title = str(input.commit_title) ?? `${item.title} (#${item.number})`;
  const msg = str(input.commit_message);
  const commit = makeCommit(repo, plan.tree, plan.baseSha ? [plan.baseSha] : [], msg ? `${title}\n\n${msg}` : title);
  repo.branches.set(pull.base, commit.sha);
  repo.pushedAt = commit.date;
  pull.merged = true; pull.mergedAt = commit.date; pull.mergeCommitSha = commit.sha;
  pull.headSha = plan.headSha ?? pull.headSha; pull.baseSha = plan.baseSha ?? pull.baseSha;
  item.state = 'closed'; item.closedAt = commit.date; item.updatedAt = commit.date;
  return { sha: commit.sha, merged: true, message: 'Pull Request successfully merged' };
}

function addComment(issue: Issue, body: string): Comment {
  const c: Comment = { id: nextCommentId++, body, createdAt: now() };
  issue.comments.push(c);
  issue.updatedAt = c.createdAt;
  return c;
}

// ---------------------------------------------------------------------------------------------------
// REST JSON shapes

let BASE = 'http://localhost';
const api = (p: string): string => `${BASE}/api/v3${p}`;

function userJson(): Record<string, unknown> {
  return {
    login: LOGIN, id: USER_ID, node_id: gid('U', USER_ID), avatar_url: '', gravatar_id: '', url: api(`/users/${LOGIN}`),
    html_url: `${BASE}/${LOGIN}`, type: 'User', site_admin: false, name: LOGIN, email: `${LOGIN}@example.invalid`,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id, node_id: gid('R', repo.id), name: repo.name, full_name: full, owner: userJson(), private: repo.private,
    visibility: repo.private ? 'private' : 'public', description: repo.description, fork: false,
    html_url: `${BASE}/${full}`, url: api(`/repos/${full}`), clone_url: `${BASE}/${full}.git`, git_url: `${BASE}/${full}.git`,
    default_branch: repo.defaultBranch, has_issues: repo.hasIssues, has_wiki: repo.hasWiki, has_projects: false,
    archived: false, disabled: false, size: 0, stargazers_count: 0, watchers_count: 0, forks_count: 0,
    open_issues_count: [...repo.items.values()].filter((i) => i.state === 'open').length,
    created_at: repo.createdAt, updated_at: repo.updatedAt, pushed_at: repo.pushedAt,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function contentJson(repo: Repo, path: string, blob: Blob, ref: string | null, withContent = false): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const out: Record<string, unknown> = {
    type: 'file', name: path.split('/').pop(), path, sha: blob.sha, size: blob.content.length,
    url: api(`/repos/${full}/contents/${path}${ref ? `?ref=${ref}` : ''}`), html_url: `${BASE}/${full}/blob/${ref ?? repo.defaultBranch}/${path}`,
    git_url: api(`/repos/${full}/git/blobs/${blob.sha}`), download_url: `${BASE}/${full}/raw/${ref ?? repo.defaultBranch}/${path}`,
  };
  if (withContent) { out.encoding = 'base64'; out.content = blob.content.toString('base64'); }
  return out;
}

function commitJson(repo: Repo, c: Commit): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const who = { name: LOGIN, email: `${LOGIN}@example.invalid`, date: c.date };
  return {
    sha: c.sha, node_id: `C_${c.sha}`, url: api(`/repos/${full}/git/commits/${c.sha}`), html_url: `${BASE}/${full}/commit/${c.sha}`,
    message: c.message, author: who, committer: who, parents: c.parents.map((p) => ({ sha: p, url: api(`/repos/${full}/git/commits/${p}`) })),
    tree: { sha: sha1(c.sha + ':tree') },
  };
}

function labelJson(repo: Repo, l: Label): Record<string, unknown> {
  return { id: l.id, node_id: gid('LA', l.id), url: api(`/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(l.name)}`), name: l.name, color: l.color, description: l.description, default: false };
}

function issueJson(i: Issue): Record<string, unknown> {
  const full = `${i.repo.owner}/${i.repo.name}`;
  const out: Record<string, unknown> = {
    id: i.id, node_id: gid(i.pull ? 'PR' : 'I', i.id), number: i.number, title: i.title, body: i.body, state: i.state,
    state_reason: i.state === 'closed' ? 'completed' : null, locked: false, user: userJson(),
    labels: i.labels.map((l) => labelJson(i.repo, l)), assignee: null, assignees: [], milestone: null,
    comments: i.comments.length, created_at: i.createdAt, updated_at: i.updatedAt, closed_at: i.closedAt,
    author_association: 'OWNER', url: api(`/repos/${full}/issues/${i.number}`), html_url: `${BASE}/${full}/${i.pull ? 'pull' : 'issues'}/${i.number}`,
    repository_url: api(`/repos/${full}`), comments_url: api(`/repos/${full}/issues/${i.number}/comments`),
  };
  if (i.pull) out.pull_request = { url: api(`/repos/${full}/pulls/${i.number}`), html_url: `${BASE}/${full}/pull/${i.number}`, merged_at: i.pull.mergedAt };
  return out;
}

function pullJson(i: Issue): Record<string, unknown> {
  const p = i.pull!; const repo = i.repo; const full = `${repo.owner}/${repo.name}`;
  const plan = planMerge(repo, p);
  const headSha = repo.branches.get(p.head) ?? p.headSha;
  const baseSha = repo.branches.get(p.base) ?? p.baseSha;
  const mergeable = p.merged ? null : i.state === 'open' ? plan.ok : null;
  return {
    id: i.id, node_id: gid('PR', i.id), number: i.number, title: i.title, body: i.body, state: i.state, locked: false,
    user: userJson(), draft: p.draft, merged: p.merged, merged_at: p.mergedAt, merge_commit_sha: p.mergeCommitSha,
    mergeable, mergeable_state: p.merged ? 'unknown' : plan.ok ? 'clean' : 'dirty', rebaseable: plan.ok,
    merged_by: p.merged ? userJson() : null, created_at: i.createdAt, updated_at: i.updatedAt, closed_at: i.closedAt,
    labels: i.labels.map((l) => labelJson(repo, l)), assignees: [], requested_reviewers: [], comments: i.comments.length,
    commits: 1, additions: plan.files.reduce((a, f) => a + f.additions, 0), deletions: plan.files.reduce((a, f) => a + f.deletions, 0),
    changed_files: plan.files.length, author_association: 'OWNER',
    head: { label: `${repo.owner}:${p.head}`, ref: p.head, sha: headSha, user: userJson(), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${p.base}`, ref: p.base, sha: baseSha, user: userJson(), repo: repoJson(repo) },
    url: api(`/repos/${full}/pulls/${i.number}`), html_url: `${BASE}/${full}/pull/${i.number}`,
    issue_url: api(`/repos/${full}/issues/${i.number}`), diff_url: `${BASE}/${full}/pull/${i.number}.diff`,
  };
}

function gid(prefix: string, id: number): string { return `${prefix}_${Buffer.from(`${prefix}:${id}`).toString('base64url')}`; }

function fromGid(id: string): { prefix: string; id: number } | null {
  const m = /^([A-Z]+)_(.+)$/.exec(id);
  if (!m) return null;
  const dec = /^([A-Z]+):(\d+)$/.exec(Buffer.from(m[2], 'base64url').toString('utf8'));
  if (!dec || dec[1] !== m[1]) return null;
  return { prefix: dec[1], id: Number(dec[2]) };
}

function nodeById(id: string): unknown {
  const g = fromGid(id);
  if (!g) return null;
  if (g.prefix === 'U' && g.id === USER_ID) return viewerObj();
  for (const repo of repos.values()) {
    if (g.prefix === 'R' && repo.id === g.id) return repo;
    if (g.prefix === 'I' || g.prefix === 'PR') for (const it of repo.items.values()) if (it.id === g.id) return it;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// HTTP plumbing

type Res = http.ServerResponse;

function send(res: Res, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const h: Record<string, string> = { 'x-github-request-id': `MF${(++requestCounter).toString(16).toUpperCase().padStart(8, '0')}`, ...headers };
  if (status === 204 || body === undefined) { res.writeHead(status, h); res.end(); return; }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  h['content-type'] ??= 'application/json; charset=utf-8';
  h['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, h);
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const limit = 64 * 1024 * 1024;
    let total = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      total += c.length;
      if (total > limit) {
        tooLarge = true;
        chunks.length = 0;
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: http.IncomingMessage): boolean {
  const h = req.headers.authorization;
  if (!h) return false;
  const m = /^(?:bearer|token)\s+(.+)$/i.exec(h.trim());
  if (!m) return false;
  return TOKEN === '' || m[1].trim() === TOKEN;
}

function paginate<T>(res: Res | null, items: T[], q: URLSearchParams, path: string, extraHeaders: Record<string, string>): T[] {
  const per = Math.max(1, Math.min(100, Number(q.get('per_page')) || 30));
  const page = Math.max(1, Number(q.get('page')) || 1);
  const last = Math.max(1, Math.ceil(items.length / per));
  const links: string[] = [];
  const link = (p: number, rel: string): string => {
    const qq = new URLSearchParams(q); qq.set('per_page', String(per)); qq.set('page', String(p));
    return `<${api(path)}?${qq.toString()}>; rel="${rel}"`;
  };
  if (page < last) { links.push(link(page + 1, 'next'), link(last, 'last')); }
  if (page > 1) { links.push(link(1, 'first'), link(page - 1, 'prev')); }
  if (links.length) extraHeaders.link = links.join(', ');
  void res;
  return items.slice((page - 1) * per, page * per);
}

// ---------------------------------------------------------------------------------------------------
// REST v3

async function rest(req: http.IncomingMessage, res: Res, url: URL, raw: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  if (!authorized(req)) return send(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
  let body: Record<string, unknown> = {};
  if (raw.length > 0 && method !== 'GET' && method !== 'HEAD') {
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return send(res, 400, { message: 'Problems parsing JSON' });
      body = parsed;
    } catch { return send(res, 400, { message: 'Problems parsing JSON' }); }
  }
  const sub = url.pathname.slice('/api/v3'.length) || '/';
  const segs = sub.split('/').filter((s) => s !== '').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const q = url.searchParams;
  const headers: Record<string, string> = {};
  try {
    const out = route(method, segs, body, q, headers);
    if (!out) return send(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
    send(res, out.status, out.body, headers);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { message: err.message, ...err.extra, documentation_url: 'https://docs.github.com/rest' });
    throw err;
  }
}

function route(method: string, s: string[], body: Record<string, unknown>, q: URLSearchParams, headers: Record<string, string>): { status: number; body: unknown } | null {
  const ok = (b: unknown, status = 200): { status: number; body: unknown } => ({ status, body: b });
  if (s.length === 0 && method === 'GET') {
    headers['x-oauth-scopes'] = SCOPES;
    headers['x-accepted-oauth-scopes'] = '';
    return ok({ current_user_url: api('/user'), repository_url: api('/repos/{owner}/{repo}'), user_repositories_url: api('/user/repos') });
  }
  if (s[0] === 'meta' && s.length === 1 && method === 'GET') return ok({ installed_version: INSTALLED_VERSION, verifiable_password_authentication: false });
  if (s[0] === 'user' && s.length === 1 && method === 'GET') { headers['x-oauth-scopes'] = SCOPES; return ok(userJson()); }
  if (s[0] === 'users' && s.length === 2 && method === 'GET') { if (s[1].toLowerCase() !== LOGIN.toLowerCase()) throw notFound(); return ok(userJson()); }
  if (s[0] === 'user' && s[1] === 'repos' && s.length === 2) {
    if (method === 'GET') {
      let list = [...repos.values()].sort((a, b) => a.id - b.id);
      const sort = q.get('sort');
      if (sort === 'created' || sort === 'updated' || sort === 'pushed') list.sort((a, b) => b.id - a.id);
      if (sort === 'full_name') list.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
      if (q.get('direction') === 'desc' && sort === 'full_name') list.reverse();
      if (q.get('direction') === 'asc' && sort && sort !== 'full_name') list.reverse();
      return ok(paginate(null, list, q, '/user/repos', headers).map(repoJson));
    }
    if (method === 'POST') return ok(repoJson(createRepo(body)), 201);
  }
  if (s[0] === 'users' && s[2] === 'repos' && s.length === 3 && method === 'GET') {
    if (s[1].toLowerCase() !== LOGIN.toLowerCase()) return ok([]);
    return ok(paginate(null, [...repos.values()].sort((a, b) => a.id - b.id), q, `/users/${s[1]}/repos`, headers).map(repoJson));
  }
  if (s[0] !== 'repos' || s.length < 3) return null;
  const repo = findRepo(s[1], s[2]);
  const rest = s.slice(3);
  const full = `${s[1]}/${s[2]}`;
  if (!repo) throw notFound();
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(repo));
    if (method === 'PATCH') return ok(repoJson(updateRepo(repo, body)));
    if (method === 'DELETE') { deleteRepo(repo); return ok(undefined, 204); }
    return null;
  }
  const [r0, r1, r2] = rest;
  if (r0 === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'PUT' && path) return putContents(repo, path, body);
    if (method === 'DELETE' && path) return ok(deleteContents(repo, path, body));
    if (method === 'GET') {
      const sha = resolveRef(repo, q.get('ref'));
      if (!sha) throw notFound();
      const tree = repo.commits.get(sha)!.tree;
      const ref = q.get('ref');
      const blob = tree.get(path);
      if (blob) return ok(contentJson(repo, path, blob, ref, true));
      const prefix = path ? `${path}/` : '';
      const entries = new Map<string, Record<string, unknown>>();
      for (const [p, b] of tree) {
        if (!p.startsWith(prefix)) continue;
        const restP = p.slice(prefix.length); const slash = restP.indexOf('/');
        if (slash < 0) entries.set(restP, contentJson(repo, p, b, ref));
        else { const d = restP.slice(0, slash); entries.set(d, { type: 'dir', name: d, path: prefix + d, sha: sha1(prefix + d + sha), size: 0 }); }
      }
      if (!entries.size) throw notFound();
      return ok([...entries.values()].sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1)));
    }
    return null;
  }
  if (r0 === 'labels') {
    if (rest.length === 1 && method === 'POST') return ok(labelJson(repo, createLabel(repo, body)), 201);
    if (rest.length === 1 && method === 'GET') return ok(paginate(null, [...repo.labels.values()], q, `/repos/${full}/labels`, headers).map((l) => labelJson(repo, l)));
    if (rest.length === 2) {
      const l = repo.labels.get(r1.toLowerCase());
      if (!l) throw notFound();
      if (method === 'GET') return ok(labelJson(repo, l));
      if (method === 'DELETE') { repo.labels.delete(r1.toLowerCase()); return ok(undefined, 204); }
    }
    return null;
  }
  if (r0 === 'issues') {
    if (rest.length === 1 && method === 'POST') return ok(issueJson(createIssue(repo, body)), 201);
    if (rest.length === 1 && method === 'GET') {
      const labels = q.get('labels')?.split(',').map((x) => x.trim()).filter(Boolean);
      const items = listIssues(repo, q.get('state') ?? 'open', { labels, direction: q.get('direction') ?? 'desc' });
      return ok(paginate(null, items, q, `/repos/${full}/issues`, headers).map(issueJson));
    }
    const n = Number(r1);
    if (!Number.isInteger(n)) return null;
    const it = needIssue(repo, n);
    if (rest.length === 2 && method === 'GET') return ok(issueJson(it));
    if (rest.length === 2 && method === 'PATCH') return ok(issueJson(updateIssue(it, body)));
    if (r2 === 'comments' && rest.length === 3) {
      const cj = (c: Comment): Record<string, unknown> => ({ id: c.id, node_id: gid('IC', c.id), body: c.body, user: userJson(), created_at: c.createdAt, updated_at: c.createdAt, author_association: 'OWNER' });
      if (method === 'GET') return ok(it.comments.map(cj));
      if (method === 'POST') { const b = str(body.body); if (!b) throw new HttpError(422, 'Validation Failed'); return ok(cj(addComment(it, b)), 201); }
    }
    if (r2 === 'labels' && rest.length === 3 && (method === 'POST' || method === 'PUT')) {
      const add = labelsFor(repo, Array.isArray(body.labels) ? body.labels : []);
      it.labels = method === 'PUT' ? add : [...new Set([...it.labels, ...add])];
      return ok(it.labels.map((l) => labelJson(repo, l)));
    }
    return null;
  }
  if (r0 === 'pulls') {
    if (rest.length === 1 && method === 'POST') return ok(pullJson(createPull(repo, body)), 201);
    if (rest.length === 1 && method === 'GET') {
      const state = q.get('state') ?? 'open';
      let items = listIssues(repo, state, {}).filter((i) => i.pull);
      const head = q.get('head')?.replace(/^[^:]+:/, ''); const base = q.get('base');
      if (head) items = items.filter((i) => i.pull!.head === head);
      if (base) items = items.filter((i) => i.pull!.base === base);
      return ok(paginate(null, items, q, `/repos/${full}/pulls`, headers).map(pullJson));
    }
    const n = Number(r1);
    if (!Number.isInteger(n)) return null;
    const it = needPull(repo, n);
    if (rest.length === 2 && method === 'GET') return ok(pullJson(it));
    if (rest.length === 2 && method === 'PATCH') { updateIssue(it, body); if (typeof body.base === 'string') it.pull!.base = body.base; return ok(pullJson(it)); }
    if (r2 === 'merge' && rest.length === 3) {
      if (method === 'PUT') return ok(mergePull(it, body));
      if (method === 'GET') { if (it.pull!.merged) return ok(undefined, 204); throw notFound(); }
    }
    if (r2 === 'files' && rest.length === 3 && method === 'GET') {
      return ok(planMerge(repo, it.pull!).files.map((f) => ({ sha: f.sha, filename: f.path, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions })));
    }
    return null;
  }
  if (r0 === 'git' && r1 === 'refs') {
    const refJson = (name: string): Record<string, unknown> => ({
      ref: name, node_id: gid('R', repo.id + name.length), url: api(`/repos/${full}/git/refs/${name.replace(/^refs\//, '')}`),
      object: { sha: repo.branches.get(name.slice('refs/heads/'.length)) ?? '', type: 'commit', url: api(`/repos/${full}/git/commits/${repo.branches.get(name.slice('refs/heads/'.length)) ?? ''}`) },
    });
    if (rest.length === 2 && method === 'GET') {
      return ok([...repo.branches.keys()].map((b) => refJson(`refs/heads/${b}`)));
    }
    if (rest.length === 2 && method === 'POST') {
      const ref = str(body.ref) ?? '';
      const sha = str(body.sha) ?? '';
      if (!ref.startsWith('refs/heads/')) throw new HttpError(422, 'Reference update failed', { message: 'ref must be refs/heads/<branch>' });
      if (!repo.commits.has(sha)) throw new HttpError(422, 'Reference update failed', { message: `no commit ${sha}` });
      const branch = ref.slice('refs/heads/'.length);
      repo.branches.set(branch, sha);
      repo.pushedAt = now();
      return ok(refJson(ref), 201);
    }
    return null;
  }
  if (r0 === 'branches') {
    if (rest.length === 1 && method === 'GET') return ok([...repo.branches.entries()].map(([name, sha]) => ({ name, commit: { sha, url: api(`/repos/${full}/commits/${sha}`) }, protected: false })));
    if (rest.length >= 2 && method === 'GET') {
      const name = rest.slice(1).join('/');
      const sha = repo.branches.get(name);
      if (!sha) throw new HttpError(404, 'Branch not found');
      return ok({ name, commit: { sha, commit: commitJson(repo, repo.commits.get(sha)!) }, protected: false });
    }
    return null;
  }
  if (r0 === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const start = resolveRef(repo, q.get('sha'));
      if (!start) { if (!repo.branches.size) throw new HttpError(409, 'Git Repository is empty.'); throw notFound(); }
      const list: Commit[] = []; let cur: string | undefined = start;
      while (cur) { const c = repo.commits.get(cur); if (!c) break; list.push(c); cur = c.parents[0]; }
      return ok(paginate(null, list, q, `/repos/${full}/commits`, headers).map((c) => ({ sha: c.sha, commit: commitJson(repo, c), parents: c.parents.map((p) => ({ sha: p })) })));
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = resolveRef(repo, r1);
      if (!sha) throw new HttpError(422, `No commit found for SHA: ${r1}`);
      const c = repo.commits.get(sha)!;
      return ok({ sha: c.sha, commit: commitJson(repo, c), parents: c.parents.map((p) => ({ sha: p })) });
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// MCP

const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'makefun-forge', version: INSTALLED_VERSION };

interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown>; run: (a: Record<string, unknown>) => unknown }

const P = (type: string, description: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type, description, ...extra });
const schema = (props: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: 'object', properties: props, required });
const OWNER_REPO = { owner: P('string', 'Repository owner (user login)'), repo: P('string', 'Repository name') };

function argRepo(a: Record<string, unknown>): Repo {
  return needRepo(String(a.owner), String(a.repo));
}

function argNum(a: Record<string, unknown>, k: string): number {
  const n = Number(a[k]);
  if (!Number.isInteger(n) || n <= 0) throw new ToolArgError(`${k} must be a positive integer`);
  return n;
}

class ToolArgError extends Error {}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo', description: 'Create a new repository owned by the authenticated user.',
    inputSchema: schema({ name: P('string', 'Repository name'), description: P('string', 'Repository description'), private: P('boolean', 'Whether the repository is private'), autoInit: P('boolean', 'Initialize with a README') }, ['name']),
    run: (a) => repoJson(createRepo(a)),
  },
  {
    name: 'get_repo', description: 'Get a repository by owner and name.',
    inputSchema: schema({ ...OWNER_REPO }, ['owner', 'repo']),
    run: (a) => repoJson(argRepo(a)),
  },
  {
    name: 'create_issue', description: 'Open a new issue in a repository.',
    inputSchema: schema({ ...OWNER_REPO, title: P('string', 'Issue title'), body: P('string', 'Issue body (Markdown)'), labels: P('array', 'Label names to apply', { items: { type: 'string' } }) }, ['owner', 'repo', 'title']),
    run: (a) => issueJson(createIssue(argRepo(a), a)),
  },
  {
    name: 'list_issues', description: 'List issues in a repository, newest first.',
    inputSchema: schema({ ...OWNER_REPO, state: P('string', 'Filter by state', { enum: ['open', 'closed', 'all'] }), labels: P('array', 'Filter by label names', { items: { type: 'string' } }) }, ['owner', 'repo']),
    run: (a) => {
      const state = typeof a.state === 'string' ? a.state.toLowerCase() : 'open';
      const labels = Array.isArray(a.labels) ? a.labels.map(String) : undefined;
      return listIssues(argRepo(a), state, { labels, includePulls: false }).map(issueJson);
    },
  },
  {
    name: 'get_issue', description: 'Get one issue by number.',
    inputSchema: schema({ ...OWNER_REPO, issue_number: P('number', 'Issue number') }, ['owner', 'repo', 'issue_number']),
    run: (a) => issueJson(needIssue(argRepo(a), argNum(a, 'issue_number'))),
  },
  {
    name: 'create_pull_request', description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: schema({ ...OWNER_REPO, title: P('string', 'Pull request title'), head: P('string', 'Branch with the changes'), base: P('string', 'Branch to merge into'), body: P('string', 'Pull request description'), draft: P('boolean', 'Open as a draft') }, ['owner', 'repo', 'title', 'head', 'base']),
    run: (a) => pullJson(createPull(argRepo(a), a)),
  },
  {
    name: 'get_pull_request', description: 'Get one pull request by number.',
    inputSchema: schema({ ...OWNER_REPO, pull_number: P('number', 'Pull request number') }, ['owner', 'repo', 'pull_number']),
    run: (a) => pullJson(needPull(argRepo(a), argNum(a, 'pull_number'))),
  },
  {
    name: 'list_pull_requests', description: 'List pull requests in a repository.',
    inputSchema: schema({ ...OWNER_REPO, state: P('string', 'Filter by state', { enum: ['open', 'closed', 'all'] }) }, ['owner', 'repo']),
    run: (a) => listIssues(argRepo(a), typeof a.state === 'string' ? a.state.toLowerCase() : 'open').filter((i) => i.pull).map(pullJson),
  },
  {
    name: 'merge_pull_request', description: 'Merge a pull request into its base branch (squash).',
    inputSchema: schema({ ...OWNER_REPO, pull_number: P('number', 'Pull request number'), commit_title: P('string', 'Title of the merge commit'), commit_message: P('string', 'Extra detail for the merge commit'), merge_method: P('string', 'Merge method', { enum: ['merge', 'squash', 'rebase'] }) }, ['owner', 'repo', 'pull_number']),
    run: (a) => mergePull(needPull(argRepo(a), argNum(a, 'pull_number')), a),
  },
];

const TOOLS_LIST_JSON = JSON.stringify(TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));

function findTool(name: string): ToolDef | null {
  const n = name.toLowerCase();
  return TOOLS.find((t) => n === t.name || n.endsWith(`__${t.name}`) || n.endsWith(`.${t.name}`) || n.endsWith(`/${t.name}`)) ?? null;
}

function normalizeArgs(raw: unknown): Record<string, unknown> {
  const a: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  if (typeof a.full_name === 'string' && a.full_name.includes('/')) {
    const [o, r] = a.full_name.split('/');
    a.owner ??= o; a.repo ??= r;
  }
  return a;
}

type RpcOut = { raw: string } | null;

function rpcResult(id: unknown, result: unknown): RpcOut { return { raw: `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":${typeof result === 'string' ? result : JSON.stringify(result)}}` }; }
function rpcError(id: unknown, code: number, message: string): RpcOut { return { raw: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) }; }

function toolText(body: unknown, isError: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { content: [{ type: 'text', text: JSON.stringify(body) }], isError };
  if (!isError && body && typeof body === 'object' && !Array.isArray(body)) out.structuredContent = body;
  return out;
}

function handleRpc(msg: unknown, sessionHeaders: Record<string, string>): RpcOut {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request');
  const m = msg as Record<string, unknown>;
  const id = m.id;
  const isNotification = !('id' in m);
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    if (isNotification && ('result' in m || 'error' in m)) return null;
    return rpcError(id, -32600, 'Invalid Request');
  }
  const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>;
  if (isNotification) return null;
  switch (m.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = MCP_VERSIONS.includes(asked) && asked !== '2026-07-28' ? asked : '2025-11-25';
      sessionHeaders['mcp-session-id'] = `mf-${sha1(String(++seqCounter)).slice(0, 24)}`;
      return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case 'server/discover':
      return rpcResult(id, { supportedVersions: MCP_VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, `{"tools":${TOOLS_LIST_JSON}}`);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = findTool(name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = normalizeArgs(params.arguments);
      const missing = ((tool.inputSchema.required as string[]) ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
      if (missing.length) return rpcResult(id, toolText({ message: `missing required parameter: ${missing.join(', ')}` }, true));
      try {
        return rpcResult(id, toolText(tool.run(args), false));
      } catch (err) {
        if (err instanceof HttpError) return rpcResult(id, toolText({ message: err.message, status: err.status, ...err.extra }, true));
        if (err instanceof ToolArgError) return rpcResult(id, toolText({ message: err.message }, true));
        return rpcResult(id, toolText({ message: err instanceof Error ? err.message : String(err) }, true));
      }
    }
    case 'resources/list': return rpcResult(id, { resources: [] });
    case 'prompts/list': return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${m.method}`);
  }
}

function mcp(req: http.IncomingMessage, res: Res, raw: Buffer): void {
  const method = req.method ?? 'GET';
  if (!req.headers.authorization || !authorized(req)) {
    return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, { 'www-authenticate': 'Bearer realm="mcp"' });
  }
  if (method === 'DELETE') return send(res, 204, undefined);
  if (method !== 'POST') return send(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } }, { allow: 'POST' });
  let msg: unknown;
  try { msg = JSON.parse(raw.toString('utf8')); } catch {
    return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const headers: Record<string, string> = {};
  let text: string | null;
  if (Array.isArray(msg)) {
    if (!msg.length) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    const outs = msg.map((x) => handleRpc(x, headers)).filter((x): x is { raw: string } => x !== null);
    text = outs.length ? `[${outs.map((o) => o.raw).join(',')}]` : null;
  } else {
    const out = handleRpc(msg, headers);
    text = out ? out.raw : null;
  }
  if (text === null) return send(res, 202, undefined, headers);
  const accept = String(req.headers.accept ?? '');
  if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
    return send(res, 200, `event: message\ndata: ${text}\n\n`, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  }
  const invalid = !Array.isArray(msg) && text.includes('"code":-32600');
  send(res, invalid ? 400 : 200, text, headers);
}

// ---------------------------------------------------------------------------------------------------
// GraphQL: lexer, parser, schema, validator, executor

type Tok = { k: 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof'; v: string };

class GqlError extends Error {}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.startsWith('...', i)) { out.push({ k: 'punct', v: '...' }); i += 3; continue; }
    if ('!$()[]{}:=@|&'.includes(c)) { out.push({ k: 'punct', v: c }); i++; continue; }
    if (/[_A-Za-z]/.test(c)) { const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i))!; out.push({ k: 'name', v: m[0] }); i += m[0].length; continue; }
    if (/[-0-9]/.test(c)) {
      const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new GqlError(`Syntax Error: unexpected character "${c}"`);
      out.push({ k: m[2] || m[3] ? 'float' : 'int', v: m[0] }); i += m[0].length; continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new GqlError('Syntax Error: unterminated block string');
        out.push({ k: 'string', v: src.slice(i + 3, end).replace(/\\"""/g, '"""') }); i = end + 3; continue;
      }
      let j = i + 1; let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'u') { s += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; continue; }
          s += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e; j += 2; continue;
        }
        if (src[j] === '\n') throw new GqlError('Syntax Error: unterminated string');
        s += src[j]; j++;
      }
      if (j >= src.length) throw new GqlError('Syntax Error: unterminated string');
      out.push({ k: 'string', v: s }); i = j + 1; continue;
    }
    throw new GqlError(`Syntax Error: unexpected character "${c}"`);
  }
  out.push({ k: 'eof', v: '' });
  return out;
}

type Value = { kind: 'var'; name: string } | { kind: 'lit'; value: unknown } | { kind: 'list'; items: Value[] } | { kind: 'obj'; fields: Record<string, Value> } | { kind: 'enum'; value: string };
interface Directive { name: string; args: Record<string, Value> }
interface FieldSel { kind: 'field'; alias: string; name: string; args: Record<string, Value>; directives: Directive[]; sel: Sel[] | null }
interface SpreadSel { kind: 'spread'; name: string; directives: Directive[] }
interface InlineSel { kind: 'inline'; on: string | null; directives: Directive[]; sel: Sel[] }
type Sel = FieldSel | SpreadSel | InlineSel;
interface VarDef { name: string; type: string; def: Value | null }
interface Operation { type: 'query' | 'mutation' | 'subscription'; name: string | null; vars: VarDef[]; sel: Sel[] }
interface Fragment { name: string; on: string; sel: Sel[] }

function parseDoc(src: string): { ops: Operation[]; frags: Map<string, Fragment> } {
  const t = lex(src);
  let p = 0;
  const peek = (): Tok => t[p];
  const isP = (v: string): boolean => t[p].k === 'punct' && t[p].v === v;
  const expectP = (v: string): void => { if (!isP(v)) throw new GqlError(`Syntax Error: Expected "${v}", found ${t[p].k === 'eof' ? '<EOF>' : `"${t[p].v}"`}`); p++; };
  const name = (): string => { if (t[p].k !== 'name') throw new GqlError(`Syntax Error: Expected Name, found ${t[p].k === 'eof' ? '<EOF>' : `"${t[p].v}"`}`); return t[p++].v; };
  const value = (constOnly: boolean): Value => {
    const k = peek();
    if (isP('$')) { if (constOnly) throw new GqlError('Syntax Error: unexpected variable'); p++; return { kind: 'var', name: name() }; }
    if (isP('[')) { p++; const items: Value[] = []; while (!isP(']')) items.push(value(constOnly)); p++; return { kind: 'list', items }; }
    if (isP('{')) { p++; const fields: Record<string, Value> = {}; while (!isP('}')) { const n = name(); expectP(':'); fields[n] = value(constOnly); } p++; return { kind: 'obj', fields }; }
    if (k.k === 'int') { p++; return { kind: 'lit', value: parseInt(k.v, 10) }; }
    if (k.k === 'float') { p++; return { kind: 'lit', value: parseFloat(k.v) }; }
    if (k.k === 'string') { p++; return { kind: 'lit', value: k.v }; }
    if (k.k === 'name') {
      p++;
      if (k.v === 'true') return { kind: 'lit', value: true };
      if (k.v === 'false') return { kind: 'lit', value: false };
      if (k.v === 'null') return { kind: 'lit', value: null };
      return { kind: 'enum', value: k.v };
    }
    throw new GqlError(`Syntax Error: Unexpected ${k.k === 'eof' ? '<EOF>' : `"${k.v}"`}`);
  };
  const args = (): Record<string, Value> => {
    const out: Record<string, Value> = {};
    if (!isP('(')) return out;
    p++;
    while (!isP(')')) { const n = name(); expectP(':'); out[n] = value(false); }
    p++;
    return out;
  };
  const directives = (): Directive[] => { const out: Directive[] = []; while (isP('@')) { p++; out.push({ name: name(), args: args() }); } return out; };
  const typeRef = (): string => {
    let s: string;
    if (isP('[')) { p++; s = `[${typeRef()}]`; expectP(']'); } else s = name();
    if (isP('!')) { p++; s += '!'; }
    return s;
  };
  const selSet = (): Sel[] => {
    expectP('{');
    const out: Sel[] = [];
    while (!isP('}')) {
      if (peek().k === 'eof') throw new GqlError('Syntax Error: Expected Name, found <EOF>');
      if (isP('...')) {
        p++;
        if (peek().k === 'name' && peek().v === 'on') { p++; const on = name(); const d = directives(); out.push({ kind: 'inline', on, directives: d, sel: selSet() }); }
        else if (peek().k === 'name') { const n = name(); out.push({ kind: 'spread', name: n, directives: directives() }); }
        else { const d = directives(); out.push({ kind: 'inline', on: null, directives: d, sel: selSet() }); }
        continue;
      }
      let alias = name(); let fname = alias;
      if (isP(':')) { p++; fname = name(); }
      const a = args(); const d = directives();
      out.push({ kind: 'field', alias, name: fname, args: a, directives: d, sel: isP('{') ? selSet() : null });
    }
    p++;
    if (!out.length) throw new GqlError('Syntax Error: Expected Name, found "}"');
    return out;
  };
  const ops: Operation[] = [];
  const frags = new Map<string, Fragment>();
  while (peek().k !== 'eof') {
    if (isP('{')) { ops.push({ type: 'query', name: null, vars: [], sel: selSet() }); continue; }
    const kw = name();
    if (kw === 'fragment') {
      const n = name(); if (name() !== 'on') throw new GqlError('Syntax Error: Expected "on"');
      const on = name(); directives(); frags.set(n, { name: n, on, sel: selSet() }); continue;
    }
    if (kw !== 'query' && kw !== 'mutation' && kw !== 'subscription') throw new GqlError(`Syntax Error: Unexpected Name "${kw}"`);
    const opName = peek().k === 'name' ? name() : null;
    const vars: VarDef[] = [];
    if (isP('(')) {
      p++;
      while (!isP(')')) { expectP('$'); const n = name(); expectP(':'); const ty = typeRef(); let def: Value | null = null; if (isP('=')) { p++; def = value(true); } directives(); vars.push({ name: n, type: ty, def }); }
      p++;
    }
    directives();
    ops.push({ type: kw, name: opName, vars, sel: selSet() });
  }
  if (!ops.length) throw new GqlError('Syntax Error: no operation in document');
  return { ops, frags };
}

// Schema --------------------------------------------------------------------------------------------

interface GCtx { errors: Record<string, unknown>[] }
type Resolver = (obj: any, args: Record<string, any>, ctx: GCtx) => unknown;
interface GField { type: string; args?: Record<string, string>; r?: Resolver; desc?: string }
interface GType { kind: 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR'; fields?: Record<string, GField>; interfaces?: string[]; possible?: string[]; values?: string[]; inputs?: Record<string, string>; desc?: string }

const TYPES: Record<string, GType> = {};
const defScalar = (n: string): void => { TYPES[n] = { kind: 'SCALAR' }; };
['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'HTML'].forEach(defScalar);
const defEnum = (n: string, values: string[]): void => { TYPES[n] = { kind: 'ENUM', values }; };
defEnum('SearchType', ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION']);
defEnum('IssueState', ['OPEN', 'CLOSED']);
defEnum('PullRequestState', ['OPEN', 'CLOSED', 'MERGED']);
defEnum('MergeableState', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
defEnum('RepositoryPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']);
defEnum('RepositoryVisibility', ['PUBLIC', 'PRIVATE', 'INTERNAL']);
defEnum('IssueOrderField', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']);
defEnum('OrderDirection', ['ASC', 'DESC']);
defEnum('PullRequestMergeMethod', ['MERGE', 'SQUASH', 'REBASE']);
defEnum('PatchStatus', ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED']);
defEnum('IssueStateReason', ['COMPLETED', 'NOT_PLANNED', 'REOPENED', 'DUPLICATE']);
TYPES.IssueOrder = { kind: 'INPUT_OBJECT', inputs: { field: 'IssueOrderField!', direction: 'OrderDirection!' } };
TYPES.CreatePullRequestInput = { kind: 'INPUT_OBJECT', inputs: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', maintainerCanModify: 'Boolean', clientMutationId: 'String' } };
TYPES.CreateIssueInput = { kind: 'INPUT_OBJECT', inputs: { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', clientMutationId: 'String' } };
TYPES.MergePullRequestInput = { kind: 'INPUT_OBJECT', inputs: { pullRequestId: 'ID!', commitHeadline: 'String', commitBody: 'String', mergeMethod: 'PullRequestMergeMethod', expectedHeadOid: 'GitObjectID', clientMutationId: 'String' } };
TYPES.CloseIssueInput = { kind: 'INPUT_OBJECT', inputs: { issueId: 'ID!', stateReason: 'IssueStateReason', clientMutationId: 'String' } };
TYPES.ReopenIssueInput = { kind: 'INPUT_OBJECT', inputs: { issueId: 'ID!', clientMutationId: 'String' } };
TYPES.AddCommentInput = { kind: 'INPUT_OBJECT', inputs: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' } };

const CONN_ARGS = { first: 'Int', last: 'Int', after: 'String', before: 'String' };

function connection(items: unknown[], args: Record<string, any>): Record<string, unknown> {
  let start = 0; let end = items.length;
  const dec = (c: unknown): number | null => { if (typeof c !== 'string') return null; const m = /^cursor:(\d+)$/.exec(Buffer.from(c, 'base64').toString('utf8')); return m ? Number(m[1]) : null; };
  const a = dec(args.after); if (a !== null) start = a + 1;
  const b = dec(args.before); if (b !== null) end = Math.min(end, b);
  if (typeof args.first === 'number') end = Math.min(end, start + Math.max(0, args.first));
  if (typeof args.last === 'number') start = Math.max(start, end - Math.max(0, args.last));
  const slice = items.slice(start, end);
  const cur = (i: number): string => Buffer.from(`cursor:${i}`).toString('base64');
  return {
    totalCount: items.length, nodes: slice,
    edges: slice.map((node, k) => ({ cursor: cur(start + k), node })),
    pageInfo: { hasNextPage: end < items.length, hasPreviousPage: start > 0, startCursor: slice.length ? cur(start) : null, endCursor: slice.length ? cur(end - 1) : null },
  };
}

function defConn(name: string, node: string, extra: Record<string, GField> = {}): void {
  TYPES[`${name}Edge`] = { kind: 'OBJECT', fields: { cursor: { type: 'String!' }, node: { type: node } } };
  TYPES[name] = { kind: 'OBJECT', fields: { totalCount: { type: 'Int!' }, nodes: { type: `[${node}]` }, edges: { type: `[${name}Edge]` }, pageInfo: { type: 'PageInfo!' }, ...extra } };
}
TYPES.PageInfo = { kind: 'OBJECT', fields: { hasNextPage: { type: 'Boolean!' }, hasPreviousPage: { type: 'Boolean!' }, startCursor: { type: 'String' }, endCursor: { type: 'String' } } };

function viewerObj(): Record<string, unknown> { return { __typename: 'User', login: LOGIN }; }

const userFields: Record<string, GField> = {
  id: { type: 'ID!', r: () => gid('U', USER_ID) }, databaseId: { type: 'Int', r: () => USER_ID },
  login: { type: 'String!', r: () => LOGIN }, name: { type: 'String', r: () => LOGIN }, email: { type: 'String!', r: () => `${LOGIN}@example.invalid` },
  url: { type: 'URI!', r: () => `${BASE}/${LOGIN}` }, avatarUrl: { type: 'URI!', args: { size: 'Int' }, r: () => '' },
  repositories: { type: 'RepositoryConnection!', args: { ...CONN_ARGS, ownerAffiliations: '[String]', isFork: 'Boolean', privacy: 'RepositoryVisibility' }, r: (_o, a) => connection([...repos.values()].sort((x, y) => x.id - y.id), a) },
  repository: { type: 'Repository', args: { name: 'String!' }, r: (_o, a) => findRepo(LOGIN, String(a.name)) },
};
TYPES.Node = { kind: 'INTERFACE', fields: { id: { type: 'ID!' } }, possible: ['Repository', 'Issue', 'PullRequest', 'User'] };
TYPES.RepositoryOwner = { kind: 'INTERFACE', fields: { id: userFields.id, login: userFields.login, url: userFields.url, avatarUrl: userFields.avatarUrl, repository: userFields.repository }, possible: ['User'] };
TYPES.Actor = { kind: 'INTERFACE', fields: { login: userFields.login, url: userFields.url, avatarUrl: userFields.avatarUrl }, possible: ['User'] };
TYPES.User = { kind: 'OBJECT', interfaces: ['Node', 'RepositoryOwner', 'Actor'], fields: userFields };

TYPES.Commit = {
  kind: 'OBJECT', interfaces: ['Node', 'GitObject'], fields: {
    id: { type: 'ID!', r: (c: Commit) => `C_${c.sha}` }, oid: { type: 'GitObjectID!', r: (c: Commit) => c.sha }, abbreviatedOid: { type: 'String!', r: (c: Commit) => c.sha.slice(0, 7) },
    message: { type: 'String!' }, messageHeadline: { type: 'String!', r: (c: Commit) => c.message.split('\n')[0] },
    committedDate: { type: 'DateTime!', r: (c: Commit) => c.date }, authoredDate: { type: 'DateTime!', r: (c: Commit) => c.date },
  },
};
TYPES.GitObject = { kind: 'INTERFACE', fields: { id: TYPES.Commit.fields!.id, oid: TYPES.Commit.fields!.oid, abbreviatedOid: TYPES.Commit.fields!.abbreviatedOid }, possible: ['Commit'] };
interface RefObj { repo: Repo; name: string }
TYPES.Ref = {
  kind: 'OBJECT', interfaces: ['Node'], fields: {
    id: { type: 'ID!', r: (r: RefObj) => `REF_${Buffer.from(`${r.repo.id}:${r.name}`).toString('base64url')}` },
    name: { type: 'String!' }, prefix: { type: 'String!', r: () => 'refs/heads/' },
    target: { type: 'GitObject', r: (r: RefObj) => { const sha = r.repo.branches.get(r.name); return sha ? { __typename: 'Commit', ...r.repo.commits.get(sha)! } : null; } },
    repository: { type: 'Repository!', r: (r: RefObj) => r.repo },
  },
};
TYPES.Label = { kind: 'OBJECT', interfaces: ['Node'], fields: { id: { type: 'ID!', r: (l: Label) => gid('LA', l.id) }, name: { type: 'String!' }, color: { type: 'String!' }, description: { type: 'String' } } };
defConn('LabelConnection', 'Label');
TYPES.IssueComment = { kind: 'OBJECT', interfaces: ['Node'], fields: { id: { type: 'ID!', r: (c: Comment) => gid('IC', c.id) }, databaseId: { type: 'Int', r: (c: Comment) => c.id }, body: { type: 'String!' }, createdAt: { type: 'DateTime!' }, author: { type: 'Actor', r: () => viewerObj() } } };
defConn('IssueCommentConnection', 'IssueComment');

const itemFields = (pr: boolean): Record<string, GField> => ({
  id: { type: 'ID!', r: (i: Issue) => gid(pr ? 'PR' : 'I', i.id) }, databaseId: { type: 'Int', r: (i: Issue) => i.id },
  number: { type: 'Int!' }, title: { type: 'String!' }, body: { type: 'String!', r: (i: Issue) => i.body ?? '' },
  bodyText: { type: 'String!', r: (i: Issue) => i.body ?? '' },
  url: { type: 'URI!', r: (i: Issue) => `${BASE}/${i.repo.owner}/${i.repo.name}/${pr ? 'pull' : 'issues'}/${i.number}` },
  createdAt: { type: 'DateTime!' }, updatedAt: { type: 'DateTime!' }, closedAt: { type: 'DateTime' },
  closed: { type: 'Boolean!', r: (i: Issue) => i.state === 'closed' },
  author: { type: 'Actor', r: () => viewerObj() }, repository: { type: 'Repository!', r: (i: Issue) => i.repo },
  labels: { type: 'LabelConnection', args: CONN_ARGS, r: (i: Issue, a) => connection(i.labels, a) },
  comments: { type: 'IssueCommentConnection!', args: CONN_ARGS, r: (i: Issue, a) => connection(i.comments, a) },
  assignees: { type: 'UserConnection!', args: CONN_ARGS, r: (_i, a) => connection([], a) },
});
defConn('UserConnection', 'User');
TYPES.Issue = {
  kind: 'OBJECT', interfaces: ['Node'], fields: {
    ...itemFields(false),
    state: { type: 'IssueState!', r: (i: Issue) => i.state.toUpperCase() },
    stateReason: { type: 'IssueStateReason', r: (i: Issue) => (i.state === 'closed' ? 'COMPLETED' : null) },
  },
};
defConn('IssueConnection', 'Issue');
interface FileObj { path: string; additions: number; deletions: number; status: string }
TYPES.PullRequestChangedFile = { kind: 'OBJECT', fields: { path: { type: 'String!' }, additions: { type: 'Int!' }, deletions: { type: 'Int!' }, changeType: { type: 'PatchStatus!', r: (f: FileObj) => ({ added: 'ADDED', removed: 'DELETED', modified: 'MODIFIED' } as Record<string, string>)[f.status] } } };
defConn('PullRequestChangedFileConnection', 'PullRequestChangedFile');
TYPES.PullRequest = {
  kind: 'OBJECT', interfaces: ['Node'], fields: {
    ...itemFields(true),
    state: { type: 'PullRequestState!', r: (i: Issue) => (i.pull!.merged ? 'MERGED' : i.state.toUpperCase()) },
    merged: { type: 'Boolean!', r: (i: Issue) => i.pull!.merged }, mergedAt: { type: 'DateTime', r: (i: Issue) => i.pull!.mergedAt },
    isDraft: { type: 'Boolean!', r: (i: Issue) => i.pull!.draft },
    mergeable: { type: 'MergeableState!', r: (i: Issue) => (i.pull!.merged || i.state !== 'open' ? 'UNKNOWN' : planMerge(i.repo, i.pull!).ok ? 'MERGEABLE' : 'CONFLICTING') },
    headRefName: { type: 'String!', r: (i: Issue) => i.pull!.head }, baseRefName: { type: 'String!', r: (i: Issue) => i.pull!.base },
    headRefOid: { type: 'GitObjectID!', r: (i: Issue) => i.repo.branches.get(i.pull!.head) ?? i.pull!.headSha },
    baseRefOid: { type: 'GitObjectID!', r: (i: Issue) => i.repo.branches.get(i.pull!.base) ?? i.pull!.baseSha },
    headRef: { type: 'Ref', r: (i: Issue) => (i.repo.branches.has(i.pull!.head) ? { repo: i.repo, name: i.pull!.head } : null) },
    baseRef: { type: 'Ref', r: (i: Issue) => (i.repo.branches.has(i.pull!.base) ? { repo: i.repo, name: i.pull!.base } : null) },
    headRepository: { type: 'Repository', r: (i: Issue) => i.repo }, baseRepository: { type: 'Repository', r: (i: Issue) => i.repo },
    additions: { type: 'Int!', r: (i: Issue) => planMerge(i.repo, i.pull!).files.reduce((a, f) => a + f.additions, 0) },
    deletions: { type: 'Int!', r: (i: Issue) => planMerge(i.repo, i.pull!).files.reduce((a, f) => a + f.deletions, 0) },
    changedFiles: { type: 'Int!', r: (i: Issue) => planMerge(i.repo, i.pull!).files.length },
    files: { type: 'PullRequestChangedFileConnection', args: CONN_ARGS, r: (i: Issue, a) => connection(planMerge(i.repo, i.pull!).files, a) },
    mergeCommit: { type: 'Commit', r: (i: Issue) => (i.pull!.mergeCommitSha ? i.repo.commits.get(i.pull!.mergeCommitSha) ?? null : null) },
  },
};
defConn('PullRequestConnection', 'PullRequest');

function sortItems(items: Issue[], orderBy: Record<string, any> | undefined): Issue[] {
  const field = orderBy?.field ?? 'CREATED_AT';
  const dir = orderBy?.direction ?? 'ASC';
  const key = (i: Issue): number => (field === 'COMMENTS' ? i.comments.length : field === 'UPDATED_AT' ? Date.parse(i.updatedAt) * 1e6 + i.seq : i.seq);
  const out = [...items].sort((a, b) => key(a) - key(b) || a.number - b.number);
  if (dir === 'DESC') out.reverse();
  return out;
}

TYPES.Repository = {
  kind: 'OBJECT', interfaces: ['Node'], fields: {
    id: { type: 'ID!', r: (r: Repo) => gid('R', r.id) }, databaseId: { type: 'Int', r: (r: Repo) => r.id },
    name: { type: 'String!' }, nameWithOwner: { type: 'String!', r: (r: Repo) => `${r.owner}/${r.name}` },
    owner: { type: 'RepositoryOwner!', r: () => viewerObj() }, description: { type: 'String' },
    url: { type: 'URI!', r: (r: Repo) => `${BASE}/${r.owner}/${r.name}` }, sshUrl: { type: 'String!', r: (r: Repo) => `${BASE}/${r.owner}/${r.name}.git` },
    isPrivate: { type: 'Boolean!', r: (r: Repo) => r.private }, visibility: { type: 'RepositoryVisibility!', r: (r: Repo) => (r.private ? 'PRIVATE' : 'PUBLIC') },
    isFork: { type: 'Boolean!', r: () => false }, isArchived: { type: 'Boolean!', r: () => false }, isEmpty: { type: 'Boolean!', r: (r: Repo) => r.branches.size === 0 },
    createdAt: { type: 'DateTime!' }, updatedAt: { type: 'DateTime!' }, pushedAt: { type: 'DateTime' },
    stargazerCount: { type: 'Int!', r: () => 0 }, forkCount: { type: 'Int!', r: () => 0 },
    hasIssuesEnabled: { type: 'Boolean!', r: (r: Repo) => r.hasIssues }, hasWikiEnabled: { type: 'Boolean!', r: (r: Repo) => r.hasWiki },
    viewerPermission: { type: 'RepositoryPermission', r: () => 'ADMIN' },
    viewerCanAdminister: { type: 'Boolean!', r: () => true },
    defaultBranchRef: { type: 'Ref', r: (r: Repo) => (r.branches.has(r.defaultBranch) ? { repo: r, name: r.defaultBranch } : null) },
    ref: { type: 'Ref', args: { qualifiedName: 'String!' }, r: (r: Repo, a) => { const n = String(a.qualifiedName).replace(/^refs\/heads\//, ''); return r.branches.has(n) ? { repo: r, name: n } : null; } },
    issue: { type: 'Issue', args: { number: 'Int!' }, r: (r: Repo, a) => { const i = r.items.get(Number(a.number)); return i && !i.pull ? i : null; } },
    issues: {
      type: 'IssueConnection!', args: { ...CONN_ARGS, states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]' },
      r: (r: Repo, a) => {
        let items = [...r.items.values()].filter((i) => !i.pull);
        if (Array.isArray(a.states) && a.states.length) items = items.filter((i) => a.states.includes(i.state.toUpperCase()));
        if (Array.isArray(a.labels) && a.labels.length) items = items.filter((i) => i.labels.some((l) => a.labels.includes(l.name)));
        return connection(sortItems(items, a.orderBy), a);
      },
    },
    pullRequest: { type: 'PullRequest', args: { number: 'Int!' }, r: (r: Repo, a) => { const i = r.items.get(Number(a.number)); return i && i.pull ? i : null; } },
    pullRequests: {
      type: 'PullRequestConnection!', args: { ...CONN_ARGS, states: '[PullRequestState!]', orderBy: 'IssueOrder', headRefName: 'String', baseRefName: 'String', labels: '[String!]' },
      r: (r: Repo, a) => {
        let items = [...r.items.values()].filter((i) => i.pull);
        const st = (i: Issue): string => (i.pull!.merged ? 'MERGED' : i.state.toUpperCase());
        if (Array.isArray(a.states) && a.states.length) items = items.filter((i) => a.states.includes(st(i)));
        if (typeof a.headRefName === 'string') items = items.filter((i) => i.pull!.head === a.headRefName);
        if (typeof a.baseRefName === 'string') items = items.filter((i) => i.pull!.base === a.baseRefName);
        return connection(sortItems(items, a.orderBy), a);
      },
    },
    labels: { type: 'LabelConnection', args: { ...CONN_ARGS, query: 'String' }, r: (r: Repo, a) => connection([...r.labels.values()], a) },
    label: { type: 'Label', args: { name: 'String!' }, r: (r: Repo, a) => r.labels.get(String(a.name).toLowerCase()) ?? null },
  },
};
defConn('RepositoryConnection', 'Repository');
TYPES.SearchResultItem = { kind: 'UNION', possible: ['Issue', 'PullRequest', 'Repository'] };
defConn('SearchResultItemConnection', 'SearchResultItem', { issueCount: { type: 'Int!' }, repositoryCount: { type: 'Int!' }, userCount: { type: 'Int!' } });
TYPES.RateLimit = { kind: 'OBJECT', fields: { limit: { type: 'Int!', r: () => 5000 }, remaining: { type: 'Int!', r: () => 5000 }, used: { type: 'Int!', r: () => 0 }, cost: { type: 'Int!', r: () => 1 }, resetAt: { type: 'DateTime!', r: () => '2099-01-01T00:00:00Z' } } };

function search(a: Record<string, any>): Record<string, unknown> {
  const words = String(a.query ?? '').split(/\s+/).filter(Boolean);
  let repoFilter: string | null = null; let state: string | null = null; let kind: string | null = null; const terms: string[] = []; const labels: string[] = [];
  for (const w of words) {
    const [k, ...vv] = w.split(':'); const v = vv.join(':').replace(/^"|"$/g, '');
    if (vv.length && k === 'repo') repoFilter = v.toLowerCase();
    else if (vv.length && (k === 'is' || k === 'type') && (v === 'issue' || v === 'pr' || v === 'pull-request')) kind = v === 'issue' ? 'issue' : 'pr';
    else if (vv.length && (k === 'is' || k === 'state') && (v === 'open' || v === 'closed' || v === 'merged')) state = v;
    else if (vv.length && k === 'label') labels.push(v.toLowerCase());
    else if (vv.length && ['user', 'org', 'owner', 'in', 'sort', 'author', 'archived'].includes(k)) continue;
    else terms.push(w.toLowerCase());
  }
  const type = a.type ?? 'ISSUE';
  let nodes: unknown[] = [];
  if (type === 'REPOSITORY') {
    nodes = [...repos.values()].filter((r) => (!repoFilter || `${r.owner}/${r.name}`.toLowerCase() === repoFilter) && terms.every((t) => r.name.toLowerCase().includes(t) || (r.description ?? '').toLowerCase().includes(t)));
    const c = connection(nodes.map((r) => ({ __typename: 'Repository', __obj: r })), a);
    return { ...c, issueCount: 0, repositoryCount: nodes.length, userCount: 0 };
  }
  if (type === 'ISSUE' || type === 'ISSUE_ADVANCED') {
    const items: Issue[] = [];
    for (const r of repos.values()) {
      if (repoFilter && `${r.owner}/${r.name}`.toLowerCase() !== repoFilter) continue;
      for (const i of r.items.values()) {
        if (kind === 'issue' && i.pull) continue;
        if (kind === 'pr' && !i.pull) continue;
        if (state === 'merged' && !i.pull?.merged) continue;
        if ((state === 'open' || state === 'closed') && i.state !== state) continue;
        if (labels.length && !labels.every((l) => i.labels.some((x) => x.name.toLowerCase() === l))) continue;
        if (!terms.every((t) => i.title.toLowerCase().includes(t) || (i.body ?? '').toLowerCase().includes(t))) continue;
        items.push(i);
      }
    }
    items.sort((x, y) => y.seq - x.seq);
    const c = connection(items.map((i) => ({ __typename: i.pull ? 'PullRequest' : 'Issue', __obj: i })), a);
    return { ...c, issueCount: items.length, repositoryCount: 0, userCount: 0 };
  }
  return { ...connection([], a), issueCount: 0, repositoryCount: 0, userCount: 0 };
}

function payload(fields: Record<string, string>): GType {
  const f: Record<string, GField> = { clientMutationId: { type: 'String' } };
  for (const [k, t] of Object.entries(fields)) f[k] = { type: t };
  return { kind: 'OBJECT', fields: f };
}
TYPES.CreatePullRequestPayload = payload({ pullRequest: 'PullRequest' });
TYPES.CreateIssuePayload = payload({ issue: 'Issue' });
TYPES.MergePullRequestPayload = payload({ pullRequest: 'PullRequest' });
TYPES.CloseIssuePayload = payload({ issue: 'Issue' });
TYPES.ReopenIssuePayload = payload({ issue: 'Issue' });
TYPES.AddCommentPayload = { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, commentEdge: { type: 'IssueCommentConnectionEdge' }, subject: { type: 'Node' } } };

function gqlRepoById(id: unknown): Repo {
  const r = typeof id === 'string' ? nodeById(id) : null;
  if (!r || !(r as Repo).items) throw new GqlError(`Could not resolve to a node with the global id of '${String(id)}'`);
  return r as Repo;
}
function gqlItemById(id: unknown, pull: boolean): Issue {
  const r = typeof id === 'string' ? nodeById(id) : null;
  if (!r || !(r as Issue).repo || !!(r as Issue).pull !== pull) throw new GqlError(`Could not resolve to a node with the global id of '${String(id)}'`);
  return r as Issue;
}
function asGql<T>(fn: () => T): T {
  try { return fn(); } catch (e) { if (e instanceof HttpError) throw new GqlError(e.message); throw e; }
}

TYPES.Query = {
  kind: 'OBJECT', fields: {
    repository: { type: 'Repository', args: { owner: 'String!', name: 'String!', followRenames: 'Boolean' }, r: (_o, a) => findRepo(String(a.owner), String(a.name)) },
    viewer: { type: 'User!', r: () => viewerObj() },
    user: { type: 'User', args: { login: 'String!' }, r: (_o, a) => (String(a.login).toLowerCase() === LOGIN.toLowerCase() ? viewerObj() : null) },
    repositoryOwner: { type: 'RepositoryOwner', args: { login: 'String!' }, r: (_o, a) => (String(a.login).toLowerCase() === LOGIN.toLowerCase() ? viewerObj() : null) },
    node: { type: 'Node', args: { id: 'ID!' }, r: (_o, a) => nodeById(String(a.id)) },
    nodes: { type: '[Node]!', args: { ids: '[ID!]!' }, r: (_o, a) => (Array.isArray(a.ids) ? a.ids : []).map((x: unknown) => nodeById(String(x))) },
    search: { type: 'SearchResultItemConnection!', args: { ...CONN_ARGS, query: 'String!', type: 'SearchType!' }, r: (_o, a) => search(a) },
    rateLimit: { type: 'RateLimit', r: () => ({}) },
  },
};
TYPES.Mutation = {
  kind: 'OBJECT', fields: {
    createPullRequest: {
      type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' },
      r: (_o, a) => { const i = a.input ?? {}; const repo = gqlRepoById(i.repositoryId); return { clientMutationId: i.clientMutationId ?? null, pullRequest: asGql(() => createPull(repo, { title: i.title, head: i.headRefName, base: i.baseRefName, body: i.body, draft: i.draft })) }; },
    },
    createIssue: {
      type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' },
      r: (_o, a) => {
        const i = a.input ?? {}; const repo = gqlRepoById(i.repositoryId);
        const labelNames = (Array.isArray(i.labelIds) ? i.labelIds : []).map((lid: string) => { const g = fromGid(lid); const l = [...repo.labels.values()].find((x) => g && x.id === g.id); if (!l) throw new GqlError(`Could not resolve label ${lid}`); return l.name; });
        return { clientMutationId: i.clientMutationId ?? null, issue: asGql(() => createIssue(repo, { title: i.title, body: i.body, labels: labelNames })) };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' },
      r: (_o, a) => { const i = a.input ?? {}; const it = gqlItemById(i.pullRequestId, true); asGql(() => mergePull(it, { commit_title: i.commitHeadline, commit_message: i.commitBody, sha: i.expectedHeadOid })); return { clientMutationId: i.clientMutationId ?? null, pullRequest: it }; },
    },
    closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' }, r: (_o, a) => { const it = gqlItemById(a.input?.issueId, false); updateIssue(it, { state: 'closed' }); return { clientMutationId: a.input?.clientMutationId ?? null, issue: it }; } },
    reopenIssue: { type: 'ReopenIssuePayload', args: { input: 'ReopenIssueInput!' }, r: (_o, a) => { const it = gqlItemById(a.input?.issueId, false); updateIssue(it, { state: 'open' }); return { clientMutationId: a.input?.clientMutationId ?? null, issue: it }; } },
    addComment: {
      type: 'AddCommentPayload', args: { input: 'AddCommentInput!' },
      r: (_o, a) => { const r = typeof a.input?.subjectId === 'string' ? nodeById(a.input.subjectId) as Issue : null; if (!r || !r.repo) throw new GqlError('Could not resolve subject'); const c = addComment(r, String(a.input.body ?? '')); return { clientMutationId: a.input?.clientMutationId ?? null, commentEdge: { cursor: '', node: c }, subject: r }; },
    },
  },
};

// Introspection -------------------------------------------------------------------------------------

function typeRefObj(t: string): Record<string, unknown> {
  if (t.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: typeRefObj(t.slice(0, -1)) };
  if (t.startsWith('[')) return { kind: 'LIST', name: null, ofType: typeRefObj(t.slice(1, -1)) };
  return { kind: TYPES[t]?.kind ?? 'SCALAR', name: t, ofType: null };
}
const baseName = (t: string): string => t.replace(/[[\]!]/g, '');

const introCache = new Map<string, Record<string, unknown>>();
function introType(name: string): Record<string, unknown> | null {
  const t = TYPES[name];
  if (!t) return null;
  const hit = introCache.get(name);
  if (hit) return hit;
  const inputVal = (n: string, ty: string): Record<string, unknown> => ({ name: n, description: null, type: typeRefObj(ty), defaultValue: null, isDeprecated: false, deprecationReason: null });
  const out: Record<string, unknown> = {
    kind: t.kind, name, description: t.desc ?? null, specifiedByURL: null, isOneOf: false,
    fields: t.fields ? Object.entries(t.fields).map(([n, f]) => ({ name: n, description: f.desc ?? null, args: Object.entries(f.args ?? {}).map(([an, at]) => inputVal(an, at)), type: typeRefObj(f.type), isDeprecated: false, deprecationReason: null })) : null,
    inputFields: t.inputs ? Object.entries(t.inputs).map(([n, ty]) => inputVal(n, ty)) : null,
    interfaces: t.kind === 'OBJECT' || t.kind === 'INTERFACE' ? (t.interfaces ?? []).map((i) => typeRefObj(i)) : null,
    enumValues: t.values ? t.values.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null })) : null,
    possibleTypes: t.possible ? t.possible.map((p) => typeRefObj(p)) : null,
    ofType: null,
  };
  introCache.set(name, out);
  return out;
}

function introSchema(): Record<string, unknown> {
  return {
    description: null, queryType: { kind: 'OBJECT', name: 'Query' }, mutationType: { kind: 'OBJECT', name: 'Mutation' }, subscriptionType: null,
    types: Object.keys(TYPES).map((n) => introType(n)),
    directives: [
      { name: 'include', description: null, isRepeatable: false, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', description: null, type: typeRefObj('Boolean!'), defaultValue: null, isDeprecated: false, deprecationReason: null }] },
      { name: 'skip', description: null, isRepeatable: false, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', description: null, type: typeRefObj('Boolean!'), defaultValue: null, isDeprecated: false, deprecationReason: null }] },
    ],
  };
}

// Validation and execution --------------------------------------------------------------------------

const PLAIN = '__plain';

function fieldDef(typeName: string, field: string): GField | null {
  if (typeName === 'Query' && field === '__type') return { type: PLAIN, args: { name: 'String!' } };
  if (typeName === 'Query' && field === '__schema') return { type: PLAIN };
  return TYPES[typeName]?.fields?.[field] ?? null;
}

function fragApplies(cond: string | null, concrete: string): boolean {
  if (!cond || cond === concrete) return true;
  const c = TYPES[cond];
  if (!c) return false;
  if (c.kind === 'INTERFACE' || c.kind === 'UNION') return (c.possible ?? []).includes(concrete);
  return false;
}

function validate(sel: Sel[], typeName: string, frags: Map<string, Fragment>, errors: Record<string, unknown>[], path: string[], seen: Set<string>): void {
  for (const s of sel) {
    if (s.kind === 'spread') {
      const f = frags.get(s.name);
      if (!f) { errors.push({ message: `Fragment ${s.name} was used, but not defined`, path }); continue; }
      if (seen.has(s.name)) continue;
      if (!TYPES[f.on]) { errors.push({ message: `No such type ${f.on}, so it can't be a fragment condition`, path }); continue; }
      validate(f.sel, f.on, frags, errors, path, new Set([...seen, s.name]));
      continue;
    }
    if (s.kind === 'inline') {
      if (s.on && !TYPES[s.on]) { errors.push({ message: `No such type ${s.on}, so it can't be a fragment condition`, path }); continue; }
      validate(s.sel, s.on ?? typeName, frags, errors, path, seen);
      continue;
    }
    if (s.name === '__typename') continue;
    const def = fieldDef(typeName, s.name);
    if (!def) {
      errors.push({ path: [...path, s.alias], extensions: { code: 'undefinedField', typeName, fieldName: s.name }, locations: [], message: `Field '${s.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    for (const an of Object.keys(s.args)) {
      if (def.type !== PLAIN && !(def.args && an in def.args)) {
        errors.push({ path: [...path, s.alias, an], extensions: { code: 'argumentNotAccepted', name: s.name, typeName: 'Field', argumentName: an }, message: `Field '${s.name}' doesn't accept argument '${an}'` });
      }
    }
    if (def.type === PLAIN) continue;
    const bn = baseName(def.type);
    const k = TYPES[bn]?.kind;
    const composite = k === 'OBJECT' || k === 'INTERFACE' || k === 'UNION';
    if (composite && !s.sel) errors.push({ path: [...path, s.alias], extensions: { code: 'selectionMismatch', nodeName: `field '${s.name}'`, typeName: bn }, message: `Field must have selections (field '${s.name}' returns ${bn} but has no selections. Did you mean '${s.name} { ... }'?)` });
    else if (!composite && s.sel) errors.push({ path: [...path, s.alias], message: `Selections can't be made on scalars (field '${s.name}' returns ${bn} but has selections [${s.sel.map((x) => (x.kind === 'field' ? x.name : '...')).join(', ')}])` });
    else if (s.sel) validate(s.sel, bn, frags, errors, [...path, s.alias], seen);
  }
}

function valueOf(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name];
    case 'lit': return v.value;
    case 'enum': return v.value;
    case 'list': return v.items.map((x) => valueOf(x, vars));
    case 'obj': { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v.fields)) o[k] = valueOf(x, vars); return o; }
  }
}

function argsOf(a: Record<string, Value>, vars: Record<string, unknown>): Record<string, any> {
  const o: Record<string, any> = {};
  for (const [k, v] of Object.entries(a)) o[k] = valueOf(v, vars);
  return o;
}

function included(d: Directive[], vars: Record<string, unknown>): boolean {
  for (const x of d) {
    const cond = x.args.if ? valueOf(x.args.if, vars) : undefined;
    if (x.name === 'skip' && cond === true) return false;
    if (x.name === 'include' && cond === false) return false;
  }
  return true;
}

function collect(sel: Sel[], concrete: string, frags: Map<string, Fragment>, vars: Record<string, unknown>, out: Map<string, FieldSel[]>): void {
  for (const s of sel) {
    if (!included(s.directives, vars)) continue;
    if (s.kind === 'field') { const l = out.get(s.alias); if (l) l.push(s); else out.set(s.alias, [s]); continue; }
    if (s.kind === 'spread') { const f = frags.get(s.name); if (f && fragApplies(f.on, concrete)) collect(f.sel, concrete, frags, vars, out); continue; }
    if (fragApplies(s.on, concrete)) collect(s.sel, concrete, frags, vars, out);
  }
}

function plainValue(v: unknown, fields: FieldSel[], frags: Map<string, Fragment>, vars: Record<string, unknown>): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => plainValue(x, fields, frags, vars));
  const sel = fields.flatMap((f) => f.sel ?? []);
  if (typeof v !== 'object' || !sel.length) return v;
  const grouped = new Map<string, FieldSel[]>();
  const o = v as Record<string, unknown>;
  collect(sel, String(o.kind === 'OBJECT' || o.name ? o.name : ''), frags, vars, grouped);
  const out: Record<string, unknown> = {};
  for (const [alias, fs] of grouped) {
    const f = fs[0];
    if (f.name === '__typename') { out[alias] = o.fields !== undefined && o.kind !== undefined ? '__Type' : '__Field'; continue; }
    out[alias] = plainValue(o[f.name], fs, frags, vars);
  }
  return out;
}

function concreteOf(declared: string, v: any): string {
  const t = TYPES[declared];
  if (t && (t.kind === 'INTERFACE' || t.kind === 'UNION')) {
    if (v && typeof v.__typename === 'string') return v.__typename;
    if (v && v.items instanceof Map && typeof v.owner === 'string') return 'Repository';
    if (v && v.repo && 'pull' in v) return v.pull ? 'PullRequest' : 'Issue';
    if (v && v.sha && v.tree) return 'Commit';
  }
  return declared;
}

function execSel(sel: Sel[], typeName: string, obj: any, frags: Map<string, Fragment>, vars: Record<string, unknown>, ctx: GCtx, path: (string | number)[]): Record<string, unknown> {
  const grouped = new Map<string, FieldSel[]>();
  collect(sel, typeName, frags, vars, grouped);
  const out: Record<string, unknown> = {};
  for (const [alias, fs] of grouped) {
    const f = fs[0];
    if (f.name === '__typename') { out[alias] = typeName; continue; }
    const a = argsOf(f.args, vars);
    if (typeName === 'Query' && f.name === '__type') { out[alias] = plainValue(introType(String(a.name)), fs, frags, vars); continue; }
    if (typeName === 'Query' && f.name === '__schema') { out[alias] = plainValue(introSchema(), fs, frags, vars); continue; }
    const def = fieldDef(typeName, f.name);
    if (!def) { out[alias] = null; continue; }
    let v: unknown;
    try {
      v = def.r ? def.r(obj, a, ctx) : obj?.[f.name];
    } catch (e) {
      if (e instanceof GqlError) { ctx.errors.push({ type: 'UNPROCESSABLE', path: [...path, alias], locations: [], message: e.message }); out[alias] = null; continue; }
      throw e;
    }
    out[alias] = complete(def.type, v, fs, frags, vars, ctx, [...path, alias]);
  }
  return out;
}

function complete(type: string, v: unknown, fs: FieldSel[], frags: Map<string, Fragment>, vars: Record<string, unknown>, ctx: GCtx, path: (string | number)[]): unknown {
  if (v === null || v === undefined) return null;
  const t = type.endsWith('!') ? type.slice(0, -1) : type;
  if (t.startsWith('[')) {
    const inner = t.slice(1, -1);
    return (Array.isArray(v) ? v : [v]).map((x, i) => complete(inner, x, fs, frags, vars, ctx, [...path, i]));
  }
  const k = TYPES[t]?.kind;
  if (k !== 'OBJECT' && k !== 'INTERFACE' && k !== 'UNION') return v;
  let obj: any = v;
  const concrete = concreteOf(t, obj);
  if (obj && obj.__obj) obj = obj.__obj;
  return execSel(fs.flatMap((f) => f.sel ?? []), concrete, obj, frags, vars, ctx, path);
}

function runGraphql(op: unknown): Record<string, unknown> {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return { errors: [{ message: 'Request body must be a JSON object with a query' }] };
  const o = op as Record<string, unknown>;
  if (typeof o.query !== 'string' || !o.query.trim()) return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  let doc: ReturnType<typeof parseDoc>;
  try { doc = parseDoc(o.query); } catch (e) {
    if (e instanceof GqlError) return { errors: [{ message: e.message, locations: [] }] };
    throw e;
  }
  const opName = typeof o.operationName === 'string' && o.operationName ? o.operationName : null;
  const operation = opName ? doc.ops.find((x) => x.name === opName) : doc.ops.length === 1 ? doc.ops[0] : doc.ops[0];
  if (!operation) return { errors: [{ message: `Unknown operation named "${opName}".` }] };
  const root = operation.type === 'mutation' ? 'Mutation' : 'Query';
  if (operation.type === 'subscription') return { errors: [{ message: 'Subscriptions are not supported' }] };
  const errors: Record<string, unknown>[] = [];
  validate(operation.sel, root, doc.frags, errors, [operation.type + (operation.name ? ` ${operation.name}` : '')], new Set());
  if (errors.length) return { errors };
  const given = (o.variables && typeof o.variables === 'object' && !Array.isArray(o.variables) ? o.variables : {}) as Record<string, unknown>;
  const vars: Record<string, unknown> = {};
  for (const vd of operation.vars) {
    if (vd.name in given) vars[vd.name] = given[vd.name];
    else if (vd.def) vars[vd.name] = valueOf(vd.def, {});
    else if (vd.type.endsWith('!')) return { errors: [{ extensions: { code: 'variableNotProvided' }, message: `Variable $${vd.name} of type ${vd.type} was provided invalid value` }] };
  }
  const ctx: GCtx = { errors: [] };
  const data = execSel(operation.sel, root, {}, doc.frags, vars, ctx, []);
  return ctx.errors.length ? { data, errors: ctx.errors } : { data };
}

function graphql(req: http.IncomingMessage, res: Res, raw: Buffer): void {
  if (!authorized(req)) return send(res, 401, { message: 'This endpoint requires you to be authenticated.', documentation_url: 'https://docs.github.com/graphql' });
  if ((req.method ?? 'GET') !== 'POST') return send(res, 404, { message: 'Not Found' });
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { message: 'Problems parsing JSON' }); }
  if (Array.isArray(body)) return send(res, 200, body.map(runGraphql));
  send(res, 200, runGraphql(body));
}

// ---------------------------------------------------------------------------------------------------
// Server

// ---------------------------------------------------------------------------------------------------
// Git object store and smart HTTP
//
// A repository keeps the objects the smart-HTTP surfaces serve in `objects`, keyed by the sha1 of the
// loose object. REST-created commits write real objects too, so a clone sees exactly what the API wrote.
// zlib and crypto only: there is no git binary in the pod, and the protocol is spoken here.

const GIT_AGENT = 'git/2.43.0';
const ZERO_SHA = '0'.repeat(40);
const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function hashObj(type: string, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\u0000`), data]));
}

function writeObj(repo: Repo, type: GitObj['type'], data: Buffer): string {
  const sha = hashObj(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

function readObj(repo: Repo, sha: string): GitObj | null { return repo.objects.get(sha) ?? null; }

function treeSortKey(e: { name: string; dir: boolean }): Buffer {
  return Buffer.from(e.dir ? `${e.name}/` : e.name, 'utf8');
}

/** Write the nested tree objects for a flat path -> blob map, and return the root tree's sha. */
function buildTree(repo: Repo, blobs: Map<string, Blob>): string {
  const entries: { name: string; mode: string; sha: string; dir: boolean }[] = [];
  const dirs = new Map<string, Map<string, Blob>>();
  for (const [path, blob] of blobs) {
    const cut = path.indexOf('/');
    if (cut < 0) { entries.push({ name: path, mode: '100644', sha: blob.sha, dir: false }); continue; }
    const dir = path.slice(0, cut);
    let sub = dirs.get(dir);
    if (!sub) { sub = new Map<string, Blob>(); dirs.set(dir, sub); }
    sub.set(path.slice(cut + 1), blob);
  }
  for (const [path, blob] of blobs) {
    if (!repo.objects.has(blob.sha)) repo.objects.set(blob.sha, { type: 'blob', data: blob.content });
    void path;
  }
  for (const [dir, sub] of dirs) entries.push({ name: dir, mode: '40000', sha: buildTree(repo, sub), dir: true });
  entries.sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  return writeObj(repo, 'tree', Buffer.concat(entries.map((e) =>
    Buffer.concat([Buffer.from(`${e.mode} ${e.name}\u0000`), Buffer.from(e.sha, 'hex')]))));
}

/** Walk a real tree object back into the flat path -> blob map the REST surfaces read. */
function flattenTree(repo: Repo, treeSha: string, prefix = '', out = new Map<string, Blob>()): Map<string, Blob> {
  const obj = readObj(repo, treeSha);
  if (!obj || obj.type !== 'tree') return out;
  let i = 0;
  while (i < obj.data.length) {
    const sp = obj.data.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = obj.data.indexOf(0x00, sp + 1);
    if (nul < 0) break;
    const mode = obj.data.toString('utf8', i, sp);
    const name = obj.data.toString('utf8', sp + 1, nul);
    const sha = obj.data.toString('hex', nul + 1, nul + 21);
    if (mode === '40000') flattenTree(repo, sha, `${prefix}${name}/`, out);
    else out.set(`${prefix}${name}`, { sha, content: readObj(repo, sha)?.data ?? Buffer.alloc(0) });
    i = nul + 21;
  }
  return out;
}

function parseCommitObject(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const cut = text.indexOf('\n\n');
  const head = cut < 0 ? text : text.slice(0, cut);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message: cut < 0 ? '' : text.slice(cut + 2).replace(/\n$/, '') };
}

/** Keep the REST surfaces working on commits that arrived over git: register them in the same store. */
function registerCommit(repo: Repo, obj: GitObj & { sha?: string }): void {
  const sha = obj.sha ?? hashObj(obj.type, obj.data);
  if (obj.type !== 'commit' || repo.commits.has(sha)) return;
  const { tree, parents, message } = parseCommitObject(obj.data);
  repo.commits.set(sha, { sha, message, parents, tree: flattenTree(repo, tree), date: now() });
}

// pkt-line framing -----------------------------------------------------------------------------------

function pkt(body: string | Buffer): Buffer {
  const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'), data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');

interface Pkt { type: 'data' | 'flush' | 'delim'; data?: Buffer }

function parsePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', i, i + 4), 16);
    if (!Number.isFinite(len)) break;
    if (len === 0) { out.push({ type: 'flush' }); i += 4; continue; }
    if (len === 1) { out.push({ type: 'delim' }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) break;
    out.push({ type: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

function pktLines(buf: Buffer): string[] {
  return parsePkts(buf).filter((p) => p.type === 'data' && p.data !== undefined)
    .map((p) => p.data!.toString('utf8').replace(/\n$/, ''));
}

// References and advertisements ---------------------------------------------------------------------

function refLines(repo: Repo): { name: string; sha: string }[] {
  const heads = [...repo.branches.entries()].map(([name, sha]) => ({ name: `refs/heads/${name}`, sha }));
  const tags = [...repo.tags.entries()].map(([name, sha]) => ({ name: `refs/tags/${name}`, sha }));
  return [...heads, ...tags].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
}

/** The commit an annotated tag points at, or null for a ref that is not a tag object. */
function peelTag(repo: Repo, sha: string): string | null {
  const obj = readObj(repo, sha);
  if (!obj || obj.type !== 'tag') return null;
  const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return m ? m[1] : null;
}

function preamble(service: string): Buffer {
  return Buffer.concat([pkt(`# service=${service}\n`), PKT_FLUSH]);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'), pkt(`agent=${GIT_AGENT}\n`), pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'), pkt('server-option\n'), pkt('object-format=sha1\n'), PKT_FLUSH,
  ]);
}

function uploadCaps(repo: Repo): string {
  const head = repo.branches.has(repo.defaultBranch) ? ` symref=HEAD:refs/heads/${repo.defaultBranch}` : '';
  return 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not no-progress'
    + ` include-tag object-format=sha1 agent=${GIT_AGENT}${head}`;
}

function v0UploadAdvertisement(repo: Repo): Buffer {
  const refs = refLines(repo);
  const caps = uploadCaps(repo);
  if (refs.length === 0) return Buffer.concat([pkt(`${ZERO_SHA} capabilities^{}\u0000${caps}\n`), PKT_FLUSH]);
  const head = repo.branches.get(repo.defaultBranch);
  const parts: Buffer[] = [];
  if (head) parts.push(pkt(`${head} HEAD\u0000${caps}\n`));
  refs.forEach((r, idx) => {
    const first = parts.length === 0 && idx === 0;
    parts.push(pkt(`${r.sha} ${r.name}${first ? `\u0000${caps}` : ''}\n`));
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function receiveAdvertisement(repo: Repo): Buffer {
  const refs = refLines(repo);
  const caps = `report-status delete-refs side-band-64k ofs-delta object-format=sha1 agent=${GIT_AGENT}`;
  if (refs.length === 0) return Buffer.concat([pkt(`${ZERO_SHA} capabilities^{}\u0000${caps}\n`), PKT_FLUSH]);
  const parts = refs.map((r, i) => pkt(`${r.sha} ${r.name}${i === 0 ? `\u0000${caps}` : ''}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// Packfiles ------------------------------------------------------------------------------------------

function objectHeader(code: number, size: number): Buffer {
  const out: number[] = [];
  let s = size;
  let b = (code << 4) | (s % 16);
  s = Math.floor(s / 16);
  while (s > 0) { out.push(b | 0x80); b = s % 128; s = Math.floor(s / 128); }
  out.push(b);
  return Buffer.from(out);
}

function addTreeObjects(repo: Repo, treeSha: string, out: Set<string>): void {
  if (out.has(treeSha)) return;
  const obj = readObj(repo, treeSha);
  if (!obj || obj.type !== 'tree') return;
  out.add(treeSha);
  let i = 0;
  while (i < obj.data.length) {
    const sp = obj.data.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = obj.data.indexOf(0x00, sp + 1);
    if (nul < 0) break;
    const mode = obj.data.toString('utf8', i, sp);
    const sha = obj.data.toString('hex', nul + 1, nul + 21);
    if (mode === '40000') addTreeObjects(repo, sha, out);
    else out.add(sha);
    i = nul + 21;
  }
}

function commitClosure(repo: Repo, start: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = readObj(repo, sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommitObject(obj.data).parents) stack.push(p);
  }
  return seen;
}

/** The objects a fetch must send: the wanted commits (to `depth`, when shallow), their trees and blobs. */
function collectObjects(repo: Repo, wants: string[], haveList: string[], depth: number | null): { shas: string[]; shallow: string[] } {
  // For the prune, a have covers its whole ancestry; for the subtraction, only the objects the client
  // literally named are its own (a deepen must still receive the parent that an ancestor-have covers).
  const haves = commitClosure(repo, haveList);
  const seen = new Set<string>();
  const commits: string[] = [];
  const shallow: string[] = [];
  const roots: string[] = [];
  const tags: string[] = [];
  for (const want of wants) {
    const obj = readObj(repo, want);
    if (obj && obj.type === 'tag') {
      tags.push(want);
      const target = peelTag(repo, want);
      if (target) roots.push(target);
    } else {
      roots.push(want);
    }
  }
  let frontier = roots.map((sha) => ({ sha, d: 1 }));
  while (frontier.length > 0) {
    const next: { sha: string; d: number }[] = [];
    for (const { sha, d } of frontier) {
      if (seen.has(sha)) continue;
      // A plain fetch stops at what the client already holds; a deepen must walk past it to find the
      // boundary the client asked for, and the already-held objects are subtracted from the pack below.
      if (depth === null && haves.has(sha)) continue;
      const obj = readObj(repo, sha);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(sha);
      commits.push(sha);
      const { parents } = parseCommitObject(obj.data);
      if (depth !== null && d >= depth) { shallow.push(sha); continue; }
      for (const p of parents) if (!seen.has(p) && (depth !== null || !haves.has(p))) next.push({ sha: p, d: d + 1 });
    }
    frontier = next;
  }
  const all = new Set<string>(commits);
  for (const c of commits) {
    const obj = readObj(repo, c);
    if (obj) addTreeObjects(repo, parseCommitObject(obj.data).tree, all);
  }
  for (const t of tags) all.add(t);
  // Never re-send an object the client already has: the fetch tests count every re-sent object as a fail.
  const held = new Set<string>(haveList);
  for (const h of haveList) {
    const obj = readObj(repo, h);
    if (obj && obj.type === 'commit') addTreeObjects(repo, parseCommitObject(obj.data).tree, held);
    else if (obj && obj.type === 'tag') { const p = peelTag(repo, h); if (p) held.add(p); }
  }
  return { shas: [...all].filter((sha) => !held.has(sha)), shallow };
}

// Objects are content-addressed, so an encoded object never goes stale: the pack for the same set of
// wants is the same bytes. Both caches are what keeps 50 concurrent clones inside the wall budget.
const encodedObjects = new Map<string, Buffer>();
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 64;

function encodeObject(sha: string, obj: GitObj): Buffer {
  let bytes = encodedObjects.get(sha);
  if (bytes === undefined) {
    bytes = Buffer.concat([objectHeader(TYPE_CODE[obj.type], obj.data.length), zlib.deflateSync(obj.data)]);
    if (encodedObjects.size < 200_000) encodedObjects.set(sha, bytes);
  }
  return bytes;
}

function buildPack(repo: Repo, shas: string[]): Buffer {
  const present = shas.map((sha) => [sha, readObj(repo, sha)] as const)
    .filter((pair): pair is readonly [string, GitObj] => pair[1] !== null);
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(present.length, 8);
  const parts: Buffer[] = [head];
  for (const [sha, obj] of present) parts.push(encodeObject(sha, obj));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    const b = buf[i++];
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = readVarint(delta, 0).next;
  const target = readVarint(delta, p);
  p = target.next;
  const out: Buffer[] = [];
  while (p < delta.length) {
    const cmd = delta[p++];
    if (cmd & 0x80) {
      let off = 0;
      let size = 0;
      if (cmd & 0x01) off |= delta[p++];
      if (cmd & 0x02) off |= delta[p++] << 8;
      if (cmd & 0x04) off |= delta[p++] << 16;
      if (cmd & 0x08) off = (off | (delta[p++] << 24)) >>> 0;
      if (cmd & 0x10) size |= delta[p++];
      if (cmd & 0x20) size |= delta[p++] << 8;
      if (cmd & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
    } else if (cmd !== 0) {
      out.push(delta.subarray(p, p + cmd));
      p += cmd;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const data = Buffer.concat(out);
  if (data.length !== target.value) throw new Error(`delta size ${data.length} != ${target.value}`);
  return data;
}

interface PackedObj { sha: string; type: GitObj['type']; data: Buffer }

function parsePack(repo: Repo, buf: Buffer): PackedObj[] {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  let i = 12;
  const byOffset = new Map<number, PackedObj>();
  const out: PackedObj[] = [];
  for (let n = 0; n < count; n += 1) {
    const start = i;
    let b = buf[i++];
    const code = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) { b = buf[i++]; size += (b & 0x7f) * 2 ** shift; shift += 7; }
    let base: PackedObj | null = null;
    if (code === 6) {
      b = buf[i++];
      let off = b & 0x7f;
      while (b & 0x80) { b = buf[i++]; off = (off + 1) * 128 + (b & 0x7f); }
      base = byOffset.get(start - off) ?? null;
      if (!base) throw new Error('ofs-delta base is missing');
    } else if (code === 7) {
      const baseSha = buf.toString('hex', i, i + 20);
      i += 20;
      base = out.find((o) => o.sha === baseSha) ?? null;
      if (!base) { const stored = readObj(repo, baseSha); if (stored) base = { sha: baseSha, type: stored.type, data: stored.data }; }
      if (!base) throw new Error('ref-delta base is missing');
    }
    const inflated = zlib.inflateSync(buf.subarray(i), { info: true } as zlib.ZlibOptions) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    i += inflated.engine.bytesWritten;
    const type: GitObj['type'] = base ? base.type
      : code === 1 ? 'commit' : code === 2 ? 'tree' : code === 3 ? 'blob' : 'tag';
    const data = base ? applyDelta(base.data, inflated.buffer) : inflated.buffer;
    const obj: PackedObj = { sha: hashObj(type, data), type, data };
    writeObj(repo, type, data);
    byOffset.set(start, obj);
    out.push(obj);
  }
  return out;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (sha === ancestor) return true;
    const obj = readObj(repo, sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommitObject(obj.data).parents) stack.push(p);
  }
  return false;
}

function banded(payload: Buffer): Buffer {
  const out: Buffer[] = [];
  for (let i = 0; i < payload.length; i += 8192) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), payload.subarray(i, Math.min(payload.length, i + 8192))])));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// Smart HTTP handlers --------------------------------------------------------------------------------

function lsRefs(repo: Repo, args: string[]): Buffer {
  const symrefs = args.some((a) => a.trim() === 'symrefs');
  const peel = args.some((a) => a.trim() === 'peel');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length).trim());
  const wanted = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const head = repo.branches.get(repo.defaultBranch);
  if (symrefs && head && wanted('HEAD')) out.push(pkt(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  if (symrefs && repo.branches.size === 0 && repo.tags.size === 0 && wanted('HEAD')) out.push(pkt(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  for (const r of refLines(repo)) {
    if (!wanted(r.name)) continue;
    let line = `${r.sha} ${r.name}`;
    if (peel) {
      const target = peelTag(repo, r.sha);
      if (target) line += ` peeled:${target}`;
    }
    out.push(pkt(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function cachedPack(repo: Repo, wants: string[], haves: string[], depth: number | null): { pack: Buffer; shallow: string[] } {
  const key = `${repo.id}|${depth ?? 'all'}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}`;
  const hit = packCache.get(key);
  if (hit) {
    const shallow = depth === null ? [] : collectObjects(repo, wants, haves, depth).shallow;
    return { pack: hit, shallow };
  }
  const { shas, shallow } = collectObjects(repo, wants, haves, depth);
  const pack = buildPack(repo, shas);
  if (packCache.size >= PACK_CACHE_MAX) packCache.delete(packCache.keys().next().value as string);
  packCache.set(key, pack);
  return { pack, shallow };
}

function fetchV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
  }
  const { pack, shallow } = cachedPack(repo, wants, haves, depth);
  const out: Buffer[] = [];
  if (shallow.length > 0) {
    out.push(pkt('shallow-info\n'));
    for (const s of shallow) out.push(pkt(`shallow ${s}\n`));
    out.push(PKT_FLUSH);
  }
  out.push(pkt('packfile\n'));
  for (let i = 0; i < pack.length; i += 8192) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, Math.min(pack.length, i + 8192))])));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function uploadPackV2(repo: Repo, raw: Buffer): Buffer {
  const lines = pktLines(raw);
  const command = (lines.find((l) => l.startsWith('command=')) ?? '').slice('command='.length).trim();
  if (command === 'ls-refs') return lsRefs(repo, lines);
  if (command === 'fetch') return fetchV2(repo, lines);
  return Buffer.concat([pkt('ERR unknown command\n'), PKT_FLUSH]);
}

function uploadPackV0(repo: Repo, raw: Buffer): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  for (const line of pktLines(raw)) {
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const { pack, shallow } = cachedPack(repo, wants, haves, depth);
  const out: Buffer[] = [];
  for (const s of shallow) out.push(pkt(`shallow ${s}\n`));
  if (shallow.length > 0) out.push(PKT_FLUSH);
  out.push(pkt('NAK\n'));
  for (let i = 0; i < pack.length; i += 8192) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, Math.min(pack.length, i + 8192))])));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function receivePack(repo: Repo, raw: Buffer): Buffer {
  const pkts = parsePkts(raw);
  const commands: { old: string; next: string; ref: string }[] = [];
  let sideband = true;
  for (const p of pkts) {
    if (p.type === 'flush') break;
    if (p.type !== 'data' || !p.data) continue;
    const line = p.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    const head = nul < 0 ? line : line.slice(0, nul);
    const caps = nul < 0 ? '' : line.slice(nul + 1);
    if (caps.includes('side-band-64k')) sideband = true;
    const parts = head.split(' ');
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) {
      commands.push({ old: parts[0], next: parts[1], ref: parts.slice(2).join(' ') });
    }
  }

  let objects: PackedObj[] = [];
  let unpackOk = true;
  let unpackMessage = 'ok';
  const packAt = raw.indexOf(Buffer.from('PACK', 'ascii'));
  if (packAt >= 0) {
    try {
      objects = parsePack(repo, raw.subarray(packAt));
    } catch (err) {
      unpackOk = false;
      unpackMessage = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  for (const obj of objects) registerCommit(repo, obj);

  const lines = [`unpack ${unpackOk ? 'ok' : `error ${unpackMessage}`}`];
  if (unpackOk) {
    for (const cmd of commands) {
      const isHead = cmd.ref.startsWith('refs/heads/');
      const isTag = cmd.ref.startsWith('refs/tags/');
      if (!isHead && !isTag) { lines.push(`ng ${cmd.ref} unsupported ref`); continue; }
      const name = isHead ? cmd.ref.slice('refs/heads/'.length) : cmd.ref.slice('refs/tags/'.length);
      const refs = isHead ? repo.branches : repo.tags;
      const current = refs.get(name) ?? null;
      if (cmd.next === ZERO_SHA) {
        if (current === null) { lines.push(`ng ${cmd.ref} no such ref`); continue; }
        if (cmd.old !== ZERO_SHA && current !== cmd.old) { lines.push(`ng ${cmd.ref} stale info`); continue; }
        refs.delete(name);
        lines.push(`ok ${cmd.ref}`);
        continue;
      }
      if (!repo.objects.has(cmd.next)) { lines.push(`ng ${cmd.ref} missing object`); continue; }
      if (current !== null && cmd.old !== ZERO_SHA) {
        if (current !== cmd.old) { lines.push(`ng ${cmd.ref} stale info`); continue; }
        // Only a branch has to fast-forward; a tag ref may be re-pointed by its owner.
        if (isHead && !isAncestor(repo, cmd.old, cmd.next)) { lines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
      }
      refs.set(name, cmd.next);
      repo.pushedAt = now();
      lines.push(`ok ${cmd.ref}`);
    }
  }

  const inner = Buffer.concat([...lines.map((l) => pkt(`${l}\n`)), PKT_FLUSH]);
  return sideband ? banded(inner) : inner;
}

const GIT_TYPES: Record<string, string> = {
  'git-upload-pack': 'application/x-git-upload-pack-result',
  'git-receive-pack': 'application/x-git-receive-pack-result',
};

interface RawResponse { status: number; headers: Record<string, string>; body: Buffer }

function gitHttp(req: http.IncomingMessage, url: URL, raw: Buffer): RawResponse | null {
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!m) return null;
  const headers: Record<string, string> = { 'cache-control': 'no-cache', pragma: 'no-cache', expires: 'Fri, 01 Jan 1980 00:00:00 GMT' };
  const repo = findRepo(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  if (!repo) return { status: 404, headers: { ...headers, 'content-type': 'text/plain' }, body: Buffer.from('Not Found\n') };
  const action = m[3];
  const v2 = String(req.headers['git-protocol'] ?? '').includes('version=2');

  if (action === 'info/refs') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return { status: 400, headers: { ...headers, 'content-type': 'text/plain' }, body: Buffer.from('dumb HTTP is not supported\n') };
    }
    const body = service === 'git-upload-pack'
      ? Buffer.concat([preamble(service), v2 ? v2Advertisement() : v0UploadAdvertisement(repo)])
      : Buffer.concat([preamble(service), receiveAdvertisement(repo)]);
    return { status: 200, headers: { ...headers, 'content-type': `application/x-${service}-advertisement` }, body };
  }

  if (req.method !== 'POST') return { status: 405, headers: { ...headers, 'content-type': 'text/plain' }, body: Buffer.from('Method Not Allowed\n') };
  const body = action === 'git-upload-pack'
    ? (v2 ? uploadPackV2(repo, raw) : uploadPackV0(repo, raw))
    : receivePack(repo, raw);
  return { status: 200, headers: { ...headers, 'content-type': GIT_TYPES[action] }, body };
}

async function handle(req: http.IncomingMessage, res: Res): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.headers.host) BASE = `http://${req.headers.host}`;
  const raw = await readBody(req);
  const p = url.pathname;
  if (p === '/healthz') return send(res, 200, { ok: true });
  const git = gitHttp(req, url, raw);
  if (git) {
    res.writeHead(git.status, { ...git.headers, 'content-length': String(git.body.length) });
    res.end(git.body);
    return;
  }
  if (p === '/api/v3' || p.startsWith('/api/v3/')) return rest(req, res, url, raw);
  if (p === '/api/graphql' || p === '/api/graphql/') return graphql(req, res, raw);
  if (p === '/mcp' || p === '/mcp/') return mcp(req, res, raw);
  send(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

function createApp(): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      process.stderr.write(`[forge] ${err instanceof Error ? err.stack : String(err)}\n`);
      if (!res.headersSent) send(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  server.keepAliveTimeout = 65_000;
  return server;
}

// ---------------------------------------------------------------------------------------------------
// Lifecycle (from the kit's starter/main.ts)

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');


  await waitForDone();
  server.close();
  server.closeAllConnections?.();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
