/**
 * Cold-email landing page: GET / on demo.stagewell.app, GET /demo, GET /l/demo.
 *
 * Server-rendered, dependency-free HTML. Three before/after sliders carry the
 * page; the copy only states things the app or the outreach emails already
 * claim (about a minute per room, 3 free stagings, plans from $19/month).
 *
 * Demo pairs are curated static files in public/demo/ (Stagewell's own
 * marketing pair + rooms Dillon staged on his own account). Never query the
 * `images` table here: it holds customers' private listing photos and this
 * page is public.
 *
 * ?ct=email1..4 on the inbound URL is Smartlead's campaign tag; the page does
 * not read it, it only has to keep rendering with it present.
 */

export const APP_STORE_URL = "https://apps.apple.com/us/app/stagewell/id6757572170";

interface DemoPair {
  slug: string; // public/demo/{slug}-before.jpg + {slug}-after.jpg
  room: string;
  style: string;
  width: number;
  height: number;
  note: string; // one plain sentence under the slider
}

export const DEMO_PAIRS: DemoPair[] = [
  { slug: "living", room: "Living room", style: "Modern", width: 1200, height: 805, note: "Sectional, rug, shelves and art added. Floor, window and trim untouched." },
  { slug: "loft", room: "Bedroom", style: "Industrial", width: 1200, height: 1200, note: "Brick, ductwork and the city view are from the original photo." },
  { slug: "coastal", room: "Bedroom", style: "Coastal", width: 1200, height: 1200, note: "Same window light and wood panel wall; only the furniture is new." },
];

const DEMO_FILE_RE = /^(living|loft|coastal)-(before|after)\.jpg$/;
const DEMO_FONT_RE = /^instrument-serif(-italic)?-latin\.woff2$/;
const DEMO_DIR = new URL("../../public/demo/", import.meta.url);

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
@font-face {
  font-family: "Instrument Serif";
  font-style: normal; font-weight: 400; font-display: swap;
  src: url(/demo/fonts/instrument-serif-latin.woff2) format("woff2");
}
@font-face {
  font-family: "Instrument Serif";
  font-style: italic; font-weight: 400; font-display: swap;
  src: url(/demo/fonts/instrument-serif-italic-latin.woff2) format("woff2");
}
/* Metric-matched fallback so the headline does not reflow when the serif arrives. */
@font-face {
  font-family: "Instrument Serif Fallback";
  src: local("Iowan Old Style"), local("Palatino"), local("Georgia");
  size-adjust: 88%; ascent-override: 92%; descent-override: 24%; line-gap-override: 0%;
}
@property --pos { syntax: "<percentage>"; inherits: false; initial-value: 50%; }

