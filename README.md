# opencode-lessons

Keep the lesson. Skip the transcript.

A small OpenCode V2 plugin that proposes scoped, evidence-backed lessons, searches project Markdown memory, and retrieves relevant lessons during work. Durable memory lives in your repository, not in a client database. Works alongside oh-my-opencode-slim without depending on its internals.

## Install

Requires Node.js 22+ and the OpenCode V2 plugin API (`tool.transform`, `command.transform`, `session.hook` and `session.get`). The packed plugin is tested in a real OpenCode 2.0.22 server and agent loop, using a deterministic local provider fixture. This verifies integration without a provider account; live remote model behavior and the interactive TUI are not covered.

In `.opencode/opencode.json`:

```json
{
  "plugins": [
    "oh-my-opencode-slim@latest",
    {
      "package": "github:vmvarela/opencode-lessons#master",
      "options": {
        "directory": "memory",
        "autoRecall": true,
        "contextBudget": 4000
      }
    }
  ]
}
```

For reproducibility, replace `master` with the full reviewed commit hash. The plugin does not require Slim; omit its entry if you do not use it. Place Lessons after plugins that rewrite model context. It never changes agents, models, MCP connections or approval settings. Do not load it both explicitly and through auto-discovery.

For local development, configure an absolute path to this checkout directory. Configured local plugins must be directories; the root `index.js` forwards to the implementation. Relative plugin paths resolve from the configuration file, not the shell's current directory. No build step, SDK download or runtime dependency is required. This package is not published to npm yet.

Restart/reload OpenCode and check that the commands below appear. If loading fails, inspect OpenCode's plugin status and logs; do not paste credential-bearing resolved configuration. V1 is intentionally unsupported.

## Use

1. Work normally. The plugin adds a short reminder to search prior experience and propose only useful, evidenced lessons. It does not observe or archive every tool call.
2. Run `/learn` after a task containing a reusable correction or verified workaround. The active agent uses the existing session context to propose at most three lessons; this command requests an ordinary model turn, not a background observer.
3. Review the diff, evidence, scope and related entries returned by `lessons_propose`.
4. Run `/learn-accept <proposal-id>` yourself to save the exact preview. Alternatively use `/learn-dismiss <proposal-id>`. Proposals belong to the root session tree, so you can accept a Slim specialist's proposal from its parent session. An unrelated root session cannot accept it. Proposals expire after an hour or plugin reload and are never persisted before acceptance.
5. Review the Git diff and commit through your normal branch/PR workflow. Other machines receive accepted memory only after the appropriate merge and pull.

| Command | Behavior |
| --- | --- |
| `/learn` | Ask the active agent for useful lessons from this task |
| `/learn-search <query>` | Ask the agent to search relevant project lessons |
| `/learn-review` | Ask the agent to inspect lexical duplicates and obsolete entries |
| `/learn-promote <lesson-id>` | Prepare review steps toward an existing policy or skill |
| `/learn-accept <proposal-id>` | Save the exact displayed preview locally, without a model call |
| `/learn-dismiss <proposal-id>` | Discard a preview, without a model call |

Read-only tools available to agents: `lessons_search`, `lessons_propose`, `lessons_review`, `lessons_promote`. OpenCode may expose these through its Code Mode catalog; follow the host's tool catalog to invoke them. There is deliberately no agent tool for accepting a proposal. A direct user command is the save boundary; this is not protection against an untrusted plugin or an agent already authorized to execute arbitrary shell commands. Acceptance and dismissal record a synthetic result with `resume: false`, so they do not restart the model.

## Memory format

Accepted lessons go into `memory/lessons/<title>-<id>.md`. Each file is readable Markdown with a small frontmatter:

```markdown
---
opencode_lessons: 1
id: "d564fb84-1905-44dd-a61c-64e6111e0f93"
date: "2026-10-04"
evidence_type: "user-correction"
state: "recorded"
tags: ["terraform"]
---

# Terraform owns branch protection

## Trigger

When changing repository rulesets.

## Action

Edit the declared Terraform source instead of using direct API writes.

## Scope

PrisaMedia workspace; not a policy for personal repositories.

## Evidence

Explicit user correction dated 2026-10-04, with the relevant review reference.

## Limits

Verify the current source of truth before changing it.
```

