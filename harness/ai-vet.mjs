// The AI looks at every suspected issue before the person sees it (Jeremy, 2026-11-24, refinement rework item 2): it
// drops false alarms and says what real ones are in plain words. For each spot our check flagged, it gets frames of that
// part on the live site and in the copy, a few measurements, and our check's own sentence and detail, and answers whether
// the difference is real and, if so, one short sentence for the person.
// It only drops what pictures can show. How something moves (a drag, a hover, a timer, a menu) doesn't show in frames,
// so those findings are never dropped here, only described. Everything it decides is kept on the verdict (info.vetted)
// so we can audit it, and dropped spots stay in the verdict under `vettedOut`, never silently lost.
// Off unless PRESERVE_AI=on and ANTHROPIC_API_KEY is set; when off or when the API fails, findings go out as before.
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './lib.mjs';
import { frames, sheet, aiEnabled, AI_MODEL } from './ai-pins.mjs';
import { MOVE_FAMILY } from './fix-menu.mjs';
import { spotMessage, HIDDEN } from '../app/review-messages.js';

const MAX_SPOTS = 12;   // per copy; the rest go out as before

const SYSTEM = `You help make Preserves: frozen copies of a designer's web page, saved as it looked at one moment. Our automated check compared the Preserve with the live site and flagged a spot as different. Before the site's owner sees it, you look at that spot and decide whether the difference is real.

The picture has two rows of frames of the spot, left to right about one second apart: the TOP row is the live site, the BOTTOM row is the Preserve. A row is missing when the spot could not be found on that side.

Fields:
- "verdict": "real" when the owner would see the difference and care; "false-alarm" when the two look the same to a person (tiny shifts, anti-aliasing, a slideshow simply on a different slide, a random or rotating image, content still loading on the live site); "unsure" when you can't tell from the pictures.
- "say": when real or unsure, ONE short sentence for the site's owner saying what is different, comparing "here" (the Preserve) with "your site". Plain words a designer uses, no technical terms (never: pixels, viewport, CSS, stylesheet, widget, DOM, render, element, block, div). Capitalize "Preserve". Write out numbers under ten. Don't guess at causes and don't promise a fix. Empty when false-alarm.
- "reason": one short sentence for our logs (the owner never sees it).`;

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['real', 'false-alarm', 'unsure'] },
    say: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['verdict', 'say', 'reason'],
  additionalProperties: false,
};

async function ask(client, r, spot, facts, picture) {
  const res = await client.beta.messages.create({
    model: AI_MODEL, max_tokens: 2000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(picture).toString('base64') } },
      { type: 'text', text: `Layout: ${spot.layout}\nOur check says: ${JSON.stringify(spotMessage(r.code, 'part'))}\nCheck detail (for you): ${JSON.stringify(String(r.detail || '').slice(0, 400))}\nMeasurements of the spot: ${JSON.stringify(facts)}` },
    ] }],
  });
  if (res.stop_reason === 'refusal') throw new Error('declined');
  return { ...JSON.parse(res.content.find((b) => b.type === 'text').text), model: res.model, tokens: { in: res.usage?.input_tokens ?? null, out: res.usage?.output_tokens ?? null } };
}

// verdict: the check's verdict (reasons with spots). copyBase: where the copy is served, without the layout.
// Returns the verdict with each looked-at spot carrying `vet`, false alarms moved to reason.vettedOut, reasons left with no
// spots dropped, and info.vetted counting what happened.
export async function vetFindings(verdict, { liveUrl, copyBase, dir, dry = false, client = null }) {
  if ((!dry && !aiEnabled()) || !verdict?.reasons?.length) return verdict;
  const todo = [];
  for (const r of verdict.reasons) if (!HIDDEN.has(r.code)) for (const s of r.spots || []) if (s.blockId && todo.length < MAX_SPOTS) todo.push([r, s]);
  if (!todo.length) return verdict;
  client ||= dry ? null : new (await import('@anthropic-ai/sdk')).default({ timeout: 90_000, maxRetries: 2 });
  fs.mkdirSync(dir, { recursive: true });
  const stats = { looked: 0, real: 0, falseAlarm: 0, unsure: 0, errors: 0, tokens: 0 };
  const browser = await launch();
  try {
    for (const [i, [r, s]] of todo.entries()) {
      const pin = { block_id: s.blockId, layout: s.layout };
      const pd = path.join(dir, `vet${i}`); fs.mkdirSync(pd, { recursive: true });
      try {
        const live = await frames(browser, liveUrl, pin, pd, 'live');
        const copy = await frames(browser, `${copyBase.replace(/\/$/, '')}/${s.layout || 'desktop'}`, pin, pd, 'copy');
        if (!live.files.length && !copy.files.length) continue;
        const picture = await sheet([live.files, copy.files].filter((x) => x.length), path.join(pd, 'sheet.png'));
        if (dry) { s.vet = { dry: true, picture }; continue; }
        const v = await ask(client, r, s, { liveSite: live.facts, preserve: copy.facts }, picture);
        stats.looked++; stats.tokens += (v.tokens.in || 0) + (v.tokens.out || 0);
        // Movement doesn't show in frames: never dropped from pictures alone, only described.
        if (v.verdict === 'false-alarm' && MOVE_FAMILY[r.code]) v.verdict = 'unsure';
        stats[v.verdict === 'false-alarm' ? 'falseAlarm' : v.verdict]++;
        s.vet = { verdict: v.verdict, say: v.verdict === 'false-alarm' ? '' : String(v.say || '').trim().slice(0, 240), reason: v.reason, model: v.model };
      } catch (e) { stats.errors++; s.vet = { error: String(e.message || e).split('\n')[0].slice(0, 200) }; }
    }
  } finally { await browser.close(); }
  for (const r of verdict.reasons) {
    if (!r.spots?.length) continue;
    const out = r.spots.filter((s) => s.vet?.verdict === 'false-alarm');
    if (!out.length) continue;
    r.vettedOut = [...(r.vettedOut || []), ...out];
    r.spots = r.spots.filter((s) => s.vet?.verdict !== 'false-alarm');
  }
  // A finding the AI cleared everywhere it was seen no longer holds the copy back; it stays on record under vettedOut.
  const gone = verdict.reasons.filter((r) => r.vettedOut?.length && !r.spots.length);
  verdict.reasons = verdict.reasons.filter((r) => !gone.includes(r));
  (verdict.info ||= {}).vetted = { ...stats, clearedKinds: gone.map((r) => r.code), cleared: gone };
  if (verdict.result === 'fail' && !verdict.reasons.length) verdict.result = verdict.notes?.length ? 'ship-with-note' : 'pass';
  return verdict;
}
