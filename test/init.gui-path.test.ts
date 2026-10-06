// The hooks used to find agentdef on PATH and nowhere else. A GUI git client
// runs hooks with the PATH the OS gave the app, on macOS
// /usr/bin:/bin:/usr/sbin:/sbin (Obsidian Git does exactly that), and agentdef,
// a node script installed wherever its user's node lives, is never on it. The
// hook printed "skipping" to a stderr no GUI shows, and generated files went
// stale for weeks. Now init bakes in the absolute paths of the node and CLI that
// wrote the hooks, falls back to PATH, and when both fail it says so somewhere a
// human will see it: the next `agentdef sync`.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, buildHooks, hookRunner, HOOK_NAMES, type HookRunner } from '../src/init.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// What a macOS GUI app gets. Neither node nor agentdef lives here, which is the
// whole bug; git (/usr/bin/git), bash, date and mkdir do.
const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const GIT_ENV_OVERRIDES = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@e',
};

// git as the test runner's shell would run it, or, with `path`, as a GUI client
// would: same command, only PATH differs. Returns stderr too, since that is
// where a hook talks.
function git(cwd: string, args: string[], path = process.env.PATH): { status: number; stderr: string } {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...GIT_ENV_OVERRIDES, PATH: path },
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stderr: r.stderr };
}
function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...GIT_ENV_OVERRIDES } }).trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

function fixture(): string {
  const root = tempDir('agentdef-gui-path-test-');
  gitOut(root, ['init', '-q', '-b', 'main']);
  write(root, {
    'agent.yaml': 'name: t\ndescription: t\n',
    'SOUL.md': '# soul\n',
    'services/app/main.py': 'print(1)\n',
  });
  gitOut(root, ['add', '-A']);
  gitOut(root, ['commit', '-q', '-m', 'init']);
  return root;
}

