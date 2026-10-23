#!/usr/bin/env node
// Headless Chrome checks for the site. Usage:
//   node tests/check.mjs <url> [--shots <dir>] [--only <check-name>]
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTHS = [1440, 1024, 768, 390, 320];
const SCHEMES = ["light", "dark"];
const SECTION_IDS = ["intro", "ethos", "what-i-do", "experience", "skills", "education", "contact"];

const argv = process.argv.slice(2);
const url = argv.find((a, i) => !a.startsWith("--") && !["--shots", "--only"].includes(argv[i - 1]));
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const shotsDir = flag("--shots");
const only = flag("--only");
if (!url) {
  console.error("usage: node tests/check.mjs <url> [--shots <dir>] [--only <check-name>]");
  process.exit(2);
}

const checks = [];
const check = (name, matrix, fn) => checks.push({ name, matrix, fn });
const at = (widths, schemes = SCHEMES, extra = {}) =>
  widths.flatMap(width => schemes.map(scheme => ({ width, scheme, ...extra })));
const all = at(WIDTHS);

function assert(cond, reason) {
  if (!cond) throw new Error(reason);
}

// ---------- CDP plumbing ----------

let ws;
let nextId = 0;
const pending = new Map();
const listeners = new Set();

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "site-check-"));
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch {}
  }
  if (!port) throw new Error(`Chrome did not start (${CHROME})`);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
  ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  return async () => {
    ws.close();
    const exited = once(proc, "exit");
    proc.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    pending.set(++nextId, { resolve, reject });
    ws.send(JSON.stringify({ id: nextId, method, params }));
  });
}

function waitFor(method, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(l); reject(new Error(`timeout waiting for ${method}`)); }, timeout);
    const l = msg => { if (msg.method === method) { clearTimeout(timer); listeners.delete(l); resolve(msg.params); } };
    listeners.add(l);
  });
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(`evaluate failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  return res.result.value;
}

async function scrollSettled() {
  let last = -1, stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    await sleep(100);
    const y = await evaluate("scrollY");
    stable = y === last ? stable + 1 : 0;
    last = y;
  }
}

async function withPage({ width, height, scheme = "light", reducedMotion = false, js = true }, fn) {
  const mobile = width < 600;
  await send("Emulation.setDeviceMetricsOverride", { width, height: height ?? (mobile ? 844 : 900), deviceScaleFactor: 1, mobile });
  await send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-color-scheme", value: scheme },
    { name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" },
  ] });
  await send("Emulation.setScriptExecutionDisabled", { value: !js });
  const errors = [];
  const onError = msg => {
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") errors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ""}`.trim());
  };
  listeners.add(onError);
  try {
    const loaded = waitFor("Page.loadEventFired");
    await send("Page.navigate", { url });
    await loaded;
    await evaluate("document.fonts.ready.then(() => true)");
    await sleep(300);
    return await fn({ errors, width });
  } finally {
    listeners.delete(onError);
  }
}

// ---------- checks ----------

check("no console errors", all, async ({ errors }) => {
  await sleep(500);
  assert(errors.length === 0, errors.join(" | "));
});

check("no horizontal overflow", all, async ({ width }) => {
  const sw = await evaluate("document.documentElement.scrollWidth");
  assert(sw <= width, `scrollWidth ${sw} > viewport ${width}`);
});

check("sections in order", all, async () => {
  const ids = await evaluate("[...document.querySelectorAll('main > section')].map(s => s.id)");
  assert(JSON.stringify(ids) === JSON.stringify(SECTION_IDS), `got ${JSON.stringify(ids)}`);
});

check("images load", all, async () => {
  const broken = await evaluate("[...document.images].filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src)");
  assert(broken.length === 0, `broken: ${broken.join(", ")}`);
});

check("theme colours", at([1440]), async () => {
  const expected = {
    light: { bg: "rgb(228, 236, 234)", accent: "rgb(13, 119, 107)" },
    dark: { bg: "rgb(11, 13, 16)", accent: "rgb(45, 212, 191)" },
  };
  const scheme = await evaluate("matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'");
  const bg = await evaluate("getComputedStyle(document.body).backgroundColor");
  const accent = await evaluate("(e => e && getComputedStyle(e).color)(document.querySelector('.hero-beats'))");
  assert(bg === expected[scheme].bg, `body background ${bg}, want ${expected[scheme].bg}`);
  assert(accent === expected[scheme].accent, `.hero-beats colour ${accent}, want ${expected[scheme].accent}`);
});

