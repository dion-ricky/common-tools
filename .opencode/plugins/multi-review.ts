// Auto-discovery entry point: OpenCode loads every direct .ts/.js child of
// .opencode/plugins/ at startup. This re-exports the plugin sources at the
// repo root so the plugin loads without any "plugins" config entry. Relative
// imports resolve against the repo root, where node_modules lives.
import plugin from "../../index"

export default plugin
export const MultiReview = plugin
