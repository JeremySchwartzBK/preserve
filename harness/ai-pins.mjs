// AI for refinements, Option B (Jeremy, 2026-10-29): before a refinement, a model reads each of the person's pins (their
// note, plus pictures of that spot on the live site and in the Preserve, and a few measurements) and picks one fix from
// a fixed menu that we built and tested. It never writes code, and the pin check after the round still decides whether
// the spot looks fixed. Each pin's kind of problem is recorded too, so we learn which families of fixes matter most.
// Off unless PRESERVE_AI=on and ANTHROPIC_API_KEY is set; when off, or when the API fails, refinements work as before
// (a careful re-capture of every pinned spot).
// Usage (by hand): node ai-pins.mjs <liveUrl> <preserveBaseUrl> <pins.json> <outDir> [--dry]   (prints the pins with
// their picks; --dry gathers the pictures and measurements without calling the model)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PROFILES, launch, sleep } from './lib.mjs';
import { diffPct } from './check.mjs';

export const AI_MODEL = 'claude-opus-5-5';
const MAX_PINS = 6; // per round; the rest get today's careful re-capture
const FRAMES = 4, FRAME_GAP_MS = 1000, FRAME_MAX_H = 900, PAD = 24;

// The fixes a refinement can apply. Only these: a new kind of problem gets a new, tested entry here, never generated code.
export const ACTIONS = {
  'wait-longer': 'The spot was caught before it finished: an image or video that had not loaded, a slideshow or entrance animation caught mid-way, a widget still loading. The refinement waits much longer at this spot before saving it.',
  still: 'A widget that draws wrong, blank or broken in the Preserve while the live site shows it fine (a map, a booking or third-party embed, a canvas drawing, a custom-built widget). The refinement photographs it on the live site and shows that picture in its place. Clicks on it then show the "this is a replica" note, so only pick this when the look matters more than the interaction.',
  fonts: 'The difference is the font itself (a different typeface, or a stand-in font). Refinements don\'t change fonts; the person chooses in the Fonts step.',
  'by-design': 'The person is asking about something Preserves do on purpose (see by_design).',
  'live-same': 'The live site shows the same thing at this spot as the Preserve does, so there is nothing for a refinement to change.',
  'try-again': 'None of the above fits, or you can\'t tell. The refinement re-captures the spot carefully, as it always does.',
};
export const BY_DESIGN = {
  'contact-details': 'email addresses, phone numbers and street addresses are replaced with placeholders',
  'pop-ups': 'pop-ups, announcement bars, cookie banners and promo tabs are removed',
  'video-still': 'YouTube and Vimeo videos show a still frame',
  'looping-video': 'looping background video is clipped to a short loop',
  'shopping-forms': 'buttons that buy, book or send a form show a "this is a replica" note instead',
  none: 'not about any of these',
};
const KINDS = ['missing-content', 'image-or-video', 'layout-or-size', 'font', 'motion', 'menu-or-clicks', 'widget', 'colour', 'by-design', 'other'];

const SYSTEM = `You help make Preserves: frozen copies of a designer's web page, saved as it looked at one moment. A person reviewing a Preserve has pinned a spot and written a note about what is wrong there. You get their note, one picture and some measurements of that spot, and you choose ONE fix from a fixed menu. You never write code or CSS.

The picture has two rows of frames of the pinned spot, left to right about one second apart: the TOP row is the live site, the BOTTOM row is the Preserve. A row is missing when the spot could not be found on that side (see the measurements).

The menu (field "action"):
${Object.entries(ACTIONS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Things Preserves do on purpose (field "by_design", "none" unless action is by-design):
${Object.entries(BY_DESIGN).filter(([k]) => k !== 'none').map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Also sort the problem into one kind (field "kind"). Judge from the pictures first and the note second: the note says what the person noticed, the pictures show what differs. "confidence" is how sure you are that the chosen action will fix what the note describes. "reason" is one short sentence for our logs (the person never sees it).`;

const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: KINDS },
    action: { type: 'string', enum: Object.keys(ACTIONS) },
    by_design: { type: 'string', enum: Object.keys(BY_DESIGN) },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reason: { type: 'string' },
  },
  required: ['kind', 'action', 'by_design', 'confidence', 'reason'],
  additionalProperties: false,
};

export const aiEnabled = () => process.env.PRESERVE_AI === 'on' && !!process.env.ANTHROPIC_API_KEY;

// Same lookup as pins.mjs and the review bridge: block ids, el:<selector>, section:<id>.
const FIND = (id) => {
  if (id.indexOf('el:') === 0) return document.querySelector(id.slice(3));
  if (id.indexOf('section:') === 0) return document.querySelector('section[data-section-id="' + id.slice(8) + '"]');
  return document.getElementById(id) || document.querySelector('[data-block-id="' + id + '"]');
};

