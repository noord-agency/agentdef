# agentdef

> Built on the design of [open-gitagent](https://github.com/open-gitagent/gitagent) (MIT). agentdef is a clean-room reimplementation, scoped to the two instruction formats that matter and extended with a format-drift watcher. Licensed MIT.

Define an AI agent once, generate the config every tool expects.

`agentdef` takes one definition (`agent.yaml` + `SOUL.md` + `RULES.md` + `skills/`) and generates the instruction file each AI coding tool reads:

- `CLAUDE.md` for Claude Code
- `AGENTS.md` for Codex, Cursor, Kimi, Grok, Antigravity, Windsurf, Zed, Aider, and the rest of the AGENTS.md standard
- `GEMINI.md` for Gemini CLI
- `.cursor/rules/*.mdc` for Cursor's native rules

Plus `extends`-based inheritance across repos, and a deterministic watcher that flags when a tool changes its format.

## Why only two formats

The AI-coding ecosystem converged on essentially two instruction-file formats: **AGENTS.md** (a standard read by 30+ tools) and **CLAUDE.md**. Define once, run in any tool, switch freely, no single-vendor lock-in. Model-lab CLIs (Kimi, Grok) and models accessed through other harnesses (GLM) read these same files rather than inventing their own.

## Install

```bash
npm install -g agentdef
```

## Usage

```bash
agentdef export --format claude-code     # -> CLAUDE.md
agentdef export --format agents          # -> AGENTS.md (alias: kimi, grok, codex, ...)
agentdef export --format gemini          # -> GEMINI.md
agentdef export --format cursor          # -> .cursor/rules/*.mdc
agentdef install                         # resolve `extends:` parents
agentdef validate                        # check the definition (fail-loud)
agentdef watch                           # detect upstream format drift
```

## Format-drift watcher

`agentdef watch` fingerprints each tool's published format and compares it to a stored baseline. Deterministic, no LLM, no API key. On drift it exits non-zero so CI can open an issue; the adapter fix is reviewed by a human (see `.github/workflows/format-watch.yml`).

## License

MIT. See [LICENSE](LICENSE).
