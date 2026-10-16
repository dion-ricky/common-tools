import { Plugin } from "@opencode/plugin"
import { formatReport, synthesize } from "./report"
import { ReviewContentError, NoReviewContentError, runReview } from "./runner"
import { REVIEWERS, REVIEWER_IDS } from "./reviewers"

/**
 * multi-review — fan the current changes/spec out to specialized reviewers
 * (quality, bugs, spec adherence, architecture, security) running in fresh
 * concurrent sessions, then deliver one consolidated markdown report.
 */
export default Plugin.define({
  id: "multi-review",
  async setup(ctx) {
    async function execute(sessionID: string, opts: { reviewers?: string[]; spec?: string; target?: string }, signal?: AbortSignal) {
      try {
        const run = await runReview(ctx, { ...opts, parentSessionID: sessionID, signal })
        const summary = await synthesize(ctx, run.results)
        return formatReport({ results: run.results, skipped: run.skipped, summary, truncated: run.truncated })
      } catch (error) {
        if (error instanceof NoReviewContentError) {
          // Nothing to review — deliver guidance through the normal report
          // paths instead of an error. No reviewer sessions are launched and
          // no target is guessed.
          return [
            "**multi-review: nothing to review was detected.**",
            "",
            "No explicit target/spec was provided and no working diff is available, so no reviewers were run.",
            "",
            "To run a review, provide what to review:",
            "",
            "- `/review <task description>` — the prompt text is used as the task spec the reviewers check against.",
            "- `multi_review` tool — pass `target` (explicit code/text to review) and/or `spec` (the task or requirements the change is supposed to implement).",
            "",
            "Without an explicit target or spec, the working-diff mode requires uncommitted changes in a repository.",
          ].join("\n")
        }
        if (error instanceof ReviewContentError) throw error
        throw new Error(`multi-review failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Human entry point: /review [task description]
    // The command's prompt text is treated as the spec for the `spec` reviewer.
    await ctx.command.transform((editor) => {
      editor.add({
        name: "review",
        description:
          "Run specialized multi-perspective reviewers (quality, bugs, spec adherence, architecture, security) over the current changes and post one consolidated report. The prompt text is used as the task spec.",
        execute: async ({ sessionID, prompt }) => {
          const spec = prompt.text.trim()
          try {
            const report = await execute(sessionID, { spec: spec || undefined })
            await ctx.session.synthetic({ sessionID, text: report })
          } catch (error) {
            await ctx.session.synthetic({
              sessionID,
              text: `**multi-review could not run.** ${error instanceof Error ? error.message : String(error)}`,
            })
          }
        },
      })
    })

    // Agent entry point: multi_review tool.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "multi_review",
        description:
          "Run multiple specialized reviewers (quality, bugs, spec adherence, architecture, security) concurrently over the current working diff, an explicit target, or a task spec, and return one consolidated markdown report.",
        input: {
          type: "object",
          properties: {
            reviewers: {
              type: "array",
              items: { type: "string", enum: [...REVIEWER_IDS] },
              description: `Reviewer ids to run. Defaults to all: ${REVIEWER_IDS.join(", ")}. Unknown ids are skipped and noted.`,
            },
            spec: {
              type: "string",
              description: "The task or requirements the change is supposed to implement; drives the spec-adherence reviewer.",
            },
            target: {
              type: "string",
              description: "Explicit code, text, or file content to review; overrides the working diff.",
            },
          },
          required: [],
          additionalProperties: false,
        },
        execute: async (rawInput, context) => {
          const input = (rawInput ?? {}) as { reviewers?: string[]; spec?: string; target?: string }
          const report = await execute(context.sessionID, {
            reviewers: input.reviewers,
            spec: input.spec,
            target: input.target,
          }, context.signal)
          return { content: report }
        },
      })
    })

    console.log(
      `multi-review plugin loaded: /review command + multi_review tool (${REVIEWERS.map((r) => r.id).join(", ")})`,
    )
  },
})
