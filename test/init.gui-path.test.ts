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
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, chmodSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute, delimiter } from 'node:path';
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

  // The defaults are the point: the node that is running (possibly by another
  // name, see below), and the cli.js next to the init module (dist/cli.js in
  // the package), not process.argv[1], which under a test runner is a test file.
  test('by default it is the running node and the cli.js beside the init module', () => {
    const runner = hookRunner({ platform: 'linux' });
    assert.ok(isAbsolute(runner.node));
    assert.equal(realpathSync(runner.node), realpathSync(process.execPath));
    assert.ok(isAbsolute(runner.cli));
    const initModule = fileURLToPath(import.meta.resolve('../src/init.ts'));
    assert.equal(runner.cli, join(dirname(initModule), 'cli.js'));
  });

  // A Homebrew prefix with one node formula installed: the versioned keg in
  // Cellar, and opt/<formula> linking to it the way brew does.
  function brew(formula: string, version: string): { prefix: string; cellarNode: string } {
    const prefix = realpathSync(tempDir('agentdef-brew-'));
    const cellarNode = join(prefix, 'Cellar', formula, version, 'bin', 'node');
    mkdirSync(dirname(cellarNode), { recursive: true });
    writeFileSync(cellarNode, '');
    mkdirSync(join(prefix, 'opt'));
    symlinkSync(join('..', 'Cellar', formula, version), join(prefix, 'opt', formula));
    return { prefix, cellarNode };
  }

  // Homebrew: process.execPath is the Cellar binary, which the cleanup after
  // `brew upgrade node` deletes, while opt/<formula> is repointed by every
  // upgrade. Baking the Cellar path made every GUI hook skip after each node
  // upgrade until someone synced from a terminal.
  test('a Homebrew Cellar node is baked by its opt name, keg-only formulae too', () => {
    for (const formula of ['node', 'node@22']) {
      const { prefix, cellarNode } = brew(formula, '22.11.0');
      const runner = hookRunner({ platform: 'darwin', execPath: cellarNode, cliPath: '/x/cli.js', hookNode: undefined });
      assert.equal(runner.node, join(prefix, 'opt', formula, 'bin', 'node'), formula);
    }
  });

  // opt already points at the upgraded keg while the old one still runs (an
  // agentdef started before `brew upgrade` finished). The opt name would bake
  // a different node than the one running.
  test('a Cellar node whose opt link points elsewhere keeps its own path', () => {
    const { prefix, cellarNode } = brew('node', '25.6.1');
    const older = join(prefix, 'Cellar', 'node', '24.0.0', 'bin', 'node');
    mkdirSync(dirname(older), { recursive: true });
    writeFileSync(older, '');

    assert.equal(hookRunner({ platform: 'darwin', execPath: older, cliPath: '/x/cli.js', hookNode: undefined }).node, older);
    assert.equal(
      hookRunner({ platform: 'darwin', execPath: cellarNode, cliPath: '/x/cli.js', hookNode: undefined }).node,
      join(prefix, 'opt', 'node', 'bin', 'node'),
    );
  });

  // fnm puts a per-shell directory on PATH (fnm_multishells/<pid>_<time>/bin)
  // that links to the running node and is deleted with the shell. Baked from
  // there, the hook would lose its node once that terminal closes.
  test('a symlink to the running node on PATH is not baked', () => {
    const real = join(realpathSync(tempDir('agentdef-fnm-')), 'node-versions', 'v22', 'installation', 'bin', 'node');
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, '');
    const multishell = join(tempDir('agentdef-fnm-multishells-'), '12345_1700000000000', 'bin');
    mkdirSync(multishell, { recursive: true });
    symlinkSync(real, join(multishell, 'node'));
    const savedPath = process.env.PATH;
    process.env.PATH = `${multishell}${delimiter}${savedPath}`;
    try {
      assert.equal(hookRunner({ platform: 'darwin', execPath: real, cliPath: '/x/cli.js', hookNode: undefined }).node, real);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  // A hook passes the node it started sync with. A GUI client's PATH has no
  // node at all, so a choice that depends on PATH gave a GUI run another name
  // than the terminal run before it, and each rewrote the hooks to its own.
  test('the node a hook started sync with comes first', () => {
    const { prefix, cellarNode } = brew('node', '25.6.1');
    mkdirSync(join(prefix, 'bin'));
    symlinkSync(join('..', 'Cellar', 'node', '25.6.1', 'bin', 'node'), join(prefix, 'bin', 'node'));
    const source = { platform: 'darwin' as const, execPath: cellarNode, cliPath: '/x/cli.js' };

    assert.equal(hookRunner({ ...source, hookNode: join(prefix, 'bin', 'node') }).node, join(prefix, 'bin', 'node'));
    assert.equal(hookRunner({ ...source, hookNode: undefined }).node, join(prefix, 'opt', 'node', 'bin', 'node'));
  });

  // Inherited by a sync that some other node runs, the variable names a
  // binary that is not running, and baking it would switch the hooks to it.
  test('a hook node that is another binary is ignored', () => {
    const prefix = tempDir('agentdef-hook-node-other-');
    mkdirSync(join(prefix, 'a'));
    mkdirSync(join(prefix, 'b'));
    writeFileSync(join(prefix, 'a', 'node'), '');
    writeFileSync(join(prefix, 'b', 'node'), '');
    const execPath = realpathSync(join(prefix, 'a', 'node'));

    assert.equal(hookRunner({ platform: 'darwin', execPath, cliPath: '/x/cli.js', hookNode: join(prefix, 'b', 'node') }).node, execPath);
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

  // git runs one hooks dir for all worktrees of a repo, the main one's. init
  // in a linked worktree used to install into .git/worktrees/<name>/hooks,
  // which git never runs, and said it had installed them.
  test('init in a linked worktree installs the hooks git runs there', () => {
    const root = fixture();
    const wt = join(tempDir('agentdef-worktree-'), 'wt');
    gitOut(root, ['worktree', 'add', '-q', wt]);
    const { runner, calls } = fakeInstall();

    const res = init(wt, runner);

    assert.equal(realpathSync(res.hooksDir), realpathSync(join(root, '.git', 'hooks')));
    const r = commitSkill(wt, GUI_PATH);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(calls, 'utf-8'), `${runner.cli}\nsync\n`, 'the commit in the worktree ran the hook');
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

// A sync the hook starts runs under the GUI client's PATH, a sync from a
// terminal under the shell's. Each used to pick the node name its own PATH
// offered and rewrite all four hooks to it: the GUI run baked the versioned
// Cellar path that the next `brew upgrade node` deletes, the terminal run baked
// the symlink back, and every switch printed "git hooks refreshed".
describe('the hooks stay put between GUI and terminal syncs (real commits)', () => {
  // An installed agentdef as far as the hooks can tell: a CLI entry that
  // exists, running this branch's sync with the default node choice. Only the
  // CLI path is fixed, the tsx default (src/cli.js) does not exist. Each run
  // appends what sync reported to `log`.
  function sourceInstall(): { cli: string; log: string } {
    const base = realpathSync(tempDir('agentdef-source-install-'));
    const cli = join(base, 'cli.mjs');
    const log = join(base, 'runs.log');
    writeFileSync(
      cli,
      [
        `import { appendFileSync } from 'node:fs';`,
        `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};`,
        `register();`,
        `const { sync } = await import(${JSON.stringify(import.meta.resolve('../src/sync.ts'))});`,
        `const { hookRunner } = await import(${JSON.stringify(import.meta.resolve('../src/init.ts'))});`,
        `const res = sync(process.cwd(), { runner: hookRunner({ cliPath: process.argv[1] }) });`,
        `appendFileSync(${JSON.stringify(log)}, JSON.stringify([...res.written, ...res.warnings]) + '\\n');`,
      ].join('\n'),
    );
    return { cli, log };
  }

  test('a hook run under the bare GUI PATH and a terminal sync both leave them unchanged', () => {
    const root = fixture();
    write(root, { '.agent-adapters': 'claude-code\n' });
    // The symlink a terminal has on PATH, /opt/homebrew/bin/node say, pointing
    // at the node that runs these tests.
    const bin = tempDir('agentdef-node-link-');
    symlinkSync(process.execPath, join(bin, 'node'));
    const { cli, log } = sourceInstall();
    init(root, { node: join(bin, 'node'), cli });
    const hooks = () => HOOK_NAMES.map((name) => readFileSync(join(root, '.git', 'hooks', name), 'utf-8'));
    const before = hooks();

    const gui = commitSkill(root, GUI_PATH);

    assert.equal(gui.status, 0, gui.stderr);
    const runs = () => readFileSync(log, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    assert.equal(runs().length, 1, `the hook ran sync: ${gui.stderr}`);
    assert.deepEqual(runs()[0].filter((l) => /git hooks/.test(l)), [], 'nothing refreshed, nothing warned');
    assert.deepEqual(hooks(), before);

    const terminal = spawnSync(join(bin, 'node'), [cli], {
      cwd: root,
      encoding: 'utf-8',
      env: { ...process.env, ...GIT_ENV_OVERRIDES, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });

    assert.equal(terminal.status, 0, terminal.stderr);
    assert.equal(runs().length, 2);
    assert.deepEqual(runs()[1].filter((l) => /git hooks/.test(l)), []);
    assert.deepEqual(hooks(), before);
  });
});
