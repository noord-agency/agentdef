import { existsSync, mkdirSync, rmSync, cpSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAgentManifest } from './loader.js';
import { knowledgeDirName } from './knowledge.js';
import { AGENTDEF_DIR } from './paths.js';
import { gitSubprocessEnv } from './git-env.js';
function isGitSource(source) {
    return (source.endsWith('.git') ||
        source.includes('github.com') ||
        source.includes('gitlab.com') ||
        source.includes('bitbucket.org'));
}
// Paths agentdef reads out of a parent for every consumer: skills/ and agents/
// (mirror.ts, skills.ts) plus that level's knowledge dir, which is renameable per
// level via `knowledge: { dir: }` and so cannot be a constant. An `include:` can
// only add to this set, never remove from it. memory/ is deliberately absent:
// doc.ts reads memory/MEMORY.md from the local repo only, never from a parent.
const ESSENTIAL_PATHS = ['skills', 'agents'];
function essentialPathsFor(targetDir, where) {
    // knowledge.dir is unchecked YAML from the same untrusted manifest and lands in
    // the same argv as the include: entries, so it goes through the same gate.
    const knowledge = checkPathEntry(knowledgeDirName(targetDir), `${where}: knowledge.dir`);
    return [...new Set([...ESSENTIAL_PATHS, knowledge])];
}
// The floor is 2.37, not 2.26. `git clone --sparse` works from 2.26, but this
// code depends on the whole selection running in CONE mode, and `sparse-checkout
// set` only defaults to cone from 2.37. In non-cone mode the same arguments are
// read as gitignore-style patterns, which do NOT imply the root files, so the
// selection would delete agent.yaml, SOUL.md and RULES.md out of the parent
// cache. Everything below 2.37 therefore takes the plain full clone agentdef has
// always done, which is the already-exercised path, rather than a mode this code
// would silently misread. (2.37 is mid-2022, so this costs essentially nobody.)
//
// The version string is cached alongside the verdict: the fallback warning needs
// it, and re-running `git --version` there would throw on exactly the machines
// where the probe already failed, turning a graceful degradation into an error.
let sparseSupport;
function gitSparseSupport() {
    if (sparseSupport !== undefined)
        return sparseSupport;
    try {
        const raw = gitOut(['--version']);
        const m = raw.match(/(\d+)\.(\d+)/);
        sparseSupport = {
            ok: m ? Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 37) : false,
            version: m ? `${m[1]}.${m[2]}` : 'of unknown version',
        };
    }
    catch {
        sparseSupport = { ok: false, version: 'of unknown version' };
    }
    return sparseSupport;
}
// Returns whether the clone is sparse-capable, i.e. whether a selection can be
// applied afterwards. `--filter=blob:none --sparse` fetches the commit and tree
// objects but defers blobs; the implicit sparse-checkout the clone runs then
// pulls exactly the root files, so agent.yaml is on disk when this returns and
// the include list can be read before any subdirectory is fetched.
function cloneGitRepo(source, targetDir, version) {
    const sparse = gitSparseSupport().ok;
    const args = ['clone', '--depth', '1'];
    if (sparse)
        args.push('--filter=blob:none', '--sparse');
    if (version)
        args.push('--branch', version.replace('^', ''));
    args.push(source, targetDir);
    mkdirSync(join(targetDir, '..'), { recursive: true });
    execFileSync('git', args, { stdio: 'pipe', timeout: 60_000, env: gitSubprocessEnv() });
    return sparse;
}
// An `include:` entry becomes a git argv element, so it is checked before it can
// become one. The `--` end-of-options token below already stops an option-shaped
// entry from being parsed as a flag (without it, `--no-cone` silently turns cone
// mode off and drops agent.yaml/SOUL.md/RULES.md from the checkout), but it does
// nothing about the rest: git rejects wildcards, absolute paths and `..` with a
// bare exit 128, and an entry carrying a newline passes git's own checks and
// writes raw extra lines into .git/info/sparse-checkout.
//
// This is a blocklist, unlike the allowlist init.ts applies to knowledge.dir,
// because that value is interpolated into a shell case pattern while this one is
// argv: the risky shapes are enumerable here, and an allowlist would reject
// legitimate non-ASCII directory names.
//
// It matters more than a normal input check because the mistake is invisible to
// the person who can fix it: a parent never applies its own `include:`, so a bad
// entry only ever fails on the consumers, in an unattended git hook.
// Shared by `include:` entries and by knowledge.dir, which reaches the same argv
// through essentialPathsFor and is just as much unchecked YAML from a repo the
// consumer does not own.
export function checkPathEntry(entry, at) {
    if (typeof entry !== 'string') {
        throw new Error(`${at} must be a string, got ${entry === null ? 'null' : typeof entry}`);
    }
    const path = entry.trim();
    const segments = path.split('/');
    const reason = path === ''
        ? 'is empty'
        : /^[-/!~]/.test(path)
            ? 'must not start with "-", "/", "!" or "~"'
            : /[*?[\]\\]/.test(path)
                ? 'must be a directory, not a wildcard pattern'
                : /[\u0000-\u001f]/.test(path)
                    ? 'must not contain control characters or newlines'
                    : segments.includes('..')
                        ? 'must not contain a ".." segment'
                        : // "." selects the repository root, which cone mode then reads as
                            // "root files only": silently the OPPOSITE of the whole tree the
                            // author meant. "./tools" is the same trap spelled longer.
                            segments.includes('.')
                                ? 'must not contain a "." segment (drop include: entirely to ship everything)'
                                : '';
    if (reason)
        throw new Error(`${at} ${JSON.stringify(entry)} ${reason}`);
    return path;
}
export function parseIncludeList(value, where) {
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value)) {
        throw new Error(`${where}: "include" must be a list of paths, got ${typeof value}`);
    }
    return value.map((entry, i) => checkPathEntry(entry, `${where}: include[${i}]`));
}
// Applies the parent's own `include:` to the still-sparse clone:
//   absent  -> sparse-checkout disable, i.e. the full tree, byte-identical to
//              the plain clone agentdef has always done
//   present -> essentials + the declared paths, and nothing else is ever fetched
//   []      -> essentials only
// Cone mode always materialises every file at the repository root, so agent.yaml,
// SOUL.md and RULES.md arrive regardless and `include:` only ever names
// subdirectories. A listed path that does not exist is a silent no-op in cone
// mode, which validate() warns about in the repo that declared it.
function applySparseSelection(targetDir, source, warnings) {
    const where = `extends: ${source}: agent.yaml`;
    const manifest = loadAgentManifest(targetDir);
    const include = parseIncludeList(manifest.include, where);
    const args = include
        ? ['sparse-checkout', 'set', '--', ...essentialPathsFor(targetDir, where), ...include]
        : ['sparse-checkout', 'disable'];
    execFileSync('git', ['-C', targetDir, ...args], { stdio: 'pipe', timeout: 60_000, env: gitSubprocessEnv() });
    if (!include)
        return;
    // The selection is the step that can empty this cache, so verify rather than
    // assume. Cone mode is what guarantees the root files; if it were ever off,
    // these same arguments would be read as gitignore patterns and take agent.yaml
    // with them. Checked here, before the swap, so a surprise costs nothing.
    if (gitOut(['-C', targetDir, 'config', 'core.sparseCheckoutCone']) !== 'true') {
        throw new Error(`extends: ${source}: sparse-checkout left cone mode; refusing to swap in a cache that may be missing its root files`);
    }
    if (!existsSync(join(targetDir, 'agent.yaml'))) {
        throw new Error(`extends: ${source}: the include: selection removed agent.yaml from the checkout`);
    }
    // `--filter` is advisory: a remote with uploadpack.allowFilter off accepts the
    // clone, prints a warning agentdef swallows via stdio:'pipe', and sends
    // everything. The base repo asked for a trimmed fetch and did not get one, so
    // say so rather than let it believe otherwise.
    try {
        const missing = gitOut(['-C', targetDir, 'rev-list', '--objects', '--all', '--missing=print'])
            .split('\n')
            .filter((l) => l.startsWith('?')).length;
        if (missing === 0) {
            warnings.push(`warning: ${source} declares include:, but its remote does not support fetch filtering — the full repository was transferred (the working tree is still trimmed)`);
        }
    }
    catch {
        // A diagnostic only; never fail an otherwise good clone over it.
    }
}
function gitOut(args, cwd) {
    return execFileSync('git', args, {
        ...(cwd ? { cwd } : {}),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 15_000,
        env: gitSubprocessEnv(),
    }).trim();
}
// Clone into a sibling temp dir, verify, then swap. Failure-safe where a plain
// rm-then-clone is not: a network drop mid-clone leaves the previous
// materialization intact instead of destroying it.
//
// applySparseSelection belongs INSIDE this window, on tmpDir. On a partial clone
// it is a second network operation (it backfills the deferred blobs), and at
// --depth 1 it carries most of the bytes, so it is the likelier of the two to
// fail. Run after the swap it would leave a root-files-only cache behind, with
// the right origin URL and the right HEAD SHA — exactly and only what
// cachedParentIsCurrent() gates on — so every later sync would certify it as
// healthy while every inherited skill, agent and knowledge doc stayed missing.
// Here a failure throws with the previous cache untouched, and sparse state
// survives the rename (it lives in .git/info, which carries no absolute paths).
function cloneAndSwap(source, parentDir, warnings) {
    const tmpDir = `${parentDir}.tmp-${process.pid}`;
    rmSync(tmpDir, { recursive: true, force: true });
    try {
        const sparse = cloneGitRepo(source, tmpDir);
        if (!existsSync(join(tmpDir, 'agent.yaml'))) {
            throw new Error(`extends: parent at ${source} has no agent.yaml, not a valid agent definition`);
        }
        if (sparse) {
            applySparseSelection(tmpDir, source, warnings);
        }
        else if (parseIncludeList(loadAgentManifest(tmpDir).include, `extends: ${source}: agent.yaml`)) {
            // Too old a git to filter, but the parent asked to be trimmed. The clone
            // is complete and correct, so this is a warning and not a failure.
            warnings.push(`warning: ${source} declares include: but git ${gitOut(['--version']).replace('git version ', '')} cannot do a partial clone (needs 2.26+) — fetched the full tree instead`);
        }
        rmSync(parentDir, { recursive: true, force: true });
        renameSync(tmpDir, parentDir);
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}
// Resolve `extends:` by materializing the parent agent into .agentdef/parent,
// from a local path or a git URL — then recurse into that parent's own extends,
// so a whole ancestry (e.g. noord -> we-site -> texte) resolves in a single pass.
// Each ancestor lands one level deeper (.agentdef/parent/.agentdef/parent/...);
// the adapters walk that chain with nearer ancestors winning on collision (see
// sources.ts and merge.ts), so a local skill still overrides every inherited one.
// (Dependencies[] are not used by noord; add when a repo needs them.)
export function install(dir, opts = {}) {
    const installed = [];
    const warnings = [];
    const root = resolve(dir);
    // Seed with the root's own identity so a chain that points back to it (directly
    // or transitively) is caught before any copy, not after a self-copy crash.
    resolveExtends(root, root, opts.mode ?? 'reuse', new Set([root]), installed, warnings);
    return { installed, warnings };
}
// Whether the materialized git parent can be kept as-is under `refresh`: same
// origin URL (an edited extends: must re-clone) and the remote HEAD unchanged.
// Network failure keeps the cache with a loud warning rather than aborting:
// the cache is a previously-validated materialization and sync runs from git
// hooks on every pull, so it must survive being offline. Real definition errors
// (bad agent.yaml, cycles, missing parent manifest) still fail loudly below.
function cachedParentIsCurrent(source, parentDir, warnings) {
    let originUrl;
    let localSha;
    try {
        originUrl = gitOut(['config', '--get', 'remote.origin.url'], parentDir);
        localSha = gitOut(['rev-parse', 'HEAD'], parentDir);
    }
    catch {
        return false; // no .git or corrupt cache: re-clone
    }
    if (originUrl !== source)
        return false;
    let remoteSha;
    try {
        // The clone never passes a ref (see cloneGitRepo's unused version param), so
        // HEAD is the one ref to compare. If pinned refs ever land, gate on the ref.
        remoteSha = gitOut(['ls-remote', source, 'HEAD']).split(/\s+/)[0] ?? '';
    }
    catch {
        warnings.push(`warning: could not check ${source} for updates (offline?) — using cached parent @ ${localSha.slice(0, 7)}`);
        return true;
    }
    return remoteSha !== '' && remoteSha === localSha;
}
// One link in the chain: materialize this agent's parent, then recurse into the
// parent so its own extends resolves too. `sourceDir` is where this agent
// originally lives (for the root, agentDir itself): a materialized copy under
// .agentdef/parent must resolve its relative `extends:` against the original
// location, not the copy, or every second-level local parent goes missing.
// `seen` holds the identities already in the chain (the root, plus every source
// pulled in), so a repo that (transitively) extends itself fails loudly here
// instead of cloning forever.
function resolveExtends(agentDir, sourceDir, mode, seen, installed, warnings) {
    const manifest = loadAgentManifest(agentDir);
    if (!manifest.extends)
        return;
    const source = manifest.extends;
    const localPath = resolve(sourceDir, source);
    const isLocal = existsSync(localPath);
    const key = isLocal ? localPath : source;
    if (seen.has(key)) {
        throw new Error(`extends: cycle detected — "${source}" already appears in the chain`);
    }
    seen.add(key);
    const parentDir = join(agentDir, AGENTDEF_DIR, 'parent');
    // A git-cloned parent has no original location on this machine, so the clone
    // itself is the best base for resolving whatever it extends.
    const parentSourceDir = isLocal ? localPath : parentDir;
    if (existsSync(parentDir)) {
        const keep = mode === 'reuse' ||
            (mode === 'refresh' &&
                !isLocal &&
                isGitSource(source) &&
                cachedParentIsCurrent(source, parentDir, warnings));
        if (keep) {
            // Already materialized and current enough; resolve its chain so any deeper
            // ancestor still missing (or stale) gets handled, then stop.
            resolveExtends(parentDir, parentSourceDir, mode, seen, installed, warnings);
            return;
        }
        if (isLocal)
            rmSync(parentDir, { recursive: true, force: true });
    }
    if (isLocal) {
        mkdirSync(join(parentDir, '..'), { recursive: true });
        cpSync(localPath, parentDir, { recursive: true });
        if (!existsSync(join(parentDir, 'agent.yaml'))) {
            throw new Error(`extends: parent at ${source} has no agent.yaml, not a valid agent definition`);
        }
    }
    else if (isGitSource(source)) {
        cloneAndSwap(source, parentDir, warnings);
    }
    else {
        throw new Error(`extends: unknown source type "${source}" (expected a local path or git URL)`);
    }
    installed.push(installed.length === 0 ? 'parent' : `parent^${installed.length + 1}`);
    resolveExtends(parentDir, parentSourceDir, mode, seen, installed, warnings);
}
