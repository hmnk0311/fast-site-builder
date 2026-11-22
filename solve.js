// fast-site-builder: a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build
// returns for the same input, byte for byte. The reference walks its
// pipeline with a regex per character in places (its inline renderer
// escapes one character at a time, its slug rule re-normalises every
// repeated title and tag, its word counter builds an array of every
// word). This module keeps the reference's exact semantics but does
// the work in bulk: plain text is escaped in runs, slug and long-date
// results are memoised per build, the inline parser takes native
// indexOf fast paths when no backslash is in play, and templates are
// compiled once and rendered into a shared buffer with a scope chain
// instead of a fresh merged vars object per page.

// ---------------------------------------------------------------- text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/;

/** `text` with & < > " and ' escaped, exactly the reference's table.
 * One native replace pass over the whole run (the reference calls its
 * replace on single characters); with no special character the pass
 * returns the string itself. */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/** Escaped form of a single character known to be in the table. */
function escapeChar(c) {
  return ESC_MAP[c] ?? c;
}

const SLUG_MAX = 64;
const MARK_RE = /\p{M}/gu;

/** The slug of `text`, the reference's rule (NFKD, marks dropped, A-Z
 * lowered, runs of anything but a-z/0-9 one "-", cut at 64). */
function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

// Per-build memoisation: titles, tag names and heading texts repeat a
// lot inside one site (the same tag spelled the same way on hundreds of
// posts, a heading text reused across pages), and slugify's Unicode
// normalisation is the priciest small function in the reference.
let slugCache = new Map();
function slugify(text) {
  let v = slugCache.get(text);
  if (v === undefined) {
    v = slugifyRaw(text);
    slugCache.set(text, v);
  }
  return v;
}

/** `slug` made unique against `taken` (and added to it). The next
 * suffix to try for each base is remembered per taken-set: every slot
 * below it was taken when probed and `taken` only grows, so the first
 * free slot is never below it and the answer matches a fresh scan
 * from 2 — without the quadratic probing when many pages share a
 * title (or a document repeats a heading). */
const slugNext = new WeakMap();
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let counters = slugNext.get(taken);
  if (counters === undefined) {
    counters = new Map();
    slugNext.set(taken, counters);
  }
  let n = counters.get(slug) ?? 2;
  let out = `${slug}-${n}`;
  while (taken.has(out)) {
    n++;
    out = `${slug}-${n}`;
  }
  counters.set(slug, n + 1);
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let dateCache = new Map();
function longDate(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    const y = date.slice(0, 4);
    const m = Number(date.slice(5, 7));
    const d = Number(date.slice(8, 10));
    v = `${d} ${MONTHS[m - 1]} ${y}`;
    dateCache.set(date, v);
  }
  return v;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34 /* " */) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

const FM_LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const BLANK_LINE_RE = /^[ \t]*$/;

/**
 * A source's front matter and body: { data, body }, or { error }.
 * The reference splits the whole text into lines and joins the body
 * back; here the closing line is located by scanning line starts, the
 * lines between are validated in place, and the body is one slice.
 */
function parseFrontMatter(text) {
  // First line must be exactly "---".
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // The reference looks for the closing line before it validates any
  // line between: with no closing line the error is "not closed",
  // whatever the lines in between hold. So find the close first.
  let closeNl = -1;
  let scan = firstNl + 1;
  for (;;) {
    const nl = text.indexOf('\n', scan);
    const end = nl === -1 ? text.length : nl;
    if (text.slice(scan, end) === '---') {
      closeNl = nl;
      break;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    scan = nl + 1;
  }
  const closeStart = scan;
  const data = {};
  let pos = firstNl + 1;
  let lineNo = 1; // the opening --- is line 1
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    lineNo++;
    if (pos === closeStart) {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: closeNl === -1 ? '' : text.slice(closeNl + 1) };
    }
    if (!BLANK_LINE_RE.test(line) && !line.startsWith('#')) {
      const m = FM_LINE_RE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
  }
}

// ---------------------------------------------------------------- markdown

const BLANK_RE = /^[ \t]*$/;
const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;

function isBlank(line) {
  // Fast path for the common shapes before the regex.
  if (line === '') return true;
  return BLANK_RE.test(line);
}

function headingOf(line) {
  if (line.charCodeAt(0) !== 35 /* # */) return null;
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  return FENCE_OPEN_RE.exec(line);
}

function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 /* - */ && c !== 42 /* * */) return false;
  return HR_RE.test(line);
}

function endsParagraph(line) {
  if (isBlank(line)) return true;
  const c = line.charCodeAt(0);
  if (c === 96 /* ` */ && fenceOpen(line) !== null) return true;
  if (c === 35 && headingOf(line) !== null) return true;
  if ((c === 45 || c === 42) && isHr(line)) return true;
  return false;
}

const trimLine = (line) => line.replace(/^[ \t]+|[ \t]+$/g, '');

