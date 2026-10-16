import type { Plugin } from "@opencode/plugin"
import type { ReviewerResult } from "./runner"

/** Cap per-reviewer text fed into synthesis so the summary prompt stays bounded. */
const SYNTHESIS_INPUT_CAP = 20_000

export interface ReportInput {
  results: ReviewerResult[]
  /** Requested reviewer ids skipped as unknown. */
  skipped?: string[]
  /** Executive summary from `synthesize`, when synthesis succeeded. */
  summary?: string
  /** Whether the diff content was truncated before review. */
  truncated?: boolean
}

/**
 * Build the consolidated markdown report: one `##` section per reviewer,
 * a top-level summary section, and reviewer session ids for inspection.
 */
export function formatReport(input: ReportInput): string {
  const { results, skipped = [], summary, truncated = false } = input
  const lines: string[] = ["# Multi-Review Report", ""]

  lines.push("## Summary", "")
  if (summary && summary.trim()) {
    lines.push(summary.trim(), "")
  } else {
    const ok = results.filter((result) => result.ok)
    const failed = results.filter((result) => !result.ok)
    lines.push(
      `${ok.length}/${results.length} reviewers completed${failed.length ? `; ${failed.length} failed` : ""}. ` +
        `Reviewers: ${results.map((result) => `\`${result.reviewerId}\``).join(", ") || "none"}.`,
      "",
    )
  }

  if (truncated) {
    lines.push(
      "> Note: the working diff exceeded the prompt cap and was truncated; reviewers may have missed later files.",
      "",
    )
  }
  if (skipped.length) {
    lines.push(
      `> Note: skipped unknown reviewer ids: ${skipped.map((id) => `\`${id}\``).join(", ")}. ` +
        `Valid ids: see the plugin README.`,
      "",
    )
  }

  for (const result of results) {
    lines.push(`## ${result.label} (${result.reviewerId})`, "")
    if (result.ok && result.text) {
      lines.push(result.text.trim(), "")
    } else {
      lines.push(
        `> This reviewer did not complete: ${result.error ?? "unknown error"}. ` +
          `The other reviewers' results are still reported below/above.`,
        "",
      )
    }
    if (result.sessionID) {
      lines.push(`*Reviewer session: \`${result.sessionID}\`*`, "")
    }
  }

  return lines.join("\n").trim() + "\n"
}

/**
 * Deduplicate overlapping findings into an executive summary using
 * `ctx.generate.text` (session-default model). Returns undefined when
 * synthesis is unnecessary or fails, so the caller can fall back to a
 * plain summary.
 */
export async function synthesize(ctx: Plugin.Context, results: ReviewerResult[]): Promise<string | undefined> {
  const ok = results.filter((result) => result.ok && result.text)
  if (ok.length < 2) return undefined
  try {
    const sections = ok
      .map((result) => {
        const text = result.text!.length > SYNTHESIS_INPUT_CAP ? `${result.text!.slice(0, SYNTHESIS_INPUT_CAP)}\n[... truncated ...]` : result.text!
        return `### ${result.label} (${result.reviewerId})\n\n${text}`
      })
      .join("\n\n")
    const response = await ctx.generate.text({
      prompt:
        "You are synthesizing a multi-perspective code review. Below are the full reports from several " +
        "specialized reviewers. Write an executive summary of at most 3 short paragraphs: (1) the overall " +
        "assessment, (2) the most important findings merged across reviewers — deduplicate overlapping " +
        "findings and keep file:line references where the reviewers provided them, (3) what to do next. " +
        "Do not invent findings that no reviewer reported.\n\n" +
        sections,
    })
    const text = response?.text?.trim()
    return text || undefined
  } catch {
    // Synthesis is best-effort; the report falls back to per-reviewer sections.
    return undefined
  }
}