Required fields: title, trigger, action, scope, evidence, limits and `evidenceType` (`user-correction` or `verified-observation`). An agent-supplied label is not independent verification; review its actual evidence. Assumptions, silence and repeated guesses do not establish correctness.

The plugin also searches existing `.md` memory under the configured directory, using `##`/`###` section boundaries. It ignores template headings, fenced example headings, `README.md`, hidden directories and symlinks. Existing files such as `devops-lessons.md` and `known-errors.md` are read-only to the plugin and never migrated. JSON frontmatter scalars in managed files must remain valid; do not add Markdown heading delimiters inside their section content.

Managed states: `recorded`, `proposed`, `incorporated`, `superseded`. Superseded managed entries and legacy entries whose **Status:** is `obsolete`/`superseded` are excluded from recall. State changes and updates to existing lessons are reviewed Markdown edits in this MVP, not automatic rewrites. Duplicate title + scope prevents a new managed entry; similar legacy entries are shown for comparison.

## Retrieval and scope

Search ranks token matches, weighting titles more heavily. It uses no embeddings, remote index or additional model call. Automatic recall searches the latest user message and injects up to three results as explicitly untrusted, scoped evidence. The active agent can search more precisely with `lessons_search`.

`contextBudget` is a snippet-character budget (1000–12000; default 4000), not an exact provider-token limit. IDs, paths and JSON framing add overhead. The policy reminder is always present; `autoRecall: false` disables automatic searches while retaining the tools.

Reads are bounded to 500 Markdown files, 256 KiB per file and three nested directory levels. Oversized or malformed managed files produce coverage warnings. No hit is not proof that no lesson exists. Semantic contradictions and obsolescence require human/model review; lexical duplicate hints are not semantic detection.

Sessions must match this plugin instance's exact real project directory, including subagent sessions. A sibling repository or worktree does not silently share memory; use Git to share deliberately. This plugin writes no durable OpenCode storage and creates no parallel Engram memory.

## Writes and privacy

- Preview does not create directories or files. Acceptance creates missing memory directories and writes one new file exclusively, using a temporary file and an atomic no-overwrite hard link.
- A short-lived `memory/.opencode-lessons-lock` directory serializes local acceptance across processes. A concurrent acceptance can ask you to retry. If a process crashes, inspect the workspace and ensure no writer is running before removing a leftover lock. No automatic stale-lock deletion occurs.
- No commit, push, PR creation, policy adoption or skill installation occurs. Keep `memory/` tracked by Git. You may ignore `memory/.opencode-lessons-lock/` and `memory/lessons/*.tmp` for interrupted writes.
- Common credential patterns are rejected in proposals and redacted in legacy recall. This is a heuristic, not a secret scanner or DLP guarantee; review every diff. Unknown credentials and sensitive prose can still pass. Selected memory is sent to the model already handling your task.
- Filesystem checks reject symlinked paths and existing hardlinked files. They are not a sandbox against a hostile process racing directory replacement.

## Development

```bash
npm run verify
npm pack
```

Tests use Node's built-in runner and temporary directories. They cover storage round trips, legacy retrieval, duplicate detection, exact-preview acceptance, concurrent writers, linked-path rejection, credential heuristics, context bounds and a V2 host-contract harness.

Run the separate Linux runtime test with an installed OpenCode V2 executable:

```bash
OPENCODE_SMOKE_CLI=/absolute/path/to/opencode npm run test:runtime
```

The runtime test packs and extracts the distribution, starts an isolated OpenCode server with temporary XDG directories, and serves deterministic model responses over localhost. It checks command registration, Code Mode tool execution, read-only preview, exact acceptance without another model request, and automatic recall as untrusted evidence. No real provider key is used. It requires `npm` and `tar`; CI pins OpenCode 2.0.22 on Linux. Compatibility with Slim's child-session proposal flow is covered separately by the contract harness, not by a full Slim runtime test.

## MVP boundaries

No automatic idle-triggered extraction, numeric confidence, transcript database, global memory, semantic search or automatic policy promotion. `/learn-promote` returns a review plan and source lesson, not an adopted skill. Updates to existing entries remain normal reviewed file edits. Scope and review are more useful than automatically accumulating more memory.

References: [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins), [plugin configuration](https://opencode.ai/v2/docs/plugins/), [ECC Continuous Learning v2](https://github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md). Inspired by ECC's atomic, scoped lessons; no ECC code or runtime dependency is included.