function trimLineFast(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href.
 * The reference escapes one character at a time; here a run of plain
 * characters is sliced and escaped in one call. When the text holds no
 * backslash, the closers for strong, emphasis, code and links are found
 * with native indexOf; with a backslash in play the reference's own
 * escape-aware scans run, so the answers stay identical.
 */
const INTEREST_RE = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline; `env.link(target)` is a link's href.
 * One regex scan finds the next interesting character (a construct
 * opener or a character the escape table rewrites); everything
 * between two interesting characters needs no escaping at all and is
 * sliced across raw, which is where the reference spends most of its
 * time (it escapes one character at a time). Closers are found with
 * native indexOf when the text holds no backslash, and with the
 * reference's escape-aware scans when it does, so the answers stay
 * identical. For emphasis, an indexOf hit that is the first star of
 * a "**" run is not a single star: that one case uses findSingleStar.
 */
function inline(s, env) {
  INTEREST_RE.lastIndex = 0;
  let m = INTEREST_RE.exec(s);
  if (m === null) return s; // nothing to escape, nothing to render
  // Whether the text holds a backslash decides the closer scans, but
  // most inline text never reaches a construct that cares: scan for
  // it only when a `*` or `[` (or the backslash itself) shows up.
  let hasBs = -1;
  const bs = () => {
    if (hasBs === -1) hasBs = s.indexOf('\\') === -1 ? 0 : 1;
    return hasBs === 1;
  };
  const parts = [];
  const n = s.length;
  let i = 0;
  while (m !== null) {
    const j = m.index;
    const c = m[0];
    if (j > i) parts.push(s.slice(i, j));
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      parts.push(ESC_MAP[c]);
      i = j + 1;
      { INTEREST_RE.lastIndex = i; m = INTEREST_RE.exec(s); continue; }
    }
    if (c === '\\') {
      hasBs = 1;
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        parts.push(escapeChar(s[j + 1]));
        i = j + 2;
      } else {
        parts.push('\\');
        i = j + 1;
      }
      { INTEREST_RE.lastIndex = i; m = INTEREST_RE.exec(s); continue; }
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        parts.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        parts.push('`');
        i = j + 1;
      }
      { INTEREST_RE.lastIndex = i; m = INTEREST_RE.exec(s); continue; }
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = bs() ? findUnescaped(s, '**', j + 2) : s.indexOf('**', j + 2);
        if (k > j + 2) {
          parts.push('<strong>', inline(s.slice(j + 2, k), env), '</strong>');
          i = k + 2;
        } else {
          parts.push('**');
          i = j + 2;
        }
        { INTEREST_RE.lastIndex = i; m = INTEREST_RE.exec(s); continue; }
      }
      let k = bs() ? findSingleStar(s, j + 1) : s.indexOf('*', j + 1);
      if (!bs() && k !== -1 && s[k + 1] === '*') k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        parts.push('<em>', inline(s.slice(j + 1, k), env), '</em>');
        i = k + 1;
      } else {
        parts.push('*');
        i = j + 1;
      }
      { INTEREST_RE.lastIndex = i; m = INTEREST_RE.exec(s); continue; }
    }
    // c === '['
    const k = bs() ? findUnescaped(s, ']', j + 1) : s.indexOf(']', j + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      parts.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(j + 1, k), env), '</a>');
      i = mm + 1;
      { INTEREST_RE.lastIndex = i; m = INTEREST_RE.exec(s); continue; }
    }
    parts.push('[');
    i = j + 1;
    INTEREST_RE.lastIndex = i;
    m = INTEREST_RE.exec(s);
  }
  parts.push(s.slice(i));
  return parts.join('');
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt.
 * The block lexer is the reference's, with first-character dispatch
 * in front of its regexes (most lines are paragraph text).
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const fence = fenceOpen(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        let inner = '';
        for (const l of body) inner += `${escapeHtml(l)}\n`;
        blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
        continue;
      }
    }
    if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (c0 === 62 /* > */) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        body.push(lines[i].replace(/^> ?/, ''));
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimLineFast(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    let bullet = null;
    let ordered = null;
    if (c0 === 45 || c0 === 42) bullet = BULLET_RE.exec(line);
    else if (c0 >= 48 && c0 <= 57) ordered = ORDERED_RE.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED_RE : BULLET_RE;
      const items = [];
      while (i < lines.length) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLineFast(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLineFast(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
      let inner = '';
      for (const parts of items) inner += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    const body = [trimLineFast(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLineFast(lines[i++]));
    const text = body.join('\n');
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  const head = path[0];
  while (s !== null && !Object.hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Static shape of every template, for the include cache below: the
 * root names a template reads that are not bound by a for inside it
 * (its free roots, transitively through its includes), and the
 * deepest include chain inside it. A template whose include graph
 * cycles is volatile and never cached.
 */
function analyzeTemplates(templates) {
  const info = new Map();
  const visiting = new Set();
  const analyze = (name) => {
    const done = info.get(name);
    if (done !== undefined) return done;
    if (visiting.has(name)) return { used: [], height: 0, volatile: true };
    const nodes = templates.get(name);
    if (nodes === undefined) return { used: [], height: 0, volatile: false };
    visiting.add(name);
    const used = new Set();
    let height = 0;
    let volatile = false;
    const addHead = (path, bound) => {
      if (!bound.has(path[0])) used.add(path[0]);
    };
    const walk = (ns, bound) => {
      for (const n of ns) {
        if (n.kind === 'var' || n.kind === 'raw') addHead(n.path, bound);
        else if (n.kind === 'if') {
          addHead(n.path, bound);
          walk(n.then, bound);
          if (n.else !== null) walk(n.else, bound);
        } else if (n.kind === 'for') {
          addHead(n.path, bound);
          const inner = new Set(bound);
          inner.add(n.name);
          inner.add('loop');
          walk(n.body, inner);
        } else if (n.kind === 'include') {
          const sub = analyze(n.name);
          if (sub.volatile) volatile = true;
          for (const u of sub.used) if (!bound.has(u)) used.add(u);
          height = Math.max(height, 1 + sub.height);
        }
      }
    };
    walk(nodes, new Set());
    visiting.delete(name);
    const entry = { used: [...used].sort(), height, volatile };
    info.set(name, entry);
    return entry;
  };
  for (const name of templates.keys()) analyze(name);
  return info;
}

/** A cache-key fragment for one resolved root value. */
function valueKey(ctx, v) {
  if (v === undefined) return 'u';
  if (v === null) return 'n';
  const t = typeof v;
  if (t === 'string') return `s${v.length}:${v}`;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return `p${String(v)}`;
  let id = ctx.objIds.get(v);
  if (id === undefined) {
    id = ctx.nextId++;
    ctx.objIds.set(v, id);
  }
  return `o${id}`;
}

/**
 * `nodes` rendered into the shared `out` array. The reference builds a
 * fresh merged vars object for every page and concatenates a string
 * per node; here the page's own vars sit in a child scope over one
 * shared root scope ({ site, tags, recent }), which lookup reads the
 * same way, and every fragment lands in one buffer joined once.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(scope, n.path);
        if (typeof v === 'string') {
          // The same strings (titles, urls, the site name) are written
          // on hundreds of pages; their escaped forms are memoised.
          let e = ctx.escCache.get(v);
          if (e === undefined) {
            e = escapeHtml(v);
            ctx.escCache.set(v, e);
          }
          out.push(e);
        } else out.push(escapeHtml(textOf(v)));
        break;
      }
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        // An include whose free roots resolve to the same values as an
        // earlier one renders the same text: the header of a site (the
        // site name and the recent list, nothing page-specific) is
        // rendered once and reused on every page, and a post's card is
        // reused across the index and its tag pages. The depth guard
        // keeps the include cutoff (8) out of the cached text: with
        // depth + height < 8 no include inside can be cut off, so the
        // text does not depend on the depth it was first rendered at.
        const an = ctx.analysis.get(n.name);
        if (an !== undefined && !an.volatile && depth + an.height < INCLUDE_DEPTH) {
          let key = n.name;
          for (const rootName of an.used) key += `\x00${valueKey(ctx, lookup(scope, [rootName]))}`;
          const hit = ctx.incCache.get(key);
          if (hit !== undefined) {
            out.push(hit);
            break;
          }
          const buf = [];
          renderNodes(t, scope, ctx, depth + 1, buf);
          const str = buf.join('');
          ctx.incCache.set(key, str);
          out.push(str);
          break;
        }
        renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether `ch` is JavaScript whitespace (the \s class), by code unit. */
function isWsCode(code) {
  return (
    code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff
  );
}

/** The number of words in `text`: its runs of non-whitespace. The
 * reference builds the whole match array just to count it. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  slugCache = new Map();
  dateCache = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources in code-unit order of path; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the refusal checks, in the reference's order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: the slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved against pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (target.startsWith('/') || target.startsWith('#')) return target;
        // The reference's scheme test, ^[A-Za-z][A-Za-z0-9+.-]*: — run
        // by hand over the short prefix before the first colon.
        const colon = target.indexOf(':');
        if (colon > 0) {
          let scheme = true;
          for (let q = 0; q < colon; q++) {
            const ch = target.charCodeAt(q);
            const ok = (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (q > 0 && ((ch >= 48 && ch <= 57) || ch === 43 || ch === 45 || ch === 46));
            if (!ok) {
              scheme = false;
              break;
            }
          }
          if (scheme) return target;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts. Cards are built once per post and shared by the index,
  // tag, recent and neighbour renders, as the reference's card map does;
  // a page's own card is built once for its layout.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escCache: new Map(), incCache: new Map(), objIds: new WeakMap(), nextId: 1, analysis: analyzeTemplates(templates) };
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: rootScope }, ctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