:root {
  color-scheme: light;
  --paper: #F5F2EC;
  --paper-2: #ECE7DE;
  --ink: #1D1A16;
  --ink-2: #4B463F;
  --ink-3: #7B746B;
  --line: #DCD5CA;
  --accent: #2E5B46;
  --accent-hover: #244A38;
  --serif: "Instrument Serif", "Instrument Serif Fallback", "Iowan Old Style", Palatino, Georgia, serif;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --ease: cubic-bezier(0.23, 1, 0.32, 1);
  --measure: 1120px;
  --gutter: 24px;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font-family: var(--sans); font-size: 17px; line-height: 1.55;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
img { display: block; max-width: 100%; }
a { color: inherit; }
.wrap { max-width: var(--measure); margin: 0 auto; padding: 0 var(--gutter); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Top bar */
.top { display: flex; align-items: center; justify-content: space-between; padding: 26px 0 0; }
.wordmark { font-family: var(--serif); font-size: 28px; line-height: 1; letter-spacing: -0.01em; text-decoration: none; color: var(--ink); }
.top-link { font-size: 14px; color: var(--ink-2); text-decoration: none; border-bottom: 1px solid var(--line); padding-bottom: 2px; transition: color 150ms ease, border-color 150ms ease; }
@media (hover: hover) and (pointer: fine) { .top-link:hover { color: var(--ink); border-color: var(--ink-3); } }

/* Hero */
.hero { display: grid; grid-template-columns: 7fr 5fr; gap: 48px; align-items: end; padding: 88px 0 56px; }
.eyebrow { margin: 0 0 20px; font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
h1 {
  margin: 0; font-family: var(--serif); font-weight: 400;
  font-size: clamp(44px, 5.6vw, 76px); line-height: 1.02; letter-spacing: -0.015em; text-wrap: balance;
}
h1 em { font-style: italic; color: var(--accent); }
.lede { margin: 0 0 24px; font-size: 19px; line-height: 1.5; color: var(--ink-2); max-width: 36ch; }
.btn {
  display: inline-flex; align-items: center; gap: 10px;
  background: var(--accent); color: #fff; text-decoration: none;
  font-size: 16px; font-weight: 600; letter-spacing: 0.005em;
  padding: 15px 22px; border-radius: 6px;
  transition: background-color 150ms ease, transform 160ms var(--ease);
}
.btn svg { width: 16px; height: 16px; flex: none; }
@media (hover: hover) and (pointer: fine) { .btn:hover { background: var(--accent-hover); } }
.btn:active { transform: scale(0.98); }
.btn:focus-visible, .top-link:focus-visible, .wordmark:focus-visible, .foot a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.fine { margin: 14px 0 0; font-size: 14px; color: var(--ink-3); }

/* Examples */
.examples { padding: 8px 0 24px; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 24px; padding: 0 0 20px; border-top: 1px solid var(--line); padding-top: 22px; }
.section-head h2 { margin: 0; font-family: var(--serif); font-weight: 400; font-size: 30px; letter-spacing: -0.01em; line-height: 1.1; }
.section-head p { margin: 0; font-size: 15px; color: var(--ink-3); }
.pair-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 40px; }

.cmp { margin: 0; }
.cmp-stage {
  position: relative; aspect-ratio: var(--ar); overflow: hidden; background: var(--paper-2);
  border-radius: 4px; touch-action: pan-y; user-select: none; -webkit-user-select: none; cursor: ew-resize;
}
.cmp-stage img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
.cmp-before { clip-path: inset(0 calc(100% - var(--pos, 50%)) 0 0); }
.cmp-tag {
  position: absolute; top: 14px; padding: 5px 9px; border-radius: 3px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--paper); background: rgba(29, 26, 22, 0.66); pointer-events: none;
  transition: opacity 200ms ease;
}
.cmp-tag-before { left: 14px; } .cmp-tag-after { right: 14px; }
.cmp-handle {
  position: absolute; top: 0; bottom: 0; left: var(--pos, 50%); width: 0; pointer-events: none;
}
.cmp-handle::before {
  content: ""; position: absolute; top: 0; bottom: 0; left: -1px; width: 2px;
  background: var(--paper); box-shadow: 0 0 0 1px rgba(29, 26, 22, 0.12);
}
.cmp-knob {
  position: absolute; top: 50%; left: 0; width: 44px; height: 44px; transform: translate(-50%, -50%);
  border-radius: 50%; background: var(--paper); color: var(--ink);
  box-shadow: 0 1px 2px rgba(29, 26, 22, 0.18), 0 6px 18px rgba(29, 26, 22, 0.18);
  display: grid; place-items: center;
  transition: transform 160ms var(--ease), box-shadow 160ms var(--ease);
}
.cmp-knob svg { width: 18px; height: 18px; }
.cmp-stage.is-dragging .cmp-knob { transform: translate(-50%, -50%) scale(0.94); }
.cmp-stage.is-focus .cmp-knob { box-shadow: 0 0 0 3px var(--paper), 0 0 0 5px var(--accent); }
.cmp-range { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; pointer-events: none; }
figcaption { display: flex; align-items: baseline; gap: 14px; padding: 14px 2px 0; font-size: 15px; color: var(--ink-3); }
figcaption .num { font-family: var(--serif); font-style: italic; font-size: 18px; color: var(--ink-3); }
figcaption b { font-weight: 600; color: var(--ink); }
figcaption .note { margin-left: auto; text-align: right; max-width: 48%; }

/* How it works */
.how { padding: 72px 0 24px; }
.how-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 40px; padding-top: 12px; }
.pair-grid figcaption { flex-wrap: wrap; gap: 6px 12px; }
.pair-grid figcaption .note { margin-left: 0; text-align: left; max-width: none; flex-basis: 100%; }
.step .n { font-family: var(--serif); font-style: italic; font-size: 30px; line-height: 1; color: var(--ink-3); margin: 0 0 14px; }
.step h3 { margin: 0 0 8px; font-size: 17px; font-weight: 600; }
.step p { margin: 0; font-size: 15.5px; color: var(--ink-2); max-width: 32ch; }

