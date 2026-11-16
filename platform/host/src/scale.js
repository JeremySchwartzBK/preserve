// How many runners to have awake (production-readiness review, B2). One runner makes SLOTS Preserves at a time; when
// more are waiting, the minute check starts more runners, up to RUNNERS_MAX (a variable in wrangler.jsonc, which must
// not be higher than the container's max_instances there). Runners that find nothing to do go back to sleep by
// themselves, so extra ones cost only while a queue is being worked through.
export const SLOTS = 2;  // RUNNER_SLOTS in the Dockerfile
export const runnersMax = (env) => Math.max(1, Math.min(10, Math.floor(+env.RUNNERS_MAX) || 1));

// state: jobs waiting, jobs being made, and whether anything visitors see is waiting to be brought up to date.
export function runnersNeeded({ jobs = 0, busy = 0, serving = false }, max = 1, slots = SLOTS) {
  if (!jobs) return serving ? 1 : 0;        // nothing new to make: leave running ones alone, wake the first for upkeep
  return Math.max(1, Math.min(max, Math.ceil((jobs + busy) / slots)));
}