// A stand-in for an install whose paths need quoting: a "node" that records the
// arguments it was started with, next to a CLI entry it never reads. Both sit
// in a directory with a space and a single quote in its name.
function fakeInstall(): { runner: HookRunner; calls: string } {
  const base = join(tempDir('agentdef-fake-install-'), "it's a node dir");
  mkdirSync(join(base, 'dist'), { recursive: true });
  const node = join(base, 'node');
  const cli = join(base, 'dist', 'cli.js');
  writeFileSync(node, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$(dirname "$0")/calls.log"\n');
  chmodSync(node, 0o755);
  writeFileSync(cli, '');
  return { runner: { node, cli }, calls: join(base, 'calls.log') };
}

const GONE: HookRunner = { node: '/nonexistent/agentdef-test/node', cli: '/nonexistent/agentdef-test/dist/cli.js' };

// A stub `agentdef` on a PATH of its own, recording that it ran.
function stubOnPath(): { path: string; calls: string } {
  const bin = tempDir('agentdef-stub-bin-');
  const calls = join(bin, 'calls.log');
  writeFileSync(join(bin, 'agentdef'), `#!/bin/sh\necho "agentdef $*" >> '${calls}'\n`);
  chmodSync(join(bin, 'agentdef'), 0o755);
  return { path: `${bin}:${GUI_PATH}`, calls };
}

function commitSkill(root: string, path?: string): { status: number; stderr: string } {
  write(root, { 'skills/new/SKILL.md': '---\nname: new\ndescription: d\n---\nbody\n' });
  gitOut(root, ['add', '-A']);
  return git(root, ['commit', '-q', '-m', 'add a skill'], path);
}

// The two assignment lines, run through bash: what the hook will actually see.
function bakedPaths(hook: string): string[] {
  const assignments = hook.split('\n').filter((l) => l.startsWith('AGENTDEF_')).join('\n');
  const out = execFileSync('bash', ['-c', `${assignments}\nprintf '%s\\n' "$AGENTDEF_NODE" "$AGENTDEF_CLI"`], {
    encoding: 'utf-8',
  });
  return out.split('\n').slice(0, 2);
}

describe('hook text: which agentdef a hook calls', () => {
  test('every hook carries the absolute node and CLI paths, and is valid bash', () => {
    const runner = { node: '/opt/node/bin/node', cli: '/opt/node/lib/node_modules/@noord-agency/agentdef/dist/cli.js' };
    const hooks = buildHooks('knowledge', runner);
    const dir = tempDir('agentdef-hook-text-');
    for (const name of HOOK_NAMES) {
      assert.deepEqual(bakedPaths(hooks[name]), [runner.node, runner.cli], name);
      assert.ok(hooks[name].startsWith('#!/usr/bin/env bash\n'), `${name} keeps its shebang`);
      writeFileSync(join(dir, name), hooks[name]);
      const check = spawnSync('bash', ['-n', join(dir, name)], { encoding: 'utf-8' });
      assert.equal(check.status, 0, `${name} must parse: ${check.stderr}`);
    }
  });

  // Install paths contain spaces (Program Files) and may contain quotes (a home
  // directory for O'Brien). A quoting slip there breaks the hook on exactly the
  // machines nobody tests on.
  test('a path with a space and a single quote reaches bash unchanged', () => {
    const node = "/Users/o'brien/Program Files/node/bin/node";
    const cli = "/Users/o'brien/it's here/dist/cli.js";
    const hooks = buildHooks('knowledge', hookRunner({ platform: 'darwin', execPath: node, cliPath: cli }));
    assert.deepEqual(bakedPaths(hooks['post-merge']), [node, cli]);
  });

  // Git for Windows runs hooks in Git Bash, which executes C:/... as written.
  test('on Windows the paths are written with forward slashes', () => {
    const runner = hookRunner({
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      cliPath: 'C:\\Users\\kevin\\AppData\\Roaming\\npm\\node_modules\\@noord-agency\\agentdef\\dist\\cli.js',
    });
    assert.deepEqual(runner, {
      node: 'C:/Program Files/nodejs/node.exe',
      cli: 'C:/Users/kevin/AppData/Roaming/npm/node_modules/@noord-agency/agentdef/dist/cli.js',
    });
    const hook = buildHooks('knowledge', runner)['post-commit'];
    assert.ok(hook.includes("AGENTDEF_NODE='C:/Program Files/nodejs/node.exe'\n"));
    assert.ok(!/^AGENTDEF_.*\\/m.test(hook), 'no backslash left in a baked path');
  });

  // A backslash is a legal file name character on POSIX, so converting it
  // there would point the hook at a path that does not exist.
  test('elsewhere a backslash is left alone', () => {
    assert.equal(hookRunner({ platform: 'linux', execPath: '/opt/odd\\name/node' }).node, '/opt/odd\\name/node');
  });

  // The defaults are the point: the node that is running, and the cli.js next
  // to the init module (dist/cli.js in the package), not process.argv[1], which
  // under a test runner is a test file.
  test('by default it is the running node and the cli.js beside the init module', () => {
    const runner = hookRunner({ platform: 'linux' });
    assert.equal(runner.node, process.execPath);
    assert.ok(isAbsolute(runner.cli));
    const initModule = fileURLToPath(import.meta.resolve('../src/init.ts'));
    assert.equal(runner.cli, join(dirname(initModule), 'cli.js'));
  });
});

describe('hook behaviour with a GUI client PATH (real commits)', () => {
  test('the baked paths reach agentdef although PATH has neither node nor agentdef', () => {
    const root = fixture();
    const { runner, calls } = fakeInstall();
    init(root, runner);

    const r = commitSkill(root, GUI_PATH);

    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(calls, 'utf-8'), `${runner.cli}\nsync\n`);
    assert.ok(!existsSync(join(root, '.agentdef', 'sync-skipped')), 'nothing was skipped');
  });

  test('the baked paths win over an agentdef on PATH', () => {
    const root = fixture();
    const { runner, calls } = fakeInstall();
    const stub = stubOnPath();
    init(root, runner);

    commitSkill(root, stub.path);

    assert.equal(readFileSync(calls, 'utf-8'), `${runner.cli}\nsync\n`);
    assert.ok(!existsSync(stub.calls), 'PATH is only the fallback');
  });

  // nvm uninstalling a node version, a Homebrew upgrade removing the old
  // Cellar: the baked node can disappear. PATH is the second chance.
  test('when the baked paths are gone, agentdef on PATH is used', () => {
    const root = fixture();
    const stub = stubOnPath();
    init(root, GONE);

    commitSkill(root, stub.path);

    assert.equal(readFileSync(stub.calls, 'utf-8'), 'agentdef sync\n');
  });

  test('when nothing is found it is loud, records the skip, and never blocks the commit', () => {
    const root = fixture();
    init(root, GONE);

    const r = commitSkill(root, GUI_PATH);

    assert.equal(r.status, 0, 'a missing tool must never fail a commit');
    assert.equal(gitOut(root, ['rev-list', '--count', 'HEAD']), '2', 'the commit landed');
    assert.match(r.stderr, /agentdef was not found \(.* is missing, and PATH has none\), so nothing was synced/);

    const record = readFileSync(join(root, '.agentdef', 'sync-skipped'), 'utf-8');
    assert.match(
      record,
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ post-commit: agentdef not found \(PATH=[^\n]*\/usr\/bin:\/bin:\/usr\/sbin:\/sbin\)\n$/,
    );
    // init gitignores .agentdef/, so the record never shows up as a change.
    assert.doesNotMatch(gitOut(root, ['status', '--porcelain']), /\.agentdef/);
  });

  // The record means "a sync was needed and missed". Written on every commit it
  // would grow with each autosave of a GUI client and mean nothing.
  test('a commit that touches no agent source stays silent and records nothing', () => {
    const root = fixture();
    init(root, GONE);

    write(root, { 'services/app/main.py': 'print(2)\n' });
    const r = git(root, ['commit', '-q', '-am', 'app change'], GUI_PATH);

    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /agentdef/);
    assert.ok(!existsSync(join(root, '.agentdef', 'sync-skipped')));
  });
});