/* Closing */
.close { padding: 80px 0 72px; }
.close-inner { display: grid; grid-template-columns: 7fr 5fr; gap: 48px; align-items: end; border-top: 1px solid var(--line); padding-top: 40px; }
.close h2 { margin: 0 0 16px; font-family: var(--serif); font-weight: 400; font-size: clamp(34px, 4vw, 52px); line-height: 1.05; letter-spacing: -0.015em; text-wrap: balance; }
.close p { margin: 0; color: var(--ink-2); max-width: 44ch; }
.close .from { margin-top: 18px; font-size: 14px; color: var(--ink-3); }
.close .from a { color: var(--ink-2); }
.close-cta { text-align: left; }

/* Footer */
.foot { border-top: 1px solid var(--line); padding: 22px 0 40px; display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 13px; color: var(--ink-3); }
.foot a { color: var(--ink-3); text-decoration: none; }
.foot a:hover { color: var(--ink); }
.foot .copy { margin-right: auto; }

/* Reveal (only when JS runs and motion is allowed) */
.js-reveal [data-reveal] { opacity: 0; transform: translateY(12px); transition: opacity 650ms var(--ease), transform 650ms var(--ease); }
.js-reveal [data-reveal].in { opacity: 1; transform: none; }

@media (max-width: 900px) {
  .hero { grid-template-columns: 1fr; gap: 28px; padding: 64px 0 44px; }
  .section-head { flex-direction: column; gap: 6px; align-items: flex-start; }
  .pair-grid { grid-template-columns: 1fr; gap: 36px; margin-top: 36px; }
  .how-grid { grid-template-columns: 1fr; gap: 28px; }
  .close-inner { grid-template-columns: 1fr; gap: 28px; }
}
@media (max-width: 600px) {
  :root { --gutter: 18px; }
  body { font-size: 16px; }
  .top { padding-top: 20px; }
  .wordmark { font-size: 25px; }
  .hero { padding: 48px 0 36px; }
  h1 { font-size: clamp(40px, 11.5vw, 48px); }
  .lede { font-size: 17px; }
  .btn { width: 100%; justify-content: center; padding: 16px 20px; }
  .cmp-stage { border-radius: 3px; }
  figcaption { flex-wrap: wrap; gap: 6px 12px; font-size: 14px; }
  figcaption .note { margin-left: 0; text-align: left; max-width: none; flex-basis: 100%; }
  .how { padding-top: 56px; }
  .close { padding: 56px 0 48px; }
}
@media (prefers-reduced-motion: reduce) {
  .btn, .cmp-knob, .cmp-tag, .top-link { transition: none; }
  .js-reveal [data-reveal] { opacity: 1; transform: none; transition: none; }
}
`;

const JS = `
(function () {
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var canAnimateVar = !!(window.CSS && CSS.registerProperty);

  function setupCompare(box) {
    var range = box.querySelector("input[type=range]");
    var dragging = false, hint = null;
    function render() {
      box.style.setProperty("--pos", range.value + "%");
      range.setAttribute("aria-valuetext", range.value + "% before, " + (100 - range.value) + "% after");
    }
    function stopHint() { if (hint) { hint.cancel(); hint = null; } }
    function pct(e) {
      var b = box.getBoundingClientRect();
      return Math.max(0, Math.min(100, ((e.clientX - b.left) / b.width) * 100));
    }
    // Touch: wait for clear horizontal intent before taking the gesture, so a
    // thumb scrolling the page past a slider never moves the handle. Mouse
    // commits on press. A plain tap jumps the handle to the tap point.
    var pending = null;
    function begin(e) {
      stopHint();
      dragging = true;
      box.classList.add("is-dragging");
      try { box.setPointerCapture(e.pointerId); } catch (_) {}
      range.value = String(Math.round(pct(e)));
      render();
    }
    box.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse") {
        if (e.button !== 0) return;
        e.preventDefault();
        begin(e);
      } else {
        pending = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
    });
    box.addEventListener("pointermove", function (e) {
      if (pending && e.pointerId === pending.id) {
        var dx = e.clientX - pending.x, dy = e.clientY - pending.y;
        if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) { pending = null; begin(e); }
        else if (Math.abs(dy) > 6) { pending = null; }
        return;
      }
      if (!dragging) return;
      range.value = String(Math.round(pct(e)));
      render();
    });
    function end(e) {
      if (pending && e && e.type === "pointerup" && e.pointerId === pending.id) {
        stopHint();
        range.value = String(Math.round(pct(e)));
        render();
      }
      pending = null;
      dragging = false;
      box.classList.remove("is-dragging");
    }
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", end);
    box.addEventListener("lostpointercapture", end);
    range.addEventListener("input", function () { stopHint(); render(); });
    range.addEventListener("focus", function () { box.classList.add("is-focus"); });
    range.addEventListener("blur", function () { box.classList.remove("is-focus"); });
    render();
    // One-time nudge on the first slider so the handle reads as draggable.
    box.hintOnce = function () {
      if (reduce || !canAnimateVar || hint || box.dataset.hinted) return;
      box.dataset.hinted = "1";
      hint = box.animate(
        [{ "--pos": "50%" }, { "--pos": "42%", offset: 0.45 }, { "--pos": "50%" }],
        { duration: 1500, delay: 500, easing: "cubic-bezier(0.45, 0, 0.2, 1)" }
      );
      hint.onfinish = function () { hint = null; };
    };
  }
  var boxes = document.querySelectorAll("[data-cmp]");
  for (var i = 0; i < boxes.length; i++) setupCompare(boxes[i]);

  if ("IntersectionObserver" in window && !reduce) {
    document.documentElement.classList.add("js-reveal");
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add("in");
        io.unobserve(en.target);
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    var items = document.querySelectorAll("[data-reveal]");
    for (var j = 0; j < items.length; j++) io.observe(items[j]);
  }
  if (boxes[0] && boxes[0].hintOnce) {
    if ("IntersectionObserver" in window) {
      var first = new IntersectionObserver(function (entries) {
        if (entries[0] && entries[0].isIntersecting) { boxes[0].hintOnce(); first.disconnect(); }
      }, { threshold: 0.6 });
      first.observe(boxes[0]);
    } else { boxes[0].hintOnce(); }
  }
})();
`;

const CHEVRONS = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5 3 10l5 5M12 5l5 5-5 5"/></svg>`;
const APPLE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.6 12.7c0-2.5 2-3.6 2.1-3.7-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.3.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.8-1.1-2.8-4.2ZM14.2 5.4c.7-.8 1.2-2 1-3.2-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1.1 3.1 1.1.1 2.3-.6 3-1.4Z"/></svg>`;