check("header links follow page order", at([1440], ["light"]), async () => {
  const links = await evaluate("[...document.querySelectorAll('.site-nav a')].map(a => a.getAttribute('href') + ' ' + a.textContent.trim())");
  const want = ["#ethos Ethos", "#what-i-do What I do", "#experience Experience", "#skills Skills", "#contact Contact"];
  assert(JSON.stringify(links) === JSON.stringify(want), `header links ${JSON.stringify(links)}`);
  const ethosDot = await evaluate("document.querySelector('.dot[href=\"#ethos\"]')?.getAttribute('aria-label')");
  assert(ethosDot === "Ethos", `ethos dot label ${ethosDot}`);
});

check("ethos is a short beat", at([1440, 390]), async () => {
  const [h, vh, textBottom] = await evaluate("(s => [s.offsetHeight, innerHeight, s.querySelector('.about-text').getBoundingClientRect().bottom - s.getBoundingClientRect().top])(document.getElementById('ethos'))");
  assert(h >= vh * 0.4 && h <= vh * 0.7, `#ethos is ${h}px tall in a ${vh}px viewport, want 40-70%`);
  assert(textBottom < h, "Ethos text overflows its section");
});

check("what i do has no subtitle", at([1440], ["light"]), async () => {
  const subs = await evaluate("document.querySelectorAll('#what-i-do .sub').length");
  assert(subs === 0, `${subs} subtitle(s) in #what-i-do`);
  const gap = await evaluate("document.querySelector('#what-i-do .cards').getBoundingClientRect().top - document.querySelector('#what-i-do h2').getBoundingClientRect().bottom");
  assert(gap >= 24, `only ${gap}px between the heading and the cards`);
});

check("intro diagram is decorative and behind the text", at([1440, 390]), async () => {
  const info = await evaluate(`(() => {
    const svg = document.querySelector('#intro svg.arch');
    if (!svg) return null;
    const cs = getComputedStyle(svg);
    const hit = sel => { const r = document.querySelector(sel).getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && !e.closest('svg.arch'); };
    return { hidden: svg.getAttribute('aria-hidden'), pointer: cs.pointerEvents, focusable: svg.querySelectorAll('a, [tabindex]').length, h1: hit('#intro h1'), lead: hit('#intro .lead'), cta: hit('#intro .pill-primary') };
  })()`);
  assert(info, "no diagram in #intro");
  assert(info.hidden === "true", `aria-hidden ${info.hidden}`);
  assert(info.pointer === "none", `pointer-events ${info.pointer}`);
  assert(info.focusable === 0, "diagram contains focusable elements");
  assert(info.h1 && info.lead && info.cta, `diagram covers text or buttons: ${JSON.stringify(info)}`);
});

check("photo and name scroll back to top", at([1440, 390]), async () => {
  await evaluate("window.scrollTo({ top: document.getElementById('skills').offsetTop, behavior: 'instant' })");
  await scrollSettled();
  await evaluate("document.querySelector('.brand-home').click()");
  await scrollSettled();
  const y = await evaluate("scrollY");
  assert(y <= 2, `scrollY ${y} after clicking the photo and name`);
});

check("dots match sections", at([1440], ["light"]), async () => {
  const dots = await evaluate("[...document.querySelectorAll('.dot')].map(d => [d.getAttribute('href'), d.getAttribute('aria-label')])");
  assert(dots.length === SECTION_IDS.length, `${dots.length} dots`);
  dots.forEach(([href, label], i) => {
    assert(href === `#${SECTION_IDS[i]}`, `dot ${i} href ${href}`);
    assert(label && label.trim(), `dot ${i} has no aria-label`);
  });
});

