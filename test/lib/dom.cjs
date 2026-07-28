// Minimal DOM good enough to run 13/script.js headlessly.
// Not a browser: layout is faked (all rects are zero), but the tree, classes,
// dataset, selectors and events behave the way the game relies on.

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "circle", "path"]);

class ClassList {
  constructor(el) { this.el = el; }
  _set() { return new Set(String(this.el.className || "").split(/\s+/).filter(Boolean)); }
  _write(s) { this.el.className = [...s].join(" "); }
  add(...n) { const s = this._set(); n.forEach(x => s.add(x)); this._write(s); }
  remove(...n) { const s = this._set(); n.forEach(x => s.delete(x)); this._write(s); }
  contains(n) { return this._set().has(n); }
  toggle(n, force) {
    const has = this.contains(n);
    const on = force === undefined ? !has : !!force;
    if (on) this.add(n); else this.remove(n);
    return on;
  }
  get value() { return this.el.className; }
  toString() { return this.el.className; }
}

let uid = 0;

class Node {
  constructor(tag, doc) {
    this.tagName = String(tag || "div").toUpperCase();
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = new Proxy({}, {
      set: (t, k, v) => { t[k] = String(v); this.attributes["data-" + camelToDash(k)] = String(v); return true; },
      get: (t, k) => t[k],
    });
    this.style = new Proxy({}, { set: (t, k, v) => { t[k] = v; return true; }, get: (t, k) => t[k] || "" });
    this._className = "";
    this.classList = new ClassList(this);
    this._text = "";
    this._listeners = {};
    this.disabled = false;
    this.value = "";
    this.type = "";
    this._uid = ++uid;
    // faked layout
    this.offsetWidth = 0; this.offsetHeight = 0; this.clientWidth = 440;
  }
  get className() { return this._className; }
  set className(v) { this._className = String(v == null ? "" : v); }
  get id() { return this.attributes.id || ""; }
  set id(v) { this.setAttribute("id", v); }
  get children() { return this.childNodes.filter(n => n instanceof Node); }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === "id" && this.ownerDocument) this.ownerDocument._index(this);
    if (k === "class") this.className = String(v);
    if (k.startsWith("data-")) this.dataset[dashToCamel(k.slice(5))] = String(v);
  }
  getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    if (this.ownerDocument) this.ownerDocument._indexTree(n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; }
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }
  get textContent() {
    if (!this.childNodes.length) return this._text;
    return this.childNodes.map(c => c.textContent).join("");
  }
  set textContent(v) { this.childNodes.length = 0; this._text = String(v == null ? "" : v); }
  get innerHTML() { return this.childNodes.map(serialize).join("") || escapeText(this._text); }
  set innerHTML(html) {
    this.childNodes.length = 0;
    this._text = "";
    parseInto(String(html == null ? "" : html), this, this.ownerDocument);
  }
  querySelector(sel) { return queryAll(this, sel, true)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel, false); }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  }
  dispatch(type, evt) {
    // A real browser does not fire click on a disabled control — a test must not
    // be able to press a button the player cannot.
    if (type === "click" && this.disabled) return { type, blocked: true };
    const ev = Object.assign({ type, target: this, stopPropagation() {}, preventDefault() {} }, evt || {});
    (this._listeners[type] || []).slice().forEach(fn => fn.call(this, ev));
    return ev;
  }
  click() { this.dispatch("click"); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() {}
}

