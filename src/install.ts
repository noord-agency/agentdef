import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAgentManifest } from './loader.js';

function isGitSource(source: string): boolean {
  return (
    source.endsWith('.git') ||
    source.includes('github.com') ||
    source.includes('gitlab.com') ||
    source.includes('bitbucket.org')
  );
}

function cloneGitRepo(source: string, targetDir: string, version?: string): void {
  const args = ['clone', '--depth', '1'];
  if (version) args.push('--branch', version.replace('^', ''));
  args.push(source, targetDir);
  mkdirSync(join(targetDir, '..'), { recursive: true });
  execFileSync('git', args, { stdio: 'pipe', timeout: 60_000 });
}

export interface InstallResult {
  installed: string[];
}

// Resolve `extends:` by materializing the parent agent into .gitagent/parent,
// from a local path or a git URL. The adapters then read .gitagent/parent for
// inheritance. (Dependencies[] are not used by noord; add when a repo needs them.)
export function install(dir: string, opts: { force?: boolean } = {}): InstallResult {
  const agentDir = resolve(dir);
  const manifest = loadAgentManifest(agentDir);
  const installed: string[] = [];

  if (!manifest.extends) return { installed };

  const source = manifest.extends;
  const parentDir = join(agentDir, '.gitagent', 'parent');

  if (existsSync(parentDir)) {
    if (!opts.force) return { installed };
    rmSync(parentDir, { recursive: true, force: true });
  }

  const localPath = resolve(agentDir, source);
  if (existsSync(localPath)) {
    mkdirSync(join(parentDir, '..'), { recursive: true });
    cpSync(localPath, parentDir, { recursive: true });
  } else if (isGitSource(source)) {
    cloneGitRepo(source, parentDir);
  } else {
    throw new Error(`extends: unknown source type "${source}" (expected a local path or git URL)`);
  }

  if (!existsSync(join(parentDir, 'agent.yaml'))) {
    throw new Error(`extends: parent at ${source} has no agent.yaml, not a valid gitagent`);
  }
  installed.push('parent');
  return { installed };
}
