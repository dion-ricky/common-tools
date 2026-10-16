/**
 * Data-driven registry of specialized reviewers.
 *
 * Adding a new reviewer requires only one new entry in `REVIEWERS` below.
 * `REVIEWER_IDS` is the single source of truth for valid reviewer ids.
 */

/** Input every reviewer prompt is built from. */
export interface ReviewInput {
  /** Resolved review content (working diff or explicit target), already capped by the runner. */
  content?: string
  /** Where the content came from, for framing inside the prompt. */
  contentSource?: "diff" | "target"
  /** The task/prompt text the change is supposed to implement (spec-adherence input). */
  spec?: string
}

export interface Reviewer {
  /** Stable id used in the `multi_review` tool input and report sections. */
  readonly id: string
  /** Human-readable label used as the report section heading. */
  readonly label: string
  /** One-line description of the reviewer's specialty. */
  readonly description: string
  /** Builds the full specialized prompt for this reviewer. */
  readonly buildPrompt: (input: ReviewInput) => string
}

/**
 * Shared output contract appended to every reviewer prompt so the consolidated
 * report has a predictable shape: severity-tagged findings with file:line
 * references, then a one-paragraph verdict.
 */
const OUTPUT_CONTRACT = `
## Output format

Respond with:

1. Numbered findings, most severe first. Each finding starts with a severity tag:
   [critical], [high], [medium], [low], or [info].
2. Every finding that relates to code MUST include a file:line reference
   (e.g. \`src/app.ts:42\`). Use the actual paths and line numbers you can verify
   with your tools; do not invent references.
3. Keep each finding to 1-4 sentences: what is wrong, why it matters, and —
   when obvious — how to fix it.
4. End with a final paragraph starting with \`Verdict:\` summarizing your overall
   assessment in at most 5 sentences.
`.trim()

function frame(input: ReviewInput): string {
  const parts: string[] = []
  if (input.spec && input.spec.trim()) {
    parts.push(`## Task / spec under review\n\n${input.spec.trim()}`)
  }
  if (input.content && input.content.trim()) {
    const header =
      input.contentSource === "target"
        ? "## Content under review\n"
        : "## Working-tree diff under review\n"
    parts.push(`${header}\n${input.content.trim()}`)
  } else {
    parts.push(
      "No diff or explicit content was provided. Base your review on the task/spec above and use your tools (read, grep, glob) to explore the repository yourself.",
    )
  }
  return parts.join("\n\n")
}

