/**
 * page.fastObserve() / page.fastAct(obs, id, text?) on v2 Pages, ported from
 * the former v1 runtime (driver/fast.ts, removed in 2.3.0-linux.1). One browser
 * round-trip reads visible controls, their names/values, and the visible text
 * atomically. Node identities are page-owned integers; fastAct re-checks
 * freshness and occlusion before any input is dispatched.
 *
 * Changes from v1:
 *  - evaluate(expr)       → this.evaluate(expr)       (v2 Page method)
 *  - cdp(method, params)  → this.cdp(method, params)  (v2 Page method)
 *  - click([x, y])        → this.mouse.click(x, y)    (v2 Page.mouse)
 *  - scroll CDP wheel     → this.mouse.wheel(dx, dy)  (v2 Page.mouse)
 *  - Ctrl+A via raw CDP   → this.keyboard.press(…)    (v2 Page.keyboard)
 *  - Input.insertText     → this.keyboard.insertText  (v2 Page.keyboard)
 *  - Emulation.setFocusEmulationEnabled removed — v2 mouse.click activates
 */

export class StalePageError extends Error {
  constructor(message) {
    super(message);
    this.name = "StalePageError";
  }
}

const MAX_ACTIONS = 250;
const MAX_TEXT = 6000;

// Page-side snapshot. Kept as a string so bundling never rewrites it.
// Identical to v1's READ_STATE except the MAX_ACTIONS / MAX_TEXT constants are
// inlined at module load, matching v1's template-literal interpolation.
const READ_STATE = `(() => {
  if (!document.body) return null;
  const cache = window.__egoFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,${MAX_TEXT})||''];
  };
  const actions=[];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:name(e)||rname,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<${MAX_TEXT}) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\\n').slice(0,${MAX_TEXT}), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-${MAX_ACTIONS});
  actions.splice(${MAX_ACTIONS});
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions};
})()`;

const MARKER_EXPRESSION = `(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`;

// Resolve an observed node to its current center, rejecting covered, hidden,
// disabled, or off-viewport targets. Native <select> changes are applied here.
const RESOLVE_TARGET = `(action => {
  const e=window.__egoFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  if (!e.contains(document.elementFromPoint(x,y))) return null;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y};
})`;