check("copy is exact", at([1440], ["light"]), async () => {
  const text = sel => evaluate(`(e => e && e.innerText.trim().replace(/\\n+/g, "\\n"))(document.querySelector(${JSON.stringify(sel)}))`);
  const expect = {
    "h1": "Cloud Platforms\nCodified. Secured. Scaled.",
    "#contact h2": "Let's talk platforms.",
    ".about-text": "Good platforms are invisible. They are codified, secured and scaled before anyone notices. Developers simply ship.",
    ".name-full": "Ravi Devarakonda",
    "#ethos .eyebrow": "ETHOS",
    "#intro .eyebrow": "SENIOR DEVOPS ENGINEER",
    "#intro .lead": "Kubernetes on AWS, infrastructure as code, CI/CD, observability and edge security at GLS/NXT in Berlin, Germany.",
    "#experience .is-current .timeline-body p:not(.timeline-org)": "Owning DevOps end to end for a parcel and logistics platform on AWS, with full ownership of platform engineering, delivery, SRE and security. Running EKS across dev, staging and prod with Karpenter autoscaling and Terraform, shipping through GitHub Actions and Helm, keeping production observable and cost-aware with Datadog, and securing the edge and software supply chain with Cloudflare WAF, Kyverno, Dependency-Track/Trivy and Teleport.",
  };
  for (const [sel, want] of Object.entries(expect)) {
    const got = await text(sel);
    assert(got === want, `${sel}: ${JSON.stringify(got)}`);
  }
  const short = await evaluate("(e => e && e.textContent.trim())(document.querySelector('.name-short'))");
  assert(short === "Ravi D", `.name-short: ${JSON.stringify(short)}`);
});

check("links are correct", at([1440], ["light"]), async () => {
  const hrefs = await evaluate("[...document.querySelectorAll('.icon-link')].map(a => a.getAttribute('href'))");
  const want = ["mailto:ravi041282@gmail.com", "https://github.com/ravi-devarakonda", "https://www.linkedin.com/in/ravidevarakonda/", "https://ravidevarakonda.link"];
  assert(JSON.stringify(hrefs) === JSON.stringify(want), `icon links ${JSON.stringify(hrefs)}`);
  const home = await evaluate("(a => a && [a.getAttribute('href'), !!a.querySelector('img.avatar'), !!a.querySelector('.name'), a.getAttribute('aria-label')])(document.querySelector('.brand-home'))");
  assert(home && home[0] === "#intro" && home[1] && home[2], `photo and name are not one link to #intro: ${JSON.stringify(home)}`);
  assert(home[3] === "Ravi Devarakonda, back to top", `brand link label ${home[3]}`);
  assert(await evaluate("document.querySelectorAll('ion-icon').length === 0"), "ion-icon elements present");
});

check("meta tags", at([1440], ["light"]), async () => {
  const title = await evaluate("document.title");
  assert(title === "Ravi Devarakonda - Senior DevOps Engineer", `title ${title}`);
  const og = await evaluate("document.querySelector('meta[property=\"og:image\"]')?.content");
  assert(og && og.endsWith("/assets/images/avatar.png"), `og:image ${og}`);
});

check("page works without JavaScript", at([1440, 390], ["light"], { js: false }), async () => {
  const hidden = await evaluate("[...document.querySelectorAll('main > section')].filter(s => !s.offsetHeight || getComputedStyle(s).display === 'none').map(s => s.id)");
  assert(hidden.length === 0, `hidden sections: ${hidden.join(", ")}`);
  const blankIcons = await evaluate("[...document.querySelectorAll('.icon-link svg')].filter(s => !s.getBoundingClientRect().width).length");
  assert(blankIcons === 0, `${blankIcons} icon(s) have no width`);
  await evaluate("document.querySelector('a[href=\"#experience\"]').click()");
  await scrollSettled();
  const top = await evaluate("document.getElementById('experience').getBoundingClientRect().top");
  assert(Math.abs(top) <= 4, `#experience top ${top}`);
});

check("scrollbar hidden, free scrolling", at([1440], ["light"]), async () => {
  const [sw, snap] = await evaluate("(s => [s.scrollbarWidth, s.scrollSnapType])(getComputedStyle(document.documentElement))");
  assert(sw === "none", `scrollbar-width ${sw}`);
  assert(snap === "none", `scroll-snap-type ${snap}`);
  const short = await evaluate("[...document.querySelectorAll('main > section:not(#ethos)')].filter(s => s.offsetHeight < innerHeight).map(s => s.id)");
  assert(short.length === 0, `sections shorter than the viewport: ${short.join(", ")}`);
});

