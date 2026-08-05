# agentdef

**Define an AI agent once. Generate the config every tool expects.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![format-drift watch](https://github.com/noord-agency/agentdef/actions/workflows/format-watch.yml/badge.svg)](https://github.com/noord-agency/agentdef/actions/workflows/format-watch.yml)

_A clean-room reimplementation built on the design of [open-gitagent](https://github.com/open-gitagent/gitagent) (MIT), scoped to the two instruction formats that matter in practice and extended with a format-drift watcher._

agentdef turns one agent definition into the instruction file each AI coding tool reads, so your agent's identity, rules, and skills stay consistent across every tool, and you are never locked into a single vendor.

```bash
npm install -g @noord-agency/agentdef

agentdef adapters set claude-code cursor   # once per machine: choose your tools
agentdef init                              # once per repo: install hooks + first sync
```

## The idea

Write your agent once:

```
agent.yaml      name, description, model, extends
SOUL.md         identity, voice, persona
RULES.md        constraints and operating rules
skills/         one folder per skill, each with a SKILL.md
knowledge/      optional knowledge docs (OKF frontmatter), indexed, never copied
```

agentdef generates whatever each tool reads from that single source. No parallel copies to maintain, no drift between tools.

The generated files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/`) are build artifacts: gitignore them, never hand-edit them (the next sync overwrites them), and edit the sources above instead. They're outputs, not sources, AGENTS.md included.

## Supported tools

agentdef generates configs by tool name. Set the name of the tool you actually use, in `.agent-adapters` or via `agentdef adapters set <tool>`:

| Adapter | Instruction file | Skills dir |
|---|---|---|
| `claude-code` (alias `claude`) | `CLAUDE.md` | `.claude/skills/` |
| `codex` | `AGENTS.md` | `.agents/skills/` |
| `opencode` | `AGENTS.md` | `.opencode/skills/` |
| `antigravity` | `AGENTS.md` | `.agents/skills/` |
| `kiro` | `AGENTS.md` | `.kiro/skills/` |
| `copilot` | `.github/copilot-instructions.md` | `.github/skills/` |
| `cursor` | `.cursor/rules/*.mdc` | `.cursor/skills/` |
| `gemini` | `GEMINI.md` | `.gemini/skills/` |
| `agents` | `AGENTS.md` | `.agents/skills/` |

The instruction file is often shared, AGENTS.md is one standard that codex, opencode, antigravity and kiro all read, but the skills dir is tool-specific, so `opencode` and `kiro` place skills where those tools look rather than in `.agents/skills/`. That is why you set the real tool name, not a generic one. `agents` is the vendor-neutral baseline (AGENTS.md + `.agents/skills/`); `codex` and `antigravity` produce exactly that. GitHub Copilot is the one tool that does not read AGENTS.md for its repo instructions, so it gets its native `.github/copilot-instructions.md`.

The same names work with `agentdef export --format <name>` (plus extra AGENTS.md aliases like `kimi`, `grok`, `windsurf`, `zed`, `aider`).

If the repo has a `knowledge/` folder (see [Knowledge](#knowledge)), each adapter also surfaces its index: `claude-code` and `gemini` via a SessionStart hook (always fresh), the AGENTS.md family and `copilot` as a static `## Knowledge` section in their instruction file, and `cursor` as an always-applied `.cursor/rules/knowledge-index.mdc`. `agentdef adapters list` shows which mode each adapter uses.

## Why only two formats

The AI-coding ecosystem converged on essentially two instruction-file formats: **AGENTS.md** (now a standard read by 30+ tools) and **CLAUDE.md**. Define once, run in any tool, switch freely. Even the model-lab CLIs (Kimi, Grok) and models reached through other harnesses (GLM) read these same files rather than inventing their own. That convergence is why agentdef can stay small and still cover the field.

## Skills

Skills are the other half of the standard. A skill is a folder with a `SKILL.md` (YAML frontmatter + instructions); the format is shared across tools, so skills are copied, not translated.

You author skills once in `skills/`. Tools never read that folder directly, `agentdef sync` mirrors it into each tool's skills dir (the right-hand column of the table above: `.claude/skills/`, `.agents/skills/`, `.opencode/skills/`, and so on).

`.agents/skills/` is the shared standard for the AGENTS.md family; the others are tool-specific. There is no single root skills folder that every tool reads; `skills/` is the source, the `.[tool]/skills/` dirs are generated. Every instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) indexes skills with metadata + a pointer to each `SKILL.md`, rather than inlining them. The tools load each skill on demand from their own skills dir (the Agent Skills standard), so inlining would only duplicate the content and bloat the file.

## Knowledge

A repo can carry an optional `knowledge/` folder: markdown documents in Google's [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) (OKF, Apache-2.0). agentdef reads only the YAML frontmatter, so bundles stay OKF-portable; document bodies can be anything.

```markdown
---
type: BigQuery Table        # required; free-form, agentdef never interprets it
title: Orders               # optional; defaults to the filename
description: One row per order.
tags: [sales, revenue]
timestamp: 2026-05-28T14:30:00Z
resource: https://console.cloud.google.com/bigquery?t=orders
---
```

Per the OKF spec, only `type` is required (a missing one fails `validate`/`sync` loudly); every other field is optional, unknown keys are tolerated, `type` values are yours to choose (dataset, metric, api, runbook, concept, ...). `index.md` and `log.md` are OKF-reserved names and skipped at every level. Folders nest freely; discovery is recursive. Rename the folder with `knowledge: { dir: ... }` in `agent.yaml` (then re-run `agentdef init` so the git hooks watch the new name).

Unlike skills, knowledge is **indexed, never mirrored**: each tool gets a compact index (type, title, description, pointer) and loads the full document on demand from its real path. Inherited docs (via `extends`) point into the regenerated `.agentdef/` cache; on a path collision the nearest definition wins, like skills. How the index reaches each tool:

- **`claude-code`, `gemini` (hook mode):** `sync` registers a SessionStart hook in `.claude/settings.json` / `.gemini/settings.json` (append-only and idempotent, your other settings are untouched; if the file is not plain JSON, sync warns with a snippet to merge manually). The hook runs `agentdef knowledge hook <tool>`, which renders the index live at every session start, so local edits and pulled parent changes surface without a re-sync. The instruction file carries a breadcrumb instead of the index. On machines without agentdef the hook is a silent no-op. To opt out of hook mode, set `knowledge: { hook: false }` in `agent.yaml` (the instruction files then carry the full static index) and run `agentdef knowledge unhook <claude|gemini>` to remove an already registered entry; a stale entry left behind after deleting `knowledge/` is harmless.
- **Everyone else (static mode):** the full `## Knowledge` section lands in the instruction file (`AGENTS.md`, `.github/copilot-instructions.md`) or, for Cursor, in an always-applied `.cursor/rules/knowledge-index.mdc`; refreshed on every sync, and the git hooks re-sync when a pull touches `knowledge/`.

A repo without `knowledge/` behaves exactly as before: no section, no hook, no settings file.

### Keeping child repos fresh

Inherited knowledge refreshes on every sync (a cheap SHA check re-clones a parent only when its HEAD moved). Developers get that on their next pull via the git hooks. If a parent's knowledge must propagate to child repos *immediately*, wire it in CI. This is a pattern, not something agentdef generates: the parent repo runs a workflow on pushes touching `knowledge/**` that notifies each child (`gh api repos/ORG/CHILD/dispatches -f event_type=agentdef-parent-updated`); each child runs a `repository_dispatch` workflow that checks out, runs `agentdef sync`, and commits if changed. Teams without cross-repo tokens simply rely on the pull-time hooks.

## Commands

```bash
agentdef init         # install git hooks + run the first sync (one-time per repo; --no-sync to skip)
agentdef sync         # generate every adapter in .agent-adapters + mirror skills/agents
                      # (--force re-clones the extends chain even when unchanged)
agentdef adapters     # show which tools sync will generate for, and from where
agentdef adapters list                      # list every known adapter + what it emits
agentdef adapters set [--local] <tool>...   # set the machine default (or, with --local, this repo)
agentdef export --format <claude-code|agents|gemini|cursor> [--dir .] [--out FILE]
agentdef install      # resolve the full `extends:` chain into .agentdef/parent
agentdef validate     # check the definition (fail-loud); enforces provider:model
agentdef watch        # detect upstream format drift
agentdef knowledge hook <claude|gemini>     # print the live knowledge index (used by the SessionStart hooks)
agentdef knowledge unhook <claude|gemini>   # remove the registered SessionStart hook again
```

Status goes to stderr and only generated content to stdout, so `agentdef export -f claude-code > CLAUDE.md` is clean.

Every command takes `--help` (and `--dir` to point at an agent directory other than the current one); `agentdef help <command>` prints the same thing. A flag a command does not declare is refused with exit 1 before anything runs, rather than ignored: a dropped `-dir` would have left `sync` regenerating the directory you happened to be standing in and still exiting 0.

## Choosing your tools (`.agent-adapters`)

`.agent-adapters` lists which tools `sync` generates for, one per line (blank lines and `# ...` comments ignored). It answers "which AI tool does *this developer* use", a personal, per-machine fact, not part of the agent definition, so it is gitignored and never flows through `extends`.

To avoid re-declaring it in every repo, `sync` resolves the adapter list in this order:

1. `--adapters a,b,c` on the command line, else
2. the per-repo `.agent-adapters` file (if it lists at least one tool), else
3. a **machine-level default**: `$AGENTDEF_ADAPTERS_FILE`, else `$XDG_CONFIG_HOME/agentdef/adapters`, else `~/.config/agentdef/adapters`.

So set your tools once per machine:

```bash
agentdef adapters set claude-code cursor   # writes ~/.config/agentdef/adapters
```

and every repo works with no per-repo setup. For a repo that should differ, `agentdef adapters set --local gemini` writes that repo's `.agent-adapters`, which wins. `agentdef adapters` shows the resolved list and which source it came from. If none of the three yields a tool, `sync` fails loudly telling you where to set one.

## Inheritance

A repo can inherit a shared agent definition:

```yaml
# agent.yaml
extends: https://github.com/your-org/base-agent.git
```

`extends` resolves recursively: if the parent has its own `extends`, the grandparent resolves too, and so on up the chain. So `texte` → `we-site` → `noord` materializes the whole ancestry in one `sync`, always current. A cycle (a repo that transitively extends itself) fails loudly.

`agentdef install` clones each ancestor one level deeper under `.agentdef/parent` (a regenerable cache; `agentdef init` adds it to `.gitignore`, and migrates a repo off the old `.gitagent/` name by untracking and deleting it, so existing projects just re-run `agentdef init` and commit). On generation, nearer wins: `SOUL.md` is taken from the closest ancestor that defines one (local over parent over grandparent), `RULES.md` is the union (furthest ancestor first, local last), and skills merge with the nearest definition winning on name collision, so a local skill still overrides every inherited one.

### Trimming what consumers fetch (`include`)

By default a consumer clones the **whole** base repo into `.agentdef/parent`, not just the parts agentdef reads. That is usually fine, but a base repo that also keeps internal docs, exports or test fixtures next to its agent definition may not want all of it landing in every consuming project.

A base repo opts into a leaner clone by listing the extra directories in its **own** `agent.yaml`:

```yaml
# the BASE repo's agent.yaml, not the consumer's
name: my-base-agent
description: ...
include:
  - tools/my-cli
```

- **No `include:` key** (the default): full clone, exactly as before. Nothing changes for any repo that does not opt in.
- **`include: [<paths>]`**: consumers fetch the root files, `skills/`, `agents/`, the knowledge dir, and the listed paths.
- **`include: []`**: the essentials only.

The base repo declares this rather than the consumer, because it is the side that knows the layout and when it changes. `skills/`, `agents/` and the knowledge dir are always fetched since agentdef reads them for every consumer, so `include:` can only add, never remove. Every file at the repository **root** always arrives too (`agent.yaml`, `SOUL.md`, `RULES.md`), which is why the list only ever names subdirectories.

**One sharp edge.** Cone mode cannot select a subdirectory without also selecting its parents, and a selected parent brings the files sitting directly in it. So `include: [tools/runtime]` also ships everything loose in `tools/`, though not `tools/anything-else/`. If `tools/` holds something you do not want downstream, move it or list a path with no loose siblings. `agentdef validate` warns with the file count when it sees this.

**What this is and is not.** It uses a git partial clone (`--filter=blob:none`) with sparse-checkout, so the *contents* of unlisted directories are genuinely never fetched: they do not land in any consumer's working tree, editor index, grep results or backups. It is not an access control. `--filter=blob:none` filters blobs and never trees, so the full list of file *paths* is still cloned and readable offline, and any consumer with read access to the base repo can pull the contents on demand with a single `git sparse-checkout disable`. Treat it as fetch and disk hygiene. Anything genuinely confidential belongs in a separate repo.

Two further limits worth knowing. A consumer already sitting on a materialized cache does not lose anything when `include:` is added later, because the cache is kept until the parent's `HEAD` moves. And local (filesystem path) parents are plain copies with no fetch to filter, so `include:` does not apply to them.

Partial clone needs git 2.37+ (where `sparse-checkout set` defaults to cone mode) and a remote that supports fetch filtering (GitHub, GitLab and Bitbucket do). Older git falls back to the full clone agentdef has always done, and says so in a warning if the parent declared `include:`. `agentdef validate` checks the list in the repo that declares it, since a mistake there would otherwise only ever surface on the consumers.

## Format-drift watcher

Tools occasionally change their config format. `agentdef watch` fingerprints each tool's published format and compares it to a stored baseline. Deterministic, no LLM, no API key. It exits non-zero when something changes, so CI can open an issue and a human can update the affected adapter. See [`.github/workflows/format-watch.yml`](.github/workflows/format-watch.yml).

## Models

Models are a config value, not an emission target. Set `model: provider:model` in `agent.yaml` (for example `anthropic:claude-opus-4-7`, `zhipu:glm-4.6`, `moonshot:kimi-k2`); `validate` enforces the `provider:model` form. The endpoint and credentials for a given model live in your own machine config, never generated by agentdef.

## Credits

`include:` was designed and prototyped by [Michael Marconi](https://github.com/michaelmarconi) in [#1](https://github.com/noord-agency/agentdef/pull/1), including the observation that makes it workable: a partial clone fetches the commit and tree objects plus every root file eagerly and defers only subdirectory blobs, so a base repo's `agent.yaml` is already readable when the clone returns. That is what lets the selection happen at fetch time rather than as a hidden working tree.

## License

MIT, see [LICENSE](LICENSE). Built and maintained by noord.
