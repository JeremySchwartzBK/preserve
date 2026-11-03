# Copies on the new platform (2026-10-16)

Served by the Worker in `worker/src/index.js` from R2 bucket `preserve-copies`, lookup records in R2 under `lookup/` (moved from KV `preserve-lookup` on 2026-10-16: KV free tier allows only 1,000 writes a day), through the Cloudflare Pages project `preserve-view` (a Pages project because the API key can deploy Pages but not standalone Workers; same code either way). Studio slug `demo` for now.

| Copy | Permanent link | Friendly link |
|---|---|---|
| minaab | https://preserve-view.pages.dev/c/q9398e5j/ | https://preserve-view.pages.dev/demo/minaab/ |
| breathpod | https://preserve-view.pages.dev/c/znf7w3k9/ | https://preserve-view.pages.dev/demo/breathpod/ |
| kosa | https://preserve-view.pages.dev/c/9x2arj4e/ | https://preserve-view.pages.dev/demo/kosa/ |
| designforward | https://preserve-view.pages.dev/c/2h59u7sb/ | https://preserve-view.pages.dev/demo/designforward/ |
| xanadu | https://preserve-view.pages.dev/c/b4vhrecu/ | https://preserve-view.pages.dev/demo/xanadu/ |

## Embed snippet

Same for every Preserve; only the ID changes. The frame picks the phone or desktop layout from its own width. Inside a
Squarespace block (Code or Embed) it fills the block; anywhere else it is full width and 600 px tall (Jeremy confirmed
it on his Squarespace page, 2026-11-03; thread "Fix embed height on Squarespace").

```html
<style>.fe-block .sqs-block:has(.preserve-embed){position:relative}.fe-block .sqs-block:has(.preserve-embed) :has(.preserve-embed){position:static!important;padding:0!important;height:auto!important}.fe-block .preserve-embed{position:absolute!important;inset:0;height:auto!important;max-height:none!important}</style>
<div class="preserve-embed" style="position:relative;width:100%;height:600px;max-height:90vh">
<iframe title="Interactive website preview" style="position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:10px" loading="eager" referrerpolicy="no-referrer"></iframe>
<script>(function(f){f.src='https://preserve-view.pages.dev/c/COPY_ID/'+(f.parentNode.offsetWidth<768?'mobile':'desktop')})(document.currentScript.previousElementSibling)</script>
</div>
```