export const REVIEWERS: Reviewer[] = [
  {
    id: "quality",
    label: "Code Quality",
    description:
      "Naming, readability, duplication, dead code, and consistency with the surrounding code's style and idioms.",
    buildPrompt(input) {
      return `You are the **code quality** reviewer. Your specialty is how the code is written, not what it does.

Look for:

- Unclear or misleading names (variables, functions, types, files).
- Readability problems: overly dense logic, deep nesting, unclear control flow.
- Duplication that should be factored out; near-duplicate logic.
- Dead code: unused exports, unreachable branches, leftover debug statements, commented-out code.
- Inconsistencies with the surrounding codebase's established style, patterns, and idioms.

Ignore correctness issues unless they are also quality issues — another reviewer covers bugs.

${OUTPUT_CONTRACT}

${frame(input)}`
    },
  },
  {
    id: "bugs",
    label: "Bugs & Correctness",
    description:
      "Logic errors, edge cases, null/undefined handling, error handling, race conditions, off-by-one errors, and resource leaks.",
    buildPrompt(input) {
      return `You are the **bugs & correctness** reviewer. Your specialty is whether the code actually behaves correctly.

Look for:

- Logic errors and incorrect conditions (including inverted or over-broad boolean logic).
- Unhandled edge cases: empty inputs, empty collections, boundary values, unexpected formats.
- Null/undefined (or nil/None) handling: possible dereferences of optional values, missing guards.
- Error handling: swallowed errors, missing error paths, wrong error types, unhandled promise rejections.
- Concurrency problems: race conditions, missing synchronization, unsafe shared state.
- Off-by-one errors in loops, indices, slices, and ranges.
- Resource leaks: unclosed handles, listeners, connections, or subscriptions.

Do not comment on style or architecture — other reviewers cover those.

${OUTPUT_CONTRACT}

${frame(input)}`
    },
  },
  {
    id: "spec",
    label: "Spec Adherence",
    description:
      "Whether the change actually implements what was asked — nothing more, nothing less — and matches the stated requirements.",
    buildPrompt(input) {
      return `You are the **spec adherence** reviewer. Your specialty is whether the change does what it was asked to do.

Look for:

- Requirements in the task/spec that are implemented incorrectly or incompletely.
- Requirements that are missing entirely.
- Scope creep: behavior, files, or refactors that were NOT requested.
- Silently changed behavior outside the task's intent.
- Misinterpreted or ambiguous requirements implemented in a way the requester likely did not mean.
- Stated acceptance criteria (explicit or implied) that the change would fail.

If no task/spec was provided, say so explicitly in your verdict and review only for obvious scope or intent problems you can infer from the change itself.

${OUTPUT_CONTRACT}

${frame(input)}`
    },
  },
  {
    id: "architecture",
    label: "Architecture & Design",
    description:
      "Module boundaries, layering, dependency direction, coupling, testability, and design-level security posture.",
    buildPrompt(input) {
      return `You are the **architecture & design** reviewer. Your specialty is the structural health of the change.

Look for:

- Blurred module boundaries: features reaching into other modules' internals.
- Layering violations: lower layers depending on higher ones, or UI/business/domain logic leaking across layers.
- Dependency direction problems: cycles, dependencies on volatile or implementation-detail modules.
- Coupling: changes that make future changes harder (hidden coupling, duplicated knowledge, shotgun-surgery patterns).
- Testability: logic that cannot be tested in isolation, hard-coded environment assumptions.
- Design-level security posture: trust-boundary placement, privilege or data-exposure concerns baked into the design (not individual input-validation bugs).

Do not report line-level bugs — another reviewer covers correctness.

${OUTPUT_CONTRACT}

${frame(input)}`
    },
  },
  {
    id: "security",
    label: "Security",
    description:
      "Injection risks (SQL/command/template), authentication & authorization gaps, secret/credential leakage, unsafe input handling and deserialization, and risky dependency/config changes.",
    buildPrompt(input) {
      return `You are the **security** reviewer. Your specialty is concrete, line-level security risks in the change.

Look for:

- Injection risks: SQL, OS/command, and template/template-engine injection (e.g. string-built queries, \`exec\`/\`eval\`, unescaped templating) and other injection sinks.
- Authentication & authorization gaps: missing auth checks, broken access control, privilege escalation, IDOR-style direct object references, permissive defaults.
- Secret/credential leakage: hardcoded API keys, tokens, passwords, private keys, or secrets newly added to code/config/diffs; secrets logged or embedded in error messages.
- Unsafe input handling and deserialization: unvalidated/un-sanitized external input, unsafe deserialization of untrusted data, path traversal, unsafe file/upload handling.
- Risky dependency/config changes: new dependencies without justification, downgraded/pinned-vulnerable versions, loosened TLS/CORS/CSP/permission settings, debug endpoints enabled.

Do not report generic style or correctness issues — other reviewers cover those. Design-level security posture (trust boundaries baked into the architecture) remains with the architecture reviewer; you focus on concrete, line-level security issues.

${OUTPUT_CONTRACT}

${frame(input)}`
    },
  },
]

/** All valid reviewer ids — the single source of truth for id validation. */
export const REVIEWER_IDS: string[] = REVIEWERS.map((reviewer) => reviewer.id)

export function getReviewer(id: string): Reviewer | undefined {
  return REVIEWERS.find((reviewer) => reviewer.id === id)
}
