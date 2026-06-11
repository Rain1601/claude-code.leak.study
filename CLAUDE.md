# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is **not a runnable project**. It is a static archive of the leaked Claude Code source (extracted from an npm sourcemap, March 2026 — see `README.md` for the backstory). It contains `src/` and nothing else: no `package.json`, no `tsconfig.json`, no lockfile, no `node_modules`. Imports use `.js` extensions because the original was bundled by Bun against ESM TypeScript.

**Practical consequences:**
- Do not try to `npm install` / `npm run build` / `node dist/main.js`. The README quotes those commands aspirationally; they will fail because there is no `package.json` here. If the user asks you to "run" or "build" this, surface the constraint before attempting.
- There is no test runner, linter, or typechecker configured. Don't fabricate a command — say so.
- Treat all changes as **study/archival edits**, not production code. Refactors, comment fixes, and renames are fine; "fixes" with no way to verify them are usually not worth proposing.
- The code references runtime-only APIs like `bun:bundle` (`feature(...)`) and `@anthropic-ai/sdk` types. These won't resolve without the original build env — that's expected.

## How to navigate the code

The entrypoint is `src/main.tsx` (~785KB once you count its transitive surface). It boots the CLI via Commander.js, then hands off to an Ink (React-in-terminal) UI. Read it top-down — the early imports are deliberately ordered to fan out side effects (MDM read, keychain prefetch) in parallel with module evaluation; comments at the top explain the perf rationale.

The runtime is structured as three coupled layers, and most non-trivial questions need you to read across all three:

1. **Agent loop core** — `src/QueryEngine.ts` (driver, turn lifecycle, usage accounting) → `src/query.ts` (single LLM call, retry, streaming) → `src/Tool.ts` (the shared `Tool` shape every tool implements: input schema, render, permission gating, call). `src/tools.ts` is the central registry that decides which tools are available in a given context.

2. **Tools** — `src/tools/<ToolName>/` (one folder per tool, ~40 of them). Built-ins (`BashTool`, `FileEditTool`, `FileReadTool`, `GrepTool`, `GlobTool`, `LSPTool`, `WebFetchTool`, `WebSearchTool`, `AgentTool`, `TaskCreateTool`/`TaskUpdateTool`/etc., `SkillTool`, `TodoWriteTool`, plan-mode tools, worktree tools, MCP bridge tools). Each folder usually has `<Tool>.tsx` (definition), prompt fragments, and rendering components. Look at `src/tools/shared/` and `src/tools/utils.ts` for cross-tool helpers, and `src/tools/testing/` for harnesses.

3. **Services** — `src/services/` is the platform layer the agent loop and tools call into: `mcp/` (MCP client/transport/registry/auth), `api/` (Anthropic API client, retries, usage logging, bootstrap), `oauth/`, `analytics/` (GrowthBook), `autoDream/` (background memory consolidation subagent — the "dream" system), `compact/` (context compaction), `policyLimits/`, `remoteManagedSettings/` (enterprise MDM), `lsp/`, `plugins/`, `tips/`, `voice*`, `notifier.ts`.

Other top-level subsystems worth knowing about before grepping:

- `src/coordinator/coordinatorMode.ts` — multi-agent ("swarm") orchestration mode.
- `src/bridge/` — the remote/IDE bridge (`bridgeMain.ts`, `replBridge.ts`, `sessionRunner.ts`, JWT, trusted-device, polling). This is how Claude Code talks to remote sessions and the desktop/IDE host.
- `src/buddy/` — the "BUDDY" Tamagotchi companion system (Mulberry32 PRNG seeded by userId, 18 species, deterministic gacha).
- `src/commands/` and `src/commands.ts` — slash commands (each subdir is one command; some are React-driven dialogs).
- `src/skills/` — bundled skills loader (`bundledSkills.ts`, `loadSkillsDir.ts`, `mcpSkillBuilders.ts`).
- `src/components/` — Ink/React UI components for the REPL, dialogs, onboarding, tool render output.
- `src/entrypoints/` — CLI (`cli.tsx`), MCP server entrypoint (`mcp.ts`), SDK types (`agentSdkTypes.ts`, `sandboxTypes.ts`), and `sdk/` for the embeddable Agent SDK surface.
- `src/memdir/` — durable memory store (`MEMORY.md` loading, paths, auto-mem overrides). Wired into `QueryEngine.ts` via `loadMemoryPrompt`.
- `src/utils/` — ~329 files of cross-cutting helpers. Don't read it as a tree; grep for the specific helper.
- `src/upstreamproxy/`, `src/remote/`, `src/server/` — networking surfaces (proxy, remote agent runner, local HTTP server for IDE/bridge).
- `src/migrations/`, `src/state/`, `src/context/`, `src/context.ts` — config/state migrations and the per-session context object passed everywhere.

## Conventions inherited from the original codebase

- Internal imports use **`.js` extensions** even though sources are `.ts`/`.tsx` — preserve this when editing or referencing imports, even though it looks wrong for raw TS.
- Some imports use the **`src/...`** absolute prefix (e.g. `'src/bootstrap/state.js'`) — this came from a path alias in the original tsconfig. Don't "fix" these to relative paths; match whichever style the surrounding file already uses.
- Several files have a `// eslint-disable-next-line custom-rules/no-top-level-side-effects` comment guarding deliberate top-level side effects (perf-critical prefetches in `main.tsx`). Leave these alone — removing the side effect would break the ordering the comments above describe.
- Tools follow a uniform shape — when adding to or comparing across tools, mirror the pattern of an existing tool folder rather than improvising.

## Working with the user here

The README frames this as a study/archive repo. When the user asks about Claude Code internals, the answer is almost always "read the leaked source in `src/`" — prefer pointing at file:line and quoting the actual code over describing it from memory. The "Tengu" / "Capybara" / undercover-mode references in the README are real (`src/utils/undercover.ts` exists); the autoDream and BUDDY systems are real (`src/services/autoDream/`, `src/buddy/`). Verify any specific claim against the file before stating it as fact.
