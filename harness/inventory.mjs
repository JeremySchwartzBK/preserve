// What effects a Squarespace page uses, read from its code alone: no browser, no clicking (Jeremy, 2026-11-23: "is there a
// feasible way to know from the code what types of effects are being used?"). Squarespace writes into the page what
// each part is: every block's kind, each section's background effect and gallery layout, the site-wide scroll
// animation, the script controllers it will start. Code the owner added (code blocks, injected scripts, plugins) is
// visible too, but not what it does, so it is always listed as custom.
//
// inventory(html) -> { site: [feature], parts: { partId: [feature] } }
//   partId is the block id ("block-…") or "section:<id>", the same ids the quality check reports places by, so a
//   difference the check finds can be traced to the features of the part it was found in.
import * as cheerio from 'cheerio';

// Hosts whose scripts are Squarespace's own or plain analytics: not custom code.
const OWN = /(^|\.)(squarespace\.com|sqspcdn\.com|squarespace-cdn\.com|typekit\.net|google-analytics\.com|googletagmanager\.com|gstatic\.com|google\.com|googleapis\.com|facebook\.net|pinimg\.com|doubleclick\.net)$/i;
// Block kinds that carry no behaviour of their own.
const PLAIN = new Set(['html', 'image', 'imageFluid', 'button', 'horizontalrule', 'spacer', 'shape', 'socialLinks', 'socialaccountlinks', 'website-component', 'line', 'quote']);

export function inventory(html) {
  const $ = cheerio.load(html);
  const site = new Set(), parts = {};
  const add = (id, f) => { if (!id) return; (parts[id] ||= new Set()).add(f); };
  const body = $('body').attr('class') || '';
  // Site-wide scroll animation (Design > Site styles > Animations): style and type are body classes.
  const style = body.match(/tweak-global-animations-animation-style-([a-z-]+)/)?.[1], type = body.match(/tweak-global-animations-animation-type-([a-z-]+)/)?.[1];
  if (type && type !== 'none') site.add(`site-animation:${type}`);  // "type none" is animations off
  if (/header--menu-overlay|header-burger-menu-desktop|show-burger-desktop/.test($.html('header') || '')) site.add('header:menu-button-on-desktop');
  if ($('.header-nav-folder-content').length) site.add('header:menu-folders');

  $('section[data-section-id]').each((_, s) => {
    const sid = `section:${$(s).attr('data-section-id')}`, cls = $(s).attr('class') || '';
    try {
      const ctx = JSON.parse($(s).attr('data-current-context') || '{}');
      const fx = ctx.backgroundMediaEffect?.type; if (fx && fx !== 'none') add(sid, `section-effect:${fx}`);
      if (ctx.sectionTheme && /adjust|change/i.test(JSON.stringify(ctx.sectionAnimation || ''))) add(sid, 'section:colour-change-on-scroll');
    } catch {}
    if ($(s).find('.section-background .sqs-video-background[data-config-url], .section-background video, .section-background [data-config-video]').length) add(sid, 'section:background-video');
    if (/background-adjusting/.test(cls)) add(sid, 'section:colour-change-on-scroll');
    for (const g of ['user-items-list-carousel', 'user-items-list-banner-slideshow', 'user-items-list-simple', 'gallery-slideshow', 'gallery-grid', 'gallery-masonry', 'gallery-strips', 'gallery-reel', 'gallery-fullscreen-slideshow'])
      if ($(s).find(`.${g}, [class*="${g}"]`).length) add(sid, `gallery:${g.replace(/^user-items-list-|^gallery-/, '')}`);
    $(s).find('[data-controller]').each((_, e) => { for (const c of ($(e).attr('data-controller') || '').split(',').map((x) => x.trim())) if (c && !/^(SectionWrapperController|BackgroundImageFXParallax|ImageZoom|Header)$/.test(c)) add(sid, `controller:${c}`); });
  });

  $('[id^="block-"], [data-block-type]').each((_, b) => {
    const id = $(b).attr('id') || null; if (!id || $(b).find('[id^="block-"]').length) return;
    const cls = $(b).attr('class') || '', def = $(b).attr('data-definition-name')?.replace(/^website\.components\./, '');
    const kinds = new Set();
    if (def) kinds.add(def);
    for (const m of cls.matchAll(/\bsqs-block-([a-z0-9-]+)\b/g)) if (!/^(content|alignment|website-component|button-container|button-element)/.test(m[1])) kinds.add(m[1]);
    const sid = $(b).closest('section[data-section-id]').attr('data-section-id');
    for (const k of kinds) if (!PLAIN.has(k)) { add(id, `block:${k}`); if (sid) add(`section:${sid}`, `block:${k}`); }
    if (kinds.has('code') || kinds.has('embed') || $(b).find('script, iframe').length) { add(id, 'custom:code-block'); if (sid) add(`section:${sid}`, 'custom:code-block'); }
  });
  if ($('.product-list, .products-flex-container, .ProductList').length) site.add('shop:product-list');
  if ($('.grid-image-hover, .product-list-item-image--hover, [data-hover-image]').length) site.add('shop:second-photo-on-hover');
  if ($('.accordion-items-container, .sqs-block-accordion').length) site.add('accordion');

  // Owner-added code: Squarespace writes its own head first and marks the end ("End of Squarespace Headers"); what
  // follows in the head is the owner's code injection. Scripts from other hosts anywhere are plugins or widgets.
  const raw = html, mark = raw.indexOf('End of Squarespace Headers'), headEnd = raw.search(/<\/head>/i);
  if (mark > 0 && headEnd > mark) {
    const inj = raw.slice(mark, headEnd);
    if (/<script(?![^>]*type="application\/(ld\+)?json")[^>]*>\s*\S/i.test(inj)) site.add('custom:head-script');
    if (/<style[^>]*>[\s\S]*?(@keyframes|animation\s*:|transition\s*:|:hover)[\s\S]*?<\/style>/i.test(inj)) site.add('custom:css-effects');
  }
  $('script[src]').each((_, e) => { try { const h = new URL($(e).attr('src'), 'https://x.invalid').hostname; if (h !== 'x.invalid' && !OWN.test(h)) site.add(`custom:script ${h}`); } catch {} });
  // Footer code injection sits after the page's last section, outside Squarespace's own containers.
  $('body > script:not([src]), body > style').each((_, e) => { const t = $(e).html() || ''; if (t.length > 40 && !/Static\.|SQUARESPACE|Squarespace|wf-loading|getElementById\('header'\)/.test(t) && !/json/i.test($(e).attr('type') || '')) site.add(e.tagName === 'style' ? 'custom:footer-style' : 'custom:footer-script'); });
  return { site: [...site].sort(), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, [...v].sort()])) };
}