check("wheel scroll stays where it stops", at([1440, 390], ["light"]), async ({ width }) => {
  const height = width < 600 ? 844 : 900;
  await evaluate("window.__ys = []; (function f() { __ys.push(Math.round(scrollY)); if (__ys.length < 90) requestAnimationFrame(f); })(); true");
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: width / 2, y: height / 2, deltaX: 0, deltaY: 120 });
  await sleep(1800);
  const ys = await evaluate("__ys");
  const final = ys.at(-1);
  const backwards = ys.slice(1).filter((y, i) => y < ys[i]).length;
  assert(final >= 100, `one wheel notch ended at scrollY ${final}`);
  assert(backwards === 0, `scroll moved backwards ${backwards} time(s): ${ys.join(" ")}`);
});

function luminance(rgb) {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

check("contrast", at([1440]), async () => {
  const bg = await evaluate("getComputedStyle(document.body).backgroundColor");
  const org = await evaluate("getComputedStyle(document.querySelector('.timeline-org')).color");
  const ratio = contrast(org, bg);
  assert(ratio >= 4.5, `.timeline-org ${org} on ${bg} is ${ratio.toFixed(2)}:1`);
  const dot = await evaluate("(d => d && getComputedStyle(d).backgroundColor)(document.querySelector('.dot.is-active'))");
  assert(dot, "no active dot");
  const dotRatio = contrast(dot, bg);
  assert(dotRatio >= 3, `active dot ${dot} on ${bg} is ${dotRatio.toFixed(2)}:1`);
  const idle = await evaluate("getComputedStyle(document.querySelector('.dot:not(.is-active)')).backgroundColor");
  const idleRatio = contrast(idle, bg);
  assert(idleRatio >= 3, `inactive dot ${idle} on ${bg} is ${idleRatio.toFixed(2)}:1`);
});

const visible = sel => evaluate(`(e => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0)(document.querySelector(${JSON.stringify(sel)}))`);

check("header fits at 320", at([390, 320]), async () => {
  const [sw, cw] = await evaluate("(h => [h.scrollWidth, h.clientWidth])(document.querySelector('.site-header'))");
  assert(sw <= cw, `header scrollWidth ${sw} > clientWidth ${cw}`);
  assert(!(await visible(".name-full")), ".name-full visible");
  assert(await visible(".name-short"), ".name-short hidden");
  assert(!(await visible(".btn-contact-text")), ".btn-contact-text visible");
  assert(await visible(".btn-contact-icon"), ".btn-contact-icon hidden");
  const links = await evaluate("[...document.querySelectorAll('.site-nav a:not(.btn-contact)')].filter(a => getComputedStyle(a).display !== 'none').length");
  assert(links === 0, `${links} text link(s) visible`);
});

check("desktop header", at([1440, 1024]), async () => {
  assert(await visible(".name-full"), ".name-full hidden");
  assert(!(await visible(".name-short")), ".name-short visible");
  assert(await visible(".btn-contact-text"), ".btn-contact-text hidden");
});

check("last experience entry reachable at 390", at([390, 320], ["light"]), async () => {
  await evaluate("document.querySelector('#experience .timeline-item:last-child').scrollIntoView({ block: 'end', behavior: 'instant' })");
  await scrollSettled();
  const [top, bottom, vh, header] = await evaluate("(r => [r.top, r.bottom, innerHeight, document.querySelector('.site-header').getBoundingClientRect().bottom])(document.querySelector('#experience .timeline-item:last-child').getBoundingClientRect())");
  assert(bottom <= vh + 1, `bottom ${bottom} > viewport ${vh}`);
  assert(top >= header, `top ${top} hidden under header (${header})`);
});

check("grids collapse", at([1440, 768, 390], ["light"]), async ({ width }) => {
  const tracks = sel => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).gridTemplateColumns.split(' ').length`);
  const want = { 1440: [2, 3], 768: [2, 2], 390: [1, 1] }[width];
  const got = [await tracks(".cards"), Number(await evaluate("getComputedStyle(document.querySelector('.skill-grid')).columnCount"))];
  assert(JSON.stringify(got) === JSON.stringify(want), `cards/skills columns ${got}, want ${want}`);
});

check("phone timeline", at([390]), async () => {
  const [dateBottom, bodyTop] = await evaluate("(i => [i.querySelector('.timeline-date').getBoundingClientRect().bottom, i.querySelector('.timeline-body').getBoundingClientRect().top])(document.querySelector('#experience .timeline-item'))");
  assert(dateBottom <= bodyTop + 1, `date bottom ${dateBottom} > body top ${bodyTop}`);
});

const activeDots = () => evaluate("[...document.querySelectorAll('.dot')].map((d, i) => d.classList.contains('is-active') ? i + ':' + d.getAttribute('aria-current') : null).filter(Boolean)");

check("dots navigate", at([1440, 390]), async () => {
  for (let i = 0; i < SECTION_IDS.length; i++) {
    await evaluate(`document.querySelectorAll('.dot')[${i}].click()`);
    await scrollSettled();
    const top = await evaluate(`document.getElementById(${JSON.stringify(SECTION_IDS[i])}).getBoundingClientRect().top`);
    assert(Math.abs(top) <= 4, `${SECTION_IDS[i]} top ${top} after clicking its dot`);
    const active = await activeDots();
    assert(JSON.stringify(active) === JSON.stringify([`${i}:true`]), `active dots ${JSON.stringify(active)} after clicking dot ${i}`);
  }
});

check("wheel scrolling updates dots", at([1440], ["light"]), async () => {
  await evaluate("window.scrollTo({ top: document.getElementById('skills').offsetTop, behavior: 'instant' })");
  await scrollSettled();
  await sleep(200);
  const active = await activeDots();
  assert(JSON.stringify(active) === JSON.stringify([`${SECTION_IDS.indexOf("skills")}:true`]), `active dots ${JSON.stringify(active)}`);
});

async function pressTab() {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  }
}

check("dots are focusable with visible focus", at([1440]), async () => {
  const accent = await evaluate("getComputedStyle(document.querySelector('.hero-beats')).color");
  const reached = new Set();
  for (let n = 0; n < 60 && reached.size < SECTION_IDS.length; n++) {
    await pressTab();
    const info = await evaluate("(e => e && e.classList.contains('dot') ? [[...document.querySelectorAll('.dot')].indexOf(e), getComputedStyle(e).outlineStyle, getComputedStyle(e).outlineColor] : null)(document.activeElement)");
    if (!info) continue;
    const [i, style, color] = info;
    assert(style !== "none", `dot ${i} focused without an outline`);
    assert(color === accent, `dot ${i} outline ${color}, want ${accent}`);
    reached.add(i);
  }
  assert(reached.size === SECTION_IDS.length, `Tab reached ${reached.size} of ${SECTION_IDS.length} dots`);
});

check("reduced motion", at([1440], ["light"], { reducedMotion: true }), async () => {
  const behavior = await evaluate("getComputedStyle(document.documentElement).scrollBehavior");
  assert(behavior === "auto", `scroll-behavior ${behavior}`);
  const top = await evaluate("new Promise(r => { document.querySelector('.dot[href=\"#contact\"]').click(); requestAnimationFrame(() => r(document.getElementById('contact').getBoundingClientRect().top)); })");
  assert(Math.abs(top) <= 4, `#contact top ${top} one frame after clicking its dot`);
});