function figure(p: DemoPair, index: number): string {
  const eager = index === 0;
  const after = `/demo/img/${p.slug}-after.jpg`;
  const before = `/demo/img/${p.slug}-before.jpg`;
  const roomLower = p.room.toLowerCase();
  const n = String(index + 1).padStart(2, "0");
  return `<figure class="cmp"${eager ? "" : ' data-reveal'}>
  <div class="cmp-stage" data-cmp style="--ar: ${p.width} / ${p.height}">
    <img class="cmp-after" src="${after}" width="${p.width}" height="${p.height}" alt="${esc(`${p.room} after virtual staging in a ${p.style.toLowerCase()} style`)}" loading="${eager ? "eager" : "lazy"}" decoding="async"${eager ? ' fetchpriority="high"' : ""} draggable="false">
    <img class="cmp-before" src="${before}" width="${p.width}" height="${p.height}" alt="${esc(`The same ${roomLower}, empty, before staging`)}" loading="${eager ? "eager" : "lazy"}" decoding="async" draggable="false">
    <span class="cmp-tag cmp-tag-before" aria-hidden="true">Before</span>
    <span class="cmp-tag cmp-tag-after" aria-hidden="true">After</span>
    <div class="cmp-handle" aria-hidden="true"><span class="cmp-knob">${CHEVRONS}</span></div>
    <input class="cmp-range" type="range" min="0" max="100" step="1" value="50" aria-label="${esc(`Compare the ${roomLower} before and after staging`)}" aria-valuetext="50% before, 50% after">
  </div>
  <figcaption><span class="num">${n}</span><b>${esc(p.room)}</b><span>${esc(p.style)}</span><span class="note">${esc(p.note)}</span></figcaption>
</figure>`;
}

