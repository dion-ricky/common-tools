import type { Plugin } from "@opencode/plugin"
import { getReviewer, REVIEWER_IDS, REVIEWERS, type ReviewInput } from "./reviewers"

/**
 * Verified against the installed `@opencode/plugin` 2.x type declarations:
 * - `ctx.session.create(input)` accepts `{ title, parentID }` (`SessionCreateInput`);
 *   `parentID` links the reviewer session to the invoking session.
 * - `ctx.session.prompt({ sessionID, text })`, `ctx.session.wait({ sessionID })`,
 *   `ctx.session.context({ sessionID })` (returns `SessionMessageInfo[]`).
 * - Assistant messages carry `content: Array<{ type: "text", text } | reasoning | tool>`,
 *   so the final review text is the concatenated `type: "text"` parts of the last
 *   assistant message.
 * - `ctx.vcs.diff({ mode: "working", context: 3 })` returns
 *   `{ location, data: FileDiffInfo[] }` where `FileDiffInfo` is
 *   `{ file, patch, additions, deletions, status }` — NOT a raw string, so the
 *   diff text is assembled here.
 * - `ctx.generate.text({ prompt })` returns `{ text }`.
 */

/** Maximum characters of diff content embedded in a reviewer prompt. */
const DIFF_CHAR_CAP = 100_000

/** Per-reviewer wall-clock timeout. */
const REVIEWER_TIMEOUT_MS = 15 * 60 * 1000

export class ReviewContentError extends Error {}

/**
 * Thrown when there is no explicit target/spec AND no working diff — i.e.
 * nothing to review at all. Distinct from other `ReviewContentError`s (like
 * "No valid reviewers selected") so callers can deliver a guidance message
 * instead of an error.
 */
export class NoReviewContentError extends ReviewContentError {}

export interface RunReviewOptions {
  /** Reviewer ids to run; defaults to all registered reviewers. Unknown ids are skipped. */
  reviewers?: string[]
  /** Task/prompt text the change is supposed to implement (drives the `spec` reviewer). */
  spec?: string
  /** Explicit content to review; overrides the working diff. */
  target?: string
  /** Invoking session, linked as parent of the reviewer sessions when available. */
  parentSessionID?: string
  /** Abort signal from the tool execution context, if any. */
  signal?: AbortSignal
}

export interface ReviewerResult {
  reviewerId: string
  label: string
  ok: boolean
  /** Final assistant text when ok. */
  text?: string
  /** Error message when not ok (failure or timeout). */
  error?: string
  sessionID?: string
}

export interface RunReviewOutput {
  results: ReviewerResult[]
  /** Requested reviewer ids that were skipped because they are unknown. */
  skipped: string[]
  /** Whether the embedded diff content was truncated. */
  truncated: boolean
}