check("assets are cache-busted", at([1440], ["light"]), async () => {
  const urls = await evaluate("[...document.querySelectorAll('link[rel=stylesheet][href^=\"./assets\"], script[src^=\"./assets\"], img[src^=\"./assets\"]')].map(e => e.getAttribute('href') ?? e.getAttribute('src'))");
  const missing = urls.filter(u => !/\?v=\d+$/.test(u));
  assert(missing.length === 0, `no ?v=: ${missing.join(", ")}`);
  const version = name => Number(urls.find(u => u.includes(name))?.match(/\?v=(\d+)/)?.[1]);
  assert(version("style.css") >= 5, `style.css v${version("style.css")}`);
  assert(version("script.js") >= 3, `script.js v${version("script.js")}`);
});

check("header does not crowd at tablet widths", at([768, 700, 640, 601], ["light"]), async () => {
  const [bsw, bcw] = await evaluate("(b => [b.scrollWidth, b.clientWidth])(document.querySelector('.brand'))");
  assert(bsw <= bcw, `brand scrollWidth ${bsw} > clientWidth ${bcw}`);
  const wrapped = await evaluate("[...document.querySelectorAll('.site-nav a')].filter(a => getComputedStyle(a).display !== 'none' && a.getClientRects().length > 1).map(a => a.textContent.trim())");
  assert(wrapped.length === 0, `wrapped nav links: ${wrapped.join(", ")}`);
  const [brandRight, navLeft] = await evaluate("[document.querySelector('.brand').getBoundingClientRect().right, document.querySelector('.site-nav').getBoundingClientRect().left]");
  assert(brandRight <= navLeft, `brand ends at ${brandRight}, nav starts at ${navLeft}`);
});

