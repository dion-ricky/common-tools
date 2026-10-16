# common-tools — `opencode-multi-review` plugin

This repo hosts **`opencode-multi-review`**, a shareable [OpenCode V2 plugin](https://opencode.ai/v2/docs/build/) that runs **multiple specialized reviewers** over the current changes and returns **one consolidated markdown report**. See [Use in another repo](#use-in-another-repo) to install it outside this repo.

Instead of one generic "review my code" pass, `multi-review` fans the diff (or an explicit target / task spec) out to five reviewers, each in its own fresh session with its own specialized prompt, running concurrently:

| Reviewer id | Specialty |
| --- | --- |
| `quality` | Code quality: naming, readability, duplication, dead code, consistency with surrounding style. |
| `bugs` | Correctness: logic errors, edge cases, null/undefined handling, error handling, race conditions, off-by-one, resource leaks. |
| `spec` | Spec adherence: does the change implement what was asked — nothing more, nothing less? |
| `architecture` | Overall design: module boundaries, layering, dependency direction, coupling, testability, design-level security posture. |
| `security` | Security: injection risks (SQL/command/template), authn/authz gaps, secret/credential leakage, unsafe input handling/deserialization, risky dependency/config changes. |

Every reviewer follows a shared output contract: numbered, severity-tagged findings (`[critical]`…`[info]`) with `file:line` references, ending with a `Verdict:` paragraph.

## Entry points

### 1. `/review` command

```
/review implement the retry logic for the payment webhook
```

The command's prompt text (if any) is treated as the **task spec** for the `spec` reviewer. Without prompt text, the reviewers look at the current working diff. The consolidated report is posted back to your session as a message.

### 2. `multi_review` tool (for agents)

Ask your agent to call the tool, e.g. *"Use multi_review to check my changes against the ticket"*:

```json
{
  "reviewers": ["bugs", "spec"],
  "spec": "JIRA-1234: add idempotency keys to the checkout endpoint",
  "target": "optional explicit code/text to review; overrides the working diff"
}
```

- `reviewers` — subset of reviewer ids to run; defaults to **all five**. Unknown ids are skipped and noted in the report.
- `spec` — task/requirements text; drives the `spec` reviewer.
- `target` — explicit content to review; when omitted, the plugin reviews the **working diff** (`vcs.diff({ mode: "working" })`).
- All fields optional; if there is no diff, no `target`, and no `spec`, the tool returns a guidance message explaining that nothing to review was detected and how to provide a target or spec — no reviewers run and no error is thrown.

The tool returns the same consolidated markdown report as the command.

## Report shape

```
# Multi-Review Report
## Summary            ← synthesized executive summary (deduplicated findings)
## Code Quality (quality)
## Bugs & Correctness (bugs)
## Spec Adherence (spec)
## Architecture & Design (architecture)
## Security (security)
```

- One `##` section per reviewer, labeled with the reviewer's label.
- A reviewer that fails or times out (15-minute cap per reviewer) produces an error section — it never fails the whole run.
- When at least two reviewers complete, an extra synthesis pass (`ctx.generate.text`) deduplicates overlapping findings into the `Summary`; if synthesis fails, the report falls back to a plain completion summary.
- Diff content embedded in prompts is capped at 100,000 characters with an explicit truncation notice.

## Session behavior

- Each reviewer runs in a **fresh child session** (created with `ctx.session.create`, linked to the invoking session via `parentID`) driven by its specialized prompt — clean context, full read/grep tool access so it can explore the code, not just read the diff.
- Reviewer sessions are **kept, not removed**, so you can open them to inspect the reviewer's reasoning. Their session IDs are included in the report.
- Reviewers run concurrently (`Promise.allSettled`).

## Adding a reviewer

The reviewer list is a data-driven registry — one entry in `reviewers.ts` (repo root):

```ts
{
  id: "security",
  label: "Security",
  description: "Injection, authn/authz gaps, secret handling, unsafe deserialization.",
  buildPrompt(input) {
    return `You are the **security** reviewer. ...your specialty checklist...

${OUTPUT_CONTRACT}

${frame(input)}`
  },
},
```

That's it — the new id is immediately valid in the `multi_review` tool input, runs by default, and gets its own report section. `REVIEWER_IDS` is derived from the registry and is the single source of truth for valid ids.

## Use in another repo

This repo is a self-contained OpenCode plugin package (`opencode-multi-review`). The quickest way to install it into another project:

```bash
# reference this repo by path (stays in sync with changes here)
bash /Users/saputrad/repo/playground/common-tools/install.sh /path/to/project

# or vendor a snapshot into the target's .opencode/plugins/multi-review/
bash /Users/saputrad/repo/playground/common-tools/install.sh /path/to/project --copy
```

The installer merges the plugin into the target's `opencode.json(c)` (JSONC-aware, backs up existing config). Or configure it manually:

```jsonc
{
  "plugins": [
    { "package": "file:///Users/saputrad/repo/playground/common-tools" }
  ]
}
```

**From a git remote** (once pushed):

```jsonc
{
  "plugins": ["git+https://github.com/you/common-tools"]
}
```

**From npm** (if published):

```jsonc
{
  "plugins": ["opencode-multi-review"]
}
```

Optional per-install options (read via `ctx.options`):

```jsonc
{
  "plugins": [
    { "package": "opencode-multi-review", "options": { "reviewers": ["bugs", "security"] } }
  ]
}
```

## Development

```
# install dependencies
npm install

# typecheck (config at repo root)
npm run typecheck

# reload the plugin after code changes
opencode service restart
```

The plugin source lives at the repo root (`index.ts` + flat modules) and is published as the `opencode-multi-review` package (`exports: { ".": "./index.ts" }`). In this repo, the root `opencode.jsonc` loads it via `"plugins": ["."]`; other repos configure it explicitly as shown above.
