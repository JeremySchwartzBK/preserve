// The AI's look at suspected issues (ai-vet.mjs), with a stand-in for the model: a false alarm is moved out of the
// findings and kept on record, a movement finding is never dropped from pictures, and a real one carries its sentence.
// Usage: node test-vet.mjs <served copy dir> <copy id> <live url> <block id>   (needs Chromium; not run in CI)
import assert from 'node:assert/strict';
import path from 'node:path';
import { serve } from './gate.mjs';
import { vetFindings } from './ai-vet.mjs';

const [root, id, live, block] = process.argv.slice(2);
const answers = { 'part-size-differs': { verdict: 'false-alarm', say: '' }, 'drag-lost': { verdict: 'false-alarm', say: '' }, 'blank-images': { verdict: 'real', say: 'Some pictures are missing here, but show on your site.' } };
const client = { beta: { messages: { create: async (req) => { const t = req.messages[0].content[1].text; const k = Object.keys(answers).find((c) => t.includes(c)); return { stop_reason: 'end_turn', model: 'stub', usage: {}, content: [{ type: 'text', text: JSON.stringify({ ...answers[k], reason: 'stub' }) }] }; } } } };
process.env.PRESERVE_AI = 'on'; process.env.ANTHROPIC_API_KEY = 'x';
const srv = await serve(root);
const spot = () => ({ blockId: block, layout: 'desktop', x: 0.5, y: 0.5 });
const v = { result: 'fail', notes: [], reasons: [
  { code: 'part-size-differs', detail: 'part-size-differs', spots: [spot()] },
  { code: 'drag-lost', detail: 'drag-lost', spots: [spot()] },
  { code: 'blank-images', detail: 'blank-images', spots: [spot()] },
] };
const out = await vetFindings(v, { liveUrl: live, copyBase: `http://127.0.0.1:${srv.address().port}/${id}`, dir: '/tmp/vet-test', client });
srv.close();
assert.deepEqual(out.reasons.map((r) => r.code), ['drag-lost', 'blank-images']);
assert.equal(out.reasons[0].spots[0].vet.verdict, 'unsure');
assert.equal(out.reasons[1].spots[0].vet.say, 'Some pictures are missing here, but show on your site.');
assert.deepEqual(out.info.vetted.clearedKinds, ['part-size-differs']);
console.log('vet: ok', JSON.stringify(out.info.vetted).slice(0, 200));
process.exit(0);
