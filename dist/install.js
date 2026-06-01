import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAgentManifest } from './loader.js';
import { AGENTDEF_DIR } from './paths.js';
function isGitSource(source) {
    return (source.endsWith('.git') ||
        source.includes('github.com') ||
        source.includes('gitlab.com') ||
        source.includes('bitbucket.org'));
}
function cloneGitRepo(source, targetDir, version) {
    const args = ['clone', '--depth', '1'];
    if (version)
        args.push('--branch', version.replace('^', ''));
    args.push(source, targetDir);
    mkdirSync(join(targetDir, '..'), { recursive: true });
    execFileSync('git', args, { stdio: 'pipe', timeout: 60_000 });
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
    const root = resolve(dir);
    // Seed with the root's own identity so a chain that points back to it (directly
    // or transitively) is caught before any copy, not after a self-copy crash.
    resolveExtends(root, Boolean(opts.force), new Set([root]), installed);
    return { installed };
}
// One link in the chain: materialize this agent's parent, then recurse into the
// parent so its own extends resolves too. `seen` holds the identities already in
// the chain (the root, plus every source pulled in), so a repo that (transitively)
// extends itself fails loudly here instead of cloning forever.
function resolveExtends(agentDir, force, seen, installed) {
    const manifest = loadAgentManifest(agentDir);
    if (!manifest.extends)
        return;
    const source = manifest.extends;
    const localPath = resolve(agentDir, source);
    const key = existsSync(localPath) ? localPath : source;
    if (seen.has(key)) {
        throw new Error(`extends: cycle detected — "${source}" already appears in the chain`);
    }
    seen.add(key);
    const parentDir = join(agentDir, AGENTDEF_DIR, 'parent');
    if (existsSync(parentDir)) {
        if (!force) {
            // Already materialized by a prior run; resolve its chain so any deeper
            // ancestor still missing gets filled in, then stop.
            resolveExtends(parentDir, force, seen, installed);
            return;
        }
        rmSync(parentDir, { recursive: true, force: true });
    }
    if (existsSync(localPath)) {
        mkdirSync(join(parentDir, '..'), { recursive: true });
        cpSync(localPath, parentDir, { recursive: true });
    }
    else if (isGitSource(source)) {
        cloneGitRepo(source, parentDir);
    }
    else {
        throw new Error(`extends: unknown source type "${source}" (expected a local path or git URL)`);
    }
    if (!existsSync(join(parentDir, 'agent.yaml'))) {
        throw new Error(`extends: parent at ${source} has no agent.yaml, not a valid agent definition`);
    }
    installed.push(installed.length === 0 ? 'parent' : `parent^${installed.length + 1}`);
    resolveExtends(parentDir, force, seen, installed);
}