// Frames of the pinned block on one side, plus what's in it. Pictures at 1 CSS pixel per pixel, to keep them small.
async function frames(browser, url, pin, dir, side) {
  const prof = pin.layout || 'desktop';
  const ctx = await browser.newContext({ ...PROFILES[prof].context, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    const facts = await page.evaluate(([find, id]) => {
      const el = eval(`(${find})`)(id);
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const txt = [...el.querySelectorAll('*')].find((e) => e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
      const imgs = [...el.querySelectorAll('img')];
      return {
        widthPx: Math.round(r.width), heightPx: Math.round(r.height),
        font: txt ? getComputedStyle(txt).fontFamily.slice(0, 80) : null,
        images: imgs.length, imagesNotShowing: imgs.filter((i) => !i.complete || !i.naturalWidth).length,
        videos: el.querySelectorAll('video').length, frames: el.querySelectorAll('iframe').length,
        canvases: el.querySelectorAll('canvas').length,
        customWidgets: [...el.querySelectorAll('*')].filter((e) => e.tagName.includes('-') && !/^(SQS-|PRESERVE-)/.test(e.tagName)).length,
        animations: el.getAnimations ? el.getAnimations({ subtree: true }).length : null,
        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      };
    }, [FIND.toString(), pin.block_id]).catch(() => null);
    if (!facts) return { facts: { found: false }, files: [] };
    await sleep(1500);
    const files = [];
    for (let i = 0; i < FRAMES; i++) {
      const box = await page.evaluate(([find, id]) => { const r = eval(`(${find})`)(id).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, [FIND.toString(), pin.block_id]);
      const vw = page.viewportSize();
      const x = Math.max(0, box.x - PAD), y = Math.max(0, box.y - PAD);
      const clip = { x, y, width: Math.max(8, Math.min(vw.width - x, box.w + 2 * PAD)), height: Math.max(8, Math.min(vw.height - y, box.h + 2 * PAD, FRAME_MAX_H)) };
      const f = path.join(dir, `${side}-${i}.png`);
      await page.screenshot({ path: f, clip });
      files.push(f);
      if (i < FRAMES - 1) await sleep(FRAME_GAP_MS);
    }
    facts.found = true;
    facts.changesOverTimePct = (await diffPct(files[0], files[files.length - 1]).catch(() => null))?.pct ?? null;
    return { facts, files };
  } finally { await ctx.close(); }
}

// Live frames on top, Preserve frames below, each frame fitted into a cell; at most about 1500 px wide.
async function sheet(rows, out) {
  const cellW = Math.floor(1500 / FRAMES), heights = [];
  const cells = [];
  for (const [r, files] of rows.entries()) {
    let rowH = 0;
    for (const [c, f] of files.entries()) {
      const buf = await sharp(f).resize({ width: cellW - 8, height: 700, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      const { height } = await sharp(buf).metadata();
      cells.push({ r, c, buf }); rowH = Math.max(rowH, height);
    }
    heights[r] = Math.max(rowH, 40);
  }
  const top = (r) => heights.slice(0, r).reduce((a, b) => a + b + 12, 0);
  await sharp({ create: { width: cellW * FRAMES, height: top(rows.length), channels: 3, background: '#808080' } })
    .composite(cells.map(({ r, c, buf }) => ({ input: buf, left: c * cellW + 4, top: top(r) })))
    .png().toFile(out);
  return out;
}

async function ask(client, pin, facts, picture) {
  const res = await client.beta.messages.create({
    model: AI_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(picture).toString('base64') } },
        { type: 'text', text: `Layout: ${pin.layout || 'desktop'}\nThe person's note: ${JSON.stringify(pin.body || '')}\nMeasurements of the pinned spot: ${JSON.stringify(facts)}` },
      ],
    }],
  });
  if (res.stop_reason === 'refusal') throw new Error('declined');
  const text = res.content.find((b) => b.type === 'text')?.text;
  const out = JSON.parse(text);
  return { ...out, model: res.model, tokens: { in: res.usage?.input_tokens ?? null, out: res.usage?.output_tokens ?? null } };
}

// The pins with a pick each (pin.ai), for the person's own pins; findings from the quality check and anything past the
// cap pass through unchanged. Never throws: a pin whose look-up fails keeps today's behaviour, with ai.error saying why.
export async function triagePins(pins, { liveUrl, preserveBase, dir, dry = false }) {
  if ((!dry && !aiEnabled()) || !pins.length) return pins;
  const client = dry ? null : new (await import('@anthropic-ai/sdk')).default({ timeout: 90_000, maxRetries: 2 });
  fs.mkdirSync(dir, { recursive: true });
  const browser = await launch();
  const out = [];
  let asked = 0;
  try {
    for (const [i, p] of pins.entries()) {
      if ((p.from && p.from !== 'person') || !p.block_id || asked >= MAX_PINS) { out.push(p); continue; }
      asked++;
      const pd = path.join(dir, `pin${i}`); fs.mkdirSync(pd, { recursive: true });
      try {
        const prof = p.layout || 'desktop';
        const live = await frames(browser, liveUrl, p, pd, 'live');
        const copy = await frames(browser, `${preserveBase.replace(/\/$/, '')}/${prof}?review`, p, pd, 'copy');
        if (!live.files.length && !copy.files.length) { out.push({ ...p, ai: { error: 'spot not found on either side' } }); continue; }
        const picture = await sheet([live.files.length ? live.files : [], copy.files.length ? copy.files : []].filter((r) => r.length), path.join(pd, 'sheet.png'));
        const facts = { liveSite: live.facts, preserve: copy.facts };
        if (dry) { out.push({ ...p, ai: { dry: true, facts, picture } }); continue; }
        const pick = await ask(client, p, facts, picture);
        // A picture in place of a widget can't be undone within the Preserve: only when the model is fairly sure.
        if (pick.action === 'still' && pick.confidence === 'low') pick.action = 'try-again';
        out.push({ ...p, ai: pick });
      } catch (e) {
        out.push({ ...p, ai: { error: String(e.message || e).split('\n')[0].slice(0, 200) } });
      }
    }
  } finally { await browser.close(); }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [liveUrl, preserveBase, pinsFile, dir] = process.argv.slice(2);
  console.log(JSON.stringify(await triagePins(JSON.parse(fs.readFileSync(pinsFile, 'utf8')), { liveUrl, preserveBase, dir, dry: process.argv.includes('--dry') }), null, 1));
  process.exit(0);
}