interface ResolvedContent {
  content?: string
  contentSource?: "diff" | "target"
  truncated: boolean
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Resolve what to review: explicit `target` first, else the working diff.
 * An absent repository or empty diff resolves to no content (not an error) —
 * `runReview` decides whether that is fatal based on whether a spec was given.
 */
async function resolveContent(ctx: Plugin.Context, opts: RunReviewOptions): Promise<ResolvedContent> {
  const target = opts.target?.trim()
  if (target) return { content: target, contentSource: "target", truncated: false }
  try {
    const diff = await ctx.vcs.diff({ mode: "working", context: 3 })
    const joined = (diff.data ?? [])
      .map(
        (file) =>
          `--- ${file.file} (${file.status}, +${file.additions}/-${file.deletions})\n${file.patch}`,
      )
      .join("\n\n")
    if (!joined.trim()) return { truncated: false }
    if (joined.length > DIFF_CHAR_CAP) {
      return {
        content: `${joined.slice(0, DIFF_CHAR_CAP)}\n\n[... diff truncated at ${DIFF_CHAR_CAP} characters; review the remaining files directly with your tools ...]`,
        contentSource: "diff",
        truncated: true,
      }
    }
    return { content: joined, contentSource: "diff", truncated: false }
  } catch {
    // No repository (or VCS provider failure) at this location — treat as "no diff".
    return { truncated: false }
  }
}

/** Race a promise against the per-reviewer timeout. */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(REVIEWER_TIMEOUT_MS / 60_000)} minutes`)),
      REVIEWER_TIMEOUT_MS,
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Extract the final assistant text from a session's message list. */
function extractFinalAssistantText(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { type?: string; content?: Array<{ type?: string; text?: string }> }
    if (message?.type !== "assistant") continue
    const text = (message.content ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
      .map((part) => part.text)
      .join("\n\n")
      .trim()
    if (text) return text
  }
  return undefined
}

/** Run one reviewer in a fresh child session and capture its result or failure. */
async function runReviewer(
  ctx: Plugin.Context,
  reviewerId: string,
  input: ReviewInput,
  opts: RunReviewOptions,
): Promise<ReviewerResult> {
  const reviewer = getReviewer(reviewerId)
  if (!reviewer) return { reviewerId, label: reviewerId, ok: false, error: `unknown reviewer "${reviewerId}"` }
  const label = reviewer.label
  try {
    const created = await ctx.session.create({
      title: `multi-review (${reviewer.id})`,
      parentID: opts.parentSessionID,
    })
    try {
      await ctx.session.prompt({ sessionID: created.id, text: reviewer.buildPrompt(input) })
      await ctx.session.wait({ sessionID: created.id })
      const messages = await ctx.session.context({ sessionID: created.id })
      const text = extractFinalAssistantText(messages)
      if (!text) {
        return { reviewerId, label, ok: false, error: "reviewer session produced no text output", sessionID: created.id }
      }
      return { reviewerId, label, ok: true, text, sessionID: created.id }
    } catch (error) {
      return { reviewerId, label, ok: false, error: errorMessage(error), sessionID: created.id }
    }
  } catch (error) {
    return { reviewerId, label, ok: false, error: errorMessage(error) }
  }
}

/**
 * Fan the review content out to the selected specialized reviewers concurrently
 * and return per-reviewer results. A failing or timed-out reviewer never fails
 * the whole run — it is captured as an error result instead.
 */
export async function runReview(ctx: Plugin.Context, opts: RunReviewOptions): Promise<RunReviewOutput> {
  if (opts.signal?.aborted) throw new Error("review aborted")

  // Validate requested reviewer ids; unknown ids are skipped and noted.
  const skipped = (opts.reviewers ?? []).filter((id) => !REVIEWER_IDS.includes(id))
  const selected = opts.reviewers?.length
    ? opts.reviewers.filter((id) => REVIEWER_IDS.includes(id))
    : REVIEWERS.map((reviewer) => reviewer.id)
  if (selected.length === 0) {
    throw new ReviewContentError(
      `No valid reviewers selected. Valid ids: ${REVIEWER_IDS.join(", ")}.` +
        (skipped.length ? ` Skipped unknown ids: ${skipped.join(", ")}.` : ""),
    )
  }

  const resolved = await resolveContent(ctx, opts)
  if (!resolved.content && !opts.spec?.trim()) {
    throw new NoReviewContentError(
      "Nothing to review: no working diff is available and no `target` or `spec` was provided. " +
        "Run inside a repository with uncommitted changes, or pass `target` (the code/text to review) " +
        "or `spec` (the task description to review against).",
    )
  }

  const input: ReviewInput = {
    content: resolved.content,
    contentSource: resolved.contentSource,
    spec: opts.spec,
  }

  const settled = await Promise.allSettled(
    selected.map((reviewerId) =>
      withTimeout(runReviewer(ctx, reviewerId, input, opts), getReviewer(reviewerId)?.label ?? reviewerId),
    ),
  )

  const results: ReviewerResult[] = settled.map((outcome, index) => {
    const reviewerId = selected[index]
    if (outcome.status === "fulfilled") return outcome.value
    return { reviewerId, label: getReviewer(reviewerId)?.label ?? reviewerId, ok: false, error: errorMessage(outcome.reason) }
  })

  return { results, skipped, truncated: resolved.truncated }
}
