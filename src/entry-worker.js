// RelayBox — Cloudflare Worker entry. Phase 2 fills this in: build the Hono app
// from src/core with the CF adapters (D1MetaStore + R2 Binding/aws4fetch) and
// export fetch + scheduled (expiry + stale-chunk cleanup, every 5 minutes).
// Static Assets (public/) are served by the Worker via the [assets] binding.
export default {
  async fetch() {
    throw new Error('RelayBox Worker entry not implemented yet — see REFACTOR-PLAN.md Phase 2.');
  },
  async scheduled() {
    throw new Error('RelayBox Worker scheduled handler not implemented yet — see REFACTOR-PLAN.md Phase 2.');
  },
};