check("dots clear the content", at([1440, 1024, 768, 640, 390, 320], ["light"]), async () => {
  const [dotsLeft, overlaps] = await evaluate(`(() => {
    const left = document.querySelector('.dots').getBoundingClientRect().left;
    const hits = [...document.querySelectorAll('main > section .wrap')].filter(w => w.getBoundingClientRect().right > left).map(w => w.parentElement.id);
    return [left, hits];
  })()`);
  assert(overlaps.length === 0, `content runs under the dots (left ${dotsLeft}) in: ${overlaps.join(", ")}`);
});

async function pressKey(key, code, keyCode) {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}) });
  }
}

check("keyboard jump moves focus", at([1440], ["light"]), async () => {
  await evaluate("document.querySelector('#intro .pill-primary').focus()");
  await pressKey("Enter", "Enter", 13);
  await scrollSettled();
  await pressKey("Tab", "Tab", 9);
  const where = await evaluate("(e => e ? (e.closest('section')?.id ?? e.tagName) : null)(document.activeElement)");
  assert(where === "contact", `Tab after activating "Get in touch" focused something in ${where}`);
});

check("phone dots are easy to tap", at([390, 320], ["light"]), async () => {
  const centres = await evaluate("[...document.querySelectorAll('.dot:not(.is-active)')].map(d => (r => r.top + r.height / 2)(d.getBoundingClientRect()))");
  const pitches = centres.slice(1).map((c, i) => c - centres[i]);
  const tight = pitches.filter(p => p < 24);
  assert(tight.length === 0, `dot spacing ${pitches.map(p => p.toFixed(1)).join(", ")}px, want >= 24`);
});

check("skills use theme chips", at([1440]), async () => {
  const imgs = await evaluate("document.querySelectorAll('#skills img').length");
  assert(imgs === 0, `${imgs} badge image(s) in #skills`);
  const chips = await evaluate("[...document.querySelectorAll('#skills .skill-chip')].map(c => c.textContent.trim())");
  const want = ["AWS", "GCP", "Oracle Cloud (OCI)", "Docker", "Kubernetes", "Karpenter", "Helm", "Terraform", "Ansible", "GitHub Actions", "GitLab CI", "Argo CD", "Datadog", "Prometheus", "Grafana", "Cloudflare WAF", "Kyverno", "Trivy", "Dependency-Track", "Teleport"];
  assert(JSON.stringify(chips) === JSON.stringify(want), `chips ${JSON.stringify(chips)}`);
  const [chipColour, fg, chipBg, surface] = await evaluate("[getComputedStyle(document.querySelector('.skill-chip')).color, getComputedStyle(document.body).color, getComputedStyle(document.querySelector('.skill-chip')).backgroundColor, getComputedStyle(document.querySelector('.skill-tile')).backgroundColor]");
  assert(chipColour === fg, `chip text ${chipColour}, want page text ${fg}`);
  assert(chipBg !== "rgba(0, 0, 0, 0)" && chipBg !== surface, `chip background ${chipBg} does not stand off the tile ${surface}`);
  const logos = await evaluate("[...document.querySelectorAll('#skills .skill-chip svg')].map(s => s.closest('.skill-chip').textContent.trim() + ':' + (getComputedStyle(s).color === getComputedStyle(s.parentElement).color && s.getBoundingClientRect().width > 0))");
  const wantLogos = ["Docker", "Kubernetes", "Helm", "Terraform", "Ansible", "GitHub Actions", "GitLab CI", "Argo CD", "Datadog", "Prometheus", "Grafana", "Cloudflare WAF", "Trivy", "Dependency-Track"].map(n => n + ":true");
  assert(JSON.stringify(logos) === JSON.stringify(wantLogos), `logos ${JSON.stringify(logos)}`);
});

