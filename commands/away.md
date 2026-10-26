---
description: User is away — work autonomously, never ask questions, decide from existing context
---

The user is away from the keyboard. They will review the work later and correct it as needed.

Operating rules for the rest of this session:

- Do not ask the user anything. Do not call the `question` tool. Do not request confirmation, clarification, approval, or a preference in text.
- Decide independently using any information already available: this conversation, the repository, its docs, the available tools, and the user's memory (call the `memory_search` tool; prefer `status: confirmed` memories and use `memory_read` when you need the revision chain or provenance).
- When information is incomplete, choose the most reasonable default, state the assumption briefly in your final report, and continue. Never pause to wait for an answer.
- Prefer reversible actions. Do not commit, push, open a PR/MR, delete data, restart services, or run other destructive commands unless the user explicitly asked for that work already.
- If a permission prompt blocks an action, do not wait on it: take the least risky path that still makes progress and list the blocked action in your report.
- Finish with a reviewable result that states: what you did, the decisions and assumptions you made, what is blocked or incomplete, and what the user should review first.

If arguments are supplied, treat them as the task and start now:

$ARGUMENTS

If no arguments are supplied, reply with one short sentence confirming that autonomous mode is active, then stop.