class TextNode {
  constructor(text) { this._text = text; this.parentNode = null; this.childNodes = []; this.nodeType = 3; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

function camelToDash(s) { return s.replace(/[A-Z]/g, c => "-" + c.toLowerCase()); }
function dashToCamel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
function escapeText(s) { return String(s); }
function serialize(n) {
  if (n instanceof TextNode) return n._text;
  const attrs = Object.keys(n.attributes).map(k => ` ${k}="${n.attributes[k]}"`).join("");
  const cls = n.className ? ` class="${n.className}"` : "";
  return `<${n.tagName.toLowerCase()}${cls}${attrs}>${n.innerHTML}</${n.tagName.toLowerCase()}>`;
}

// ── tiny HTML parser (enough for index.html + the game's innerHTML strings) ──
function parseInto(html, root, doc) {
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0, m;
  while ((m = re.exec(html))) {
    if (m.index > last) {
      const txt = html.slice(last, m.index);
      if (txt.trim()) stack[stack.length - 1].appendChild(new TextNode(txt));
    }
    last = re.lastIndex;
    if (m[0].startsWith("<!")) continue;
    if (m[1]) {                                   // close tag
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === m[1].toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }
    const tag = m[2];
    const el = new Node(tag, doc);
    parseAttrs(m[3] || "", el);
    if (doc) doc._index(el);
    stack[stack.length - 1].appendChild(el);
    if (!m[4] && !VOID_TAGS.has(tag.toLowerCase())) stack.push(el);
  }
  if (last < html.length) {
    const txt = html.slice(last);
    if (txt.trim()) stack[stack.length - 1].appendChild(new TextNode(txt));
  }
}
function parseAttrs(str, el) {
  const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g;
  let m;
  while ((m = re.exec(str))) {
    const k = m[1];
    if (!k) continue;
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "";
    el.setAttribute(k, v);
  }
}

// ── selector engine: descendant chains of compound simple selectors ──
function parseCompound(part) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /(\[[^\]]+\])|(#[\w-]+)|(\.[\w-]+)|([\w-]+)/g;
  let m;
  while ((m = re.exec(part))) {
    if (m[1]) {
      const am = /\[([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/.exec(m[1]);
      if (am) out.attrs.push([am[1], am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4]]);
    } else if (m[2]) out.id = m[2].slice(1);
    else if (m[3]) out.classes.push(m[3].slice(1));
    else if (m[4]) out.tag = m[4].toUpperCase();
  }
  return out;
}
function matchCompound(el, c) {
  if (!(el instanceof Node)) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const [k, v] of c.attrs) {
    const got = el.getAttribute(k);
    if (got === null) return false;
    if (v !== undefined && String(got) !== String(v)) return false;
  }
  return true;
}
function descendants(root, out) {
  for (const c of root.childNodes) {
    if (c instanceof Node) { out.push(c); descendants(c, out); }
  }
  return out;
}
function queryAll(root, sel, firstOnly) {
  const results = [];
  for (const one of String(sel).split(",")) {
    const parts = one.trim().split(/\s+/).filter(Boolean).map(parseCompound);
    if (!parts.length) continue;
    let cands = descendants(root, []);
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i];
      const matched = cands.filter(el => matchCompound(el, c));
      if (i === parts.length - 1) { matched.forEach(el => { if (!results.includes(el)) results.push(el); }); break; }
      const next = [];
      matched.forEach(el => descendants(el, next));
      cands = next;
    }
    if (firstOnly && results.length) break;
  }
  return results;
}

class Document {
  constructor(html) {
    this._byId = new Map();
    this._listeners = {};
    this.hidden = false;
    this.visibilityState = "visible";
    this.title = "";
    this.documentElement = new Node("html", this);
    this.body = new Node("body", this);
    this.documentElement.appendChild(this.body);
    if (html) parseInto(html, this.body, this);
  }
  _index(el) { if (el.attributes.id) this._byId.set(el.attributes.id, el); }
  _indexTree(el) {
    if (!(el instanceof Node)) return;
    this._index(el);
    el.ownerDocument = this;
    el.childNodes.forEach(c => this._indexTree(c));
  }
  getElementById(id) { return this._byId.get(id) || null; }
  createElement(tag) { return new Node(tag, this); }
  createTextNode(t) { return new TextNode(String(t)); }
  querySelector(s) { return queryAll(this.body, s, true)[0] || null; }
  querySelectorAll(s) { return queryAll(this.body, s, false); }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  dispatch(type, evt) {
    const ev = Object.assign({ type, target: this, stopPropagation() {}, preventDefault() {} }, evt || {});
    (this._listeners[type] || []).slice().forEach(fn => fn.call(this, ev));
    return ev;
  }
}

module.exports = { Document, Node, TextNode };