check("skill chips are uniform", at([1440]), async () => {
  const odd = await evaluate(`(() => {
    const chips = [...document.querySelectorAll('#skills .skill-chip')];
    const ref = getComputedStyle(chips[0]);
    const keys = ['fontSize', 'fontWeight', 'borderTopColor', 'backgroundColor', 'color', 'borderTopLeftRadius', 'paddingTop'];
    return chips.filter(c => keys.some(k => getComputedStyle(c)[k] !== ref[k])).map(c => c.textContent.trim())
      .concat(document.querySelectorAll('#skills .is-primary, #skills .is-sub, #skills .k-group').length ? ['special chip markup'] : []);
  })()`);
  assert(odd.length === 0, `chips styled differently: ${odd.join(", ")}`);
});

check("skill card titles have icons", at([1440]), async () => {
  const titles = await evaluate("[...document.querySelectorAll('#skills .skill-tile h3')].map(h => [h.textContent.trim(), !!h.querySelector('svg.t-icon'), h.querySelector('svg.t-icon') && getComputedStyle(h.querySelector('svg.t-icon')).color])");
  const accent = await evaluate("getComputedStyle(document.querySelector('.hero-beats')).color");
  const want = ["Cloud", "Containers & orchestration", "Infrastructure as code", "CI/CD & GitOps", "Observability", "Security & access"];
  assert(JSON.stringify(titles.map(t => t[0])) === JSON.stringify(want), `titles ${JSON.stringify(titles.map(t => t[0]))}`);
  const bad = titles.filter(([, has, colour]) => !has || colour !== accent).map(t => t[0]);
  assert(bad.length === 0, `titles without an accent icon: ${bad.join(", ")}`);
});

check("skill cards do not stretch", at([1440], ["light"]), async () => {
  const gaps = await evaluate("[...document.querySelectorAll('#skills .skill-tile')].map(t => { const last = t.lastElementChild.getBoundingClientRect().bottom; return Math.round(t.getBoundingClientRect().bottom - last); })");
  const loose = gaps.filter(g => g > 40);
  assert(loose.length === 0, `empty space below card content: ${gaps.join(", ")}px`);
});

check("favicon", at([1440], ["light"]), async () => {
  const icons = await evaluate("[...document.querySelectorAll('link[rel~=icon], link[rel=apple-touch-icon]')].map(l => l.getAttribute('rel') + ' ' + l.getAttribute('href'))");
  assert(!icons.some(i => i.includes("logo.ico")), `old template icon still linked: ${icons.join(", ")}`);
  assert(icons.some(i => /^icon .*favicon-32\.png\?v=\d+$/.test(i)), `no 32px favicon: ${icons.join(", ")}`);
  assert(icons.some(i => /^apple-touch-icon .*apple-touch-icon\.png\?v=\d+$/.test(i)), `no apple-touch-icon: ${icons.join(", ")}`);
  const ok = await evaluate("Promise.all([...document.querySelectorAll('link[rel~=icon], link[rel=apple-touch-icon]')].map(l => fetch(l.href).then(r => r.ok && r.headers.get('content-type').startsWith('image/'))))");
  assert(ok.every(Boolean), `favicon files not served as images: ${JSON.stringify(ok)}`);
});

// ---------- runner ----------

const close = await launch();
let failed = 0;
try {
  for (const c of checks) {
    if (only && c.name !== only) continue;
    for (const combo of c.matrix) {
      const label = `${c.name} [${combo.width} ${combo.scheme}${combo.js === false ? " no-js" : ""}${combo.reducedMotion ? " reduced-motion" : ""}]`;
      try {
        await withPage(combo, c.fn);
        console.log(`PASS ${label}`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${label}: ${e.message}`);
      }
    }
  }

  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    for (const width of WIDTHS) {
      for (const scheme of SCHEMES) {
        await withPage({ width, scheme, reducedMotion: true }, async () => {
          const ids = await evaluate("[...document.querySelectorAll('main > section')].map(s => s.id)");
          for (const id of ids) {
            await evaluate(`window.scrollTo(0, document.getElementById(${JSON.stringify(id)}).offsetTop)`);
            await scrollSettled();
            const shot = await send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(shotsDir, `${width}-${scheme}-${id}.png`), Buffer.from(shot.data, "base64"));
          }
        });
      }
    }
    console.log(`screenshots written to ${shotsDir}`);
  }
} finally {
  await close();
}

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
