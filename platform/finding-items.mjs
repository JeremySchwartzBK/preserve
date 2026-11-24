// How the check's findings become the items a person answers in review (Jeremy, 2026-11-24: never make the person tell
// us twice, and a confirmed issue stays confirmed until it is fixed or they take it back).
import { MOVE_FAMILY } from '../harness/fix-menu.mjs';
import { groupMessage } from '../app/review-messages.js';

// The same issue: the same kind of finding, or one of the same movement family (a drag problem found by two tests).
export const sameKind = (a, b) => a === b || (!!MOVE_FAMILY[a] && MOVE_FAMILY[a] === MOVE_FAMILY[b]);

// The same issue on the same part on desktop and phone is one item, kept on the first layout listed (desktop), with
// where it sits on the other layout in spots[layout], so that view shows the same item there.
export function oneItemPerIssue(pins) {
  const out = [];
  for (const p of pins) {
    const twin = p.blockId && out.find((q) => q.blockId === p.blockId && q.layout && p.layout && q.layout !== p.layout && !q.spots?.[p.layout] && sameKind(q.code, p.code));
    if (!twin) { out.push(p); continue; }
    if (p.codes || twin.codes) { twin.codes = [...new Set([...(twin.codes || [twin.code]), ...(p.codes || [p.code])])]; twin.text = groupMessage(twin.codes); }
    (twin.spots ||= {})[p.layout] = { x: +p.x || 0, y: +p.y || 0, pageY: p.pageY ?? null };
  }
  return out;
}

// The newest answer to the same issue on the same part, from any earlier round and either layout, carries: "Fix issue"
// as well as "Not an issue". `answered` is newest first; a carried pin whose answer was cleared ends the search (the
// person asked to be asked again).
export function carryAnswers(pins, answered) {
  for (const p of pins) {
    const last = answered.find((x) => x.block_id === p.blockId && sameKind(x.code, p.code) && (x.verdict || x.carried));
    if (last?.verdict) p.verdict = last.verdict;
  }
  return pins;
}
