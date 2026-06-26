# agentdef

**Define an AI agent once. Generate the config every tool expects.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![format-drift watch](https://github.com/noord-agency/agentdef/actions/workflows/format-watch.yml/badge.svg)](https://github.com/noord-agency/agentdef/actions/workflows/format-watch.yml)

_A clean-room reimplementation built on the design of [open-gitagent](https://github.com/open-gitagent/gitagent) (MIT), scoped to the two instruction formats that matter in practice and extended with a format-drift watcher._

agentdef turns one agent definition into the instruction file each AI coding tool reads, so your agent's identity, rules, and skills stay consistent across every tool, and you are never locked into a single vendor.

```bash
npm install -g @noord-agency/agentdef

agentdef init     # install git hooks: regenerate on pull/merge/checkout
agentdef sync     # generate configs for the tools in .agent-adapters
```

## The idea

Write your agent once:

```
agent.yaml      name, description, model, extends
SOUL.md         identity, voice, persona
RULES.md        constraints and operating rules
skills/         one folder per skill, each with a SKILL.md
```

agentdef generates whatever each tool reads from that single source. No parallel copies to maintain, no drift between tools.

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

## Why only two formats

The AI-coding ecosystem converged on essentially two instruction-file formats: **AGENTS.md** (now a standard read by 30+ tools) and **CLAUDE.md**. Define once, run in any tool, switch freely. Even the model-lab CLIs (Kimi, Grok) and models reached through other harnesses (GLM) read these same files rather than inventing their own. That convergence is why agentdef can stay small and still cover the field.

## Skills

Skills are the other half of the standard. A skill is a folder with a `SKILL.md` (YAML frontmatter + instructions); the format is shared across tools, so skills are copied, not translated.

You author skills once in `skills/`. Tools never read that folder directly, `agentdef sync` mirrors it into each tool's skills dir (the right-hand column of the table above: `.claude/skills/`, `.agents/skills/`, `.opencode/skills/`, and so on).

`.agents/skills/` is the shared standard for the AGENTS.md family; the others are tool-specific. There is no single root skills folder that every tool reads; `skills/` is the source, the `.[tool]/skills/` dirs are generated. In the instruction file, `CLAUDE.md` indexes skills with a pointer (Claude Code loads each on demand) while `AGENTS.md` and `GEMINI.md` inline them in full.

## Commands

```bash
agentdef init         # install git hooks that run sync on pull/merge/checkout/rebase
agentdef sync         # generate every adapter in .agent-adapters + mirror skills/agents
agentdef adapters     # show which tools sync will generate for, and from where
agentdef adapters set [--local] <tool>...   # set the machine default (or, with --local, this repo)
agentdef export --format <claude-code|agents|gemini|cursor> [--dir .] [--out FILE]
agentdef install      # resolve the full `extends:` chain into .agentdef/parent
agentdef validate     # check the definition (fail-loud); enforces provider:model
agentdef watch        # detect upstream format drift
```

Status goes to stderr and only generated content to stdout, so `agentdef export -f claude-code > CLAUDE.md` is clean.

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

## Format-drift watcher

Tools occasionally change their config format. `agentdef watch` fingerprints each tool's published format and compares it to a stored baseline. Deterministic, no LLM, no API key. It exits non-zero when something changes, so CI can open an issue and a human can update the affected adapter. See [`.github/workflows/format-watch.yml`](.github/workflows/format-watch.yml).

## Models

Models are a config value, not an emission target. Set `model: provider:model` in `agent.yaml` (for example `anthropic:claude-opus-4-7`, `zhipu:glm-4.6`, `moonshot:kimi-k2`); `validate` enforces the `provider:model` form. The endpoint and credentials for a given model live in your own machine config, never generated by agentdef.

## License

MIT, see [LICENSE](LICENSE). Built and maintained by noord.