export function renderDemoPage(base: string): string {
  const [first, ...rest] = DEMO_PAIRS;
  const title = "Stagewell · Virtual staging from a phone photo";
  const description = "Photograph an empty room, pick a style, and get a furnished, listing-ready photo back in about a minute. Three real before-and-after examples.";
  const url = `${base}/`;
  const ogImage = `${base}/demo/img/living-after.jpg`;
  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#F5F2EC">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Stagewell">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<link rel="preload" href="/demo/fonts/instrument-serif-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/demo/img/living-after.jpg" as="image">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <a class="wordmark" href="/">Stagewell</a>
    <a class="top-link" href="${APP_STORE_URL}?ct=demo">Free on the App Store</a>
  </header>

  <section class="hero">
    <div>
      <p class="eyebrow">Virtual staging for listing agents</p>
      <h1>Empty rooms, staged from <em>one phone photo.</em></h1>
    </div>
    <div>
      <p class="lede">Photograph the empty room, pick a style, and get a furnished, listing-ready photo back in about a minute. No photographer, no furniture rental.</p>
      <a class="btn" href="${APP_STORE_URL}?ct=demo">${APPLE}Get Stagewell on the App Store</a>
      <p class="fine">Your first 3 stagings are free. No card required.</p>
    </div>
  </section>

  <section class="examples" aria-labelledby="examples-h">
    <div class="section-head">
      <h2 id="examples-h">Three rooms, before and after</h2>
      <p>Drag the handle. Each photo was staged with Stagewell from the empty room on the left.</p>
    </div>
    ${figure(first!, 0)}
    <div class="pair-grid">
      ${rest.map((p, i) => figure(p, i + 1)).join("\n      ")}
    </div>
  </section>

  <section class="how" aria-labelledby="how-h" data-reveal>
    <div class="section-head">
      <h2 id="how-h">How it works</h2>
      <p>From a photo on your phone to a listing-ready photo.</p>
    </div>
    <div class="how-grid">
      <div class="step">
        <p class="n">1</p>
        <h3>Photograph the empty room</h3>
        <p>Shoot it in the app or pick a photo from your camera roll. A phone camera is enough.</p>
      </div>
      <div class="step">
        <p class="n">2</p>
        <h3>Choose the room and a style</h3>
        <p>Living room, bedroom, kitchen, dining, bathroom or office, in modern, minimalist, traditional, coastal, industrial or Scandinavian.</p>
      </div>
      <div class="step">
        <p class="n">3</p>
        <h3>Download the staged photo</h3>
        <p>It comes back in about a minute. Save it to your library or send it to your MLS, clients and socials.</p>
      </div>
    </div>
  </section>

  <section class="close" aria-labelledby="close-h" data-reveal>
    <div class="close-inner">
      <div>
        <h2 id="close-h">Try it on your next empty listing.</h2>
        <p>Three stagings are free, no card required. Plans start at $19 a month after that. If the result is not good enough for the MLS, you have spent a minute and nothing else.</p>
        <p class="from">Built by Dillon Djie, a licensed California agent, for his own listings.</p>
      </div>
      <div class="close-cta">
        <a class="btn" href="${APP_STORE_URL}?ct=demo">${APPLE}Get Stagewell on the App Store</a>
        <p class="fine">Free to download on the App Store.</p>
      </div>
    </div>
  </section>

  <footer class="foot">
    <span class="copy">© ${year} PYKLE LLC</span>
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
    <a href="/contact">Contact</a>
  </footer>
</div>
<script>${JS}</script>
</body>
</html>`;
}

/** GET /demo/img/:file — serves the curated demo photos (allowlisted names only). */
export async function serveDemoImage(file: string): Promise<Response> {
  if (!DEMO_FILE_RE.test(file)) return new Response("Not found", { status: 404 });
  const f = Bun.file(new URL(file, DEMO_DIR));
  if (!(await f.exists())) return new Response("Not found", { status: 404 });
  return new Response(f, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
  });
}

/** GET /demo/fonts/:file — self-hosted display face (allowlisted names only). */
export async function serveDemoFont(file: string): Promise<Response> {
  if (!DEMO_FONT_RE.test(file)) return new Response("Not found", { status: 404 });
  const f = Bun.file(new URL(`fonts/${file}`, DEMO_DIR));
  if (!(await f.exists())) return new Response("Not found", { status: 404 });
  return new Response(f, {
    headers: {
      "Content-Type": "font/woff2",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