// After input: two animation frames (50 ms cap), or for a combobox fill,
// until listbox options are visible (200 ms cap).
const SETTLE = `(action => new Promise(resolve => {
  const field=window.__egoFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve()};
  setTimeout(finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
      .split(/\\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const oneLine = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

export function formatTable(actions) {
  return actions
    .map((a) => {
      const flags = ["checked", "selected", "expanded"]
        .filter((key) => a[key] !== undefined)
        .map((key) => `${key}=${a[key]}`);
      const editable = a.kind === "fill" || a.role === "combobox";
      const value =
        a.kind === "select"
          ? a.current_value
          : editable
            ? a.value || "empty"
            : "";
      return [
        `[${a.id}]`,
        (a.kind === "fill" ? "fill " : "") + (a.role || a.kind),
        oneLine(a.label),
        value ? `· ${oneLine(value)}` : "",
        flags.join(" "),
      ]
        .filter(Boolean)
        .join("  ");
    })
    .join("\n");
}

/** Whether an error from page.evaluate is a navigation / staleness signal. */
function isStaleError(error) {
  const msg = error?.message || "";
  return (
    /JavaScript evaluation failed/.test(msg) ||
    /Execution context was destroyed/.test(msg) ||
    /Cannot find context with specified id/.test(msg) ||
    /Session closed/.test(msg)
  );
}

/**
 * Run a string expression in this v2 Page and re-throw evaluation/navigation
 * failures as StalePageError so callers can retry or surface the right message.
 * `this` must be the v2 Page.
 */
async function tryEvaluate(page, expression) {
  try {
    return await page.evaluate(expression);
  } catch (error) {
    if (isStaleError(error)) {
      throw new StalePageError("Document changed during evaluation");
    }
    throw error;
  }
}

/**
 * Observe the page as an indexed action table in one browser call (ported from
 * jev-ultrafast). Returns visible controls as `actions` (`e1`, `e2`, … plus
 * `scroll_down`/`scroll_up`/`wait`), their text form in `table`, and the
 * visible viewport text. Pass the whole result to `page.fastAct`. Password,
 * file, and hidden inputs are never listed. Shadow roots and iframes are not
 * read.
 *
 * @param {{ retries?: number }} [options]
 * @returns {Promise<{ url: string, title: string, text: string, table: string, actions: object[], omitted_actions: number, w: number, h: number, scroll: object }>}
 */
async function fastObserve(options = {}) {
  const retries = options?.retries ?? 10;
  for (let attempt = 0; ; attempt++) {
    try {
      const state = await tryEvaluate(this, READ_STATE);
      if (!state) throw new StalePageError("Document is navigating");
      state.table = formatTable(state.actions);
      return state;
    } catch (error) {
      if (!(error instanceof StalePageError) || attempt >= retries) throw error;
      await sleep(20);
    }
  }
}

async function isFresh(page, observation, action) {
  if (action.kind === "click" || action.kind === "select") {
    if (!Number.isInteger(action.node)) return false;
    const current = await tryEvaluate(
      page,
      `(() => { const c=window.__egoFast; return c ? [c.pageKey(),c.guard(c.nodes.get(${action.node}))] : null; })()`,
    );
    return (
      JSON.stringify(current) ===
      JSON.stringify([
        observation.page_key,
        observation.guards[String(action.node)] ?? null,
      ])
    );
  }
  return (
    JSON.stringify(await tryEvaluate(page, MARKER_EXPRESSION)) ===
    JSON.stringify(observation.marker)
  );
}

/**
 * Execute one action from a `page.fastObserve()` result by id. Refuses with a
 * `StalePageError` when the page, target, or its surrounding context changed
 * since the observation, or when the target is covered — observe again and
 * re-decide instead of retrying blindly. `fill` actions need `text`.
 *
 * @param {object} observation Result of page.fastObserve().
 * @param {string} id Action id such as "e3", "scroll_down", or "wait".
 * @param {string} [text] Text to type for a fill action (replaces the current value).
 * @param {{ settle?: boolean }} [options] settle=false skips the short post-input wait.
 * @returns {Promise<{ executed: string }>}
 */
async function fastAct(observation, id, text = undefined, options = {}) {
  const action = observation?.actions?.find((a) => a.id === id);
  if (!action) {
    throw new Error(
      `page.fastAct: no action "${id}" in this observation; use an id from page.fastObserve().actions`,
    );
  }
  if (action.kind === "fill" && typeof text !== "string") {
    throw new TypeError(`page.fastAct: fill action "${id}" requires text`);
  }
  if (!(await isFresh(this, observation, action))) {
    throw new StalePageError(
      "Page changed since this observation. Call page.fastObserve() again.",
    );
  }
  if (action.kind === "wait") {
    await sleep(100);
    return { executed: id };
  }
  if (action.kind === "scroll") {
    // v1 dispatched Input.dispatchMouseEvent(mouseWheel) via raw CDP. In
    // headless Chrome 148+, that command is unreliable on file:// pages:
    // the renderer freezes its input queue while doing large-layout reflows
    // and the event times out, so the scroll is done in the page instead.
    // Scroll what a wheel at the viewport centre would: the nearest ancestor
    // of the element there that can still scroll that way, else the window.
    await this.evaluate(`(() => {
      const dy = ${Number(action.delta)};
      let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      for (; el && el !== document.documentElement && el !== document.body; el = el.parentElement) {
        const oy = getComputedStyle(el).overflowY;
        if (!/(auto|scroll|overlay)/.test(oy) || el.scrollHeight <= el.clientHeight) continue;
        const room = dy > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop;
        if (room > 1) { el.scrollBy(0, dy); return; }
      }
      window.scrollBy(0, dy);
    })()`);
  } else {
    const target = await tryEvaluate(
      this,
      `${RESOLVE_TARGET}(${JSON.stringify({ node: action.node, kind: action.kind, value: action.value })})`,
    );
    if (!target) {
      throw action.kind === "select"
        ? new Error(
            "page.fastAct: dropdown change was not confirmed; observe before retrying",
          )
        : new StalePageError("Target changed or is covered. Observe again.");
    }
    if (action.kind !== "select") {
      // v2 mouse.click activates the page and emulates focus — no need for
      // Emulation.setFocusEmulationEnabled.
      await this.mouse.click(target.x, target.y);
      if (action.kind === "fill") {
        await this.keyboard.press("Control+a");
        await this.keyboard.insertText(text);
      }
    }
  }
  if (options.settle !== false && action.kind !== "scroll") {
    try {
      await this.evaluate(
        `${SETTLE}(${JSON.stringify({ node: action.node, kind: action.kind })})`,
      );
    } catch {
      // Best effort: navigation may interrupt the wait after input landed.
    }
  }
  return { executed: id };
}

export function installFastLoop(proto, define) {
  define(proto, "fastObserve", fastObserve);
  define(proto, "fastAct", fastAct);
}
