// main.ts is mend, the CLI SPEC.md specifies (kit's starting point, MIT, completed): sections 1 to 10 of SPEC.md —
// the command line, the output and exit codes, safe paths, format detection, three-tier line matching (section 5),
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and
// the all-or-nothing write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = ((tree: Tree) => void) & { move?: { from: string; to: string } };

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileLines { lines: string[]; br: string; final: boolean; }
function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

/** Positions where O occurs in lines at one tier (SPEC.md section 5). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const eq = tier === 0
    ? (a: string, b: string): boolean => a === b
    : tier === 1
      ? (a: string, b: string): boolean => trimEndWs(a) === trimEndWs(b)
      : (a: string, b: string): boolean => trimBothWs(a) === trimBothWs(b);
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) if (!eq(lines[i + k]!, o[k]!)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, or null. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line names its index in O and is written as the file's own line. */
interface NItem { text: string; ctx?: number; }

/** Replace lines[i..i+o.length) with N, applying section 5's context and tier-2 rules. */
function applyReplace(lines: string[], i: number, o: string[], tier: number, n: NItem[]): string[] {
  const out = [...lines];
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = o.length > 0 ? leadWs(lines[i]!) : '';
  const repl = n.map((it) => {
    if (it.ctx !== undefined) return lines[i + it.ctx]!;
    const t = it.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
  out.splice(i, o.length, ...repl);
  return out;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk: O = context + `-` lines, N = context + `+` lines (SPEC.md section 6). */
interface Hunk { a: number; o: string[]; n: NItem[]; noEol: boolean; plusNoEol: boolean; plusCount: number; }

function parseHunkBody(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NItem[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  let plusCount = 0;
  for (let k = 0; k < body.length; k += 1) {
    const b = body[k]!;
    if (b === '' || b.startsWith(' ')) {
      const text = b === '' ? '' : b.slice(1);
      o.push(text);
      n.push({ text, ctx: o.length - 1 });
      lastCtxPlus = k;
    } else if (b.startsWith('-')) {
      o.push(b.slice(1));
    } else if (b.startsWith('+')) {
      n.push({ text: b.slice(1) });
      lastCtxPlus = k;
      lastPlus = k;
      plusCount += 1;
    }
  }
  const followed = (k: number): boolean => k >= 0 && k + 1 < body.length && body[k + 1]!.startsWith('\\');
  return { a, o, n, noEol: followed(lastCtxPlus), plusNoEol: followed(lastPlus), plusCount };
}

/** Apply a section's hunks in order to a file's lines (SPEC.md section 6). */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, failPath: string): FileLines {
  let lines = [...f.lines];
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(lines, h.o, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      const atEof = best + h.o.length === lines.length;
      lines = applyReplace(lines, best, h.o, found.tier, h.n);
      if (atEof) final = !h.noEol;
      d += h.n.length - h.o.length;
    } else {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const atEof = pos === lines.length;
      lines.splice(pos, 0, ...h.n.map((it) => it.text));
      if (atEof) final = !h.noEol;
      d += h.n.length;
    }
  }
  return { lines, br: f.br, final };
}

/** The text a creation section writes: the `+` lines of all its hunks, LF breaks. */
function createdText(hunks: Hunk[]): string {
  const plus: string[] = [];
  let noEol = false;
  for (const h of hunks) {
    for (const it of h.n) if (it.ctx === undefined) plus.push(it.text);
    if (h.plusCount > 0) noEol = h.plusNoEol;
  }
  if (plus.length === 0) return '';
  return plus.join('\n') + (noEol ? '' : '\n');
}

interface USection {
  gitOld: string | undefined; gitNew: string | undefined;
  pairOld: string | null | undefined; pairNew: string | null | undefined;
  renFrom: string | undefined; renTo: string | undefined;
  newFile: boolean; delFile: boolean;
  hunks: Hunk[];
}

function sectionEdit(s: USection, strict: boolean): Edit {
  const oldP = s.pairOld !== undefined ? s.pairOld : s.renFrom !== undefined ? s.renFrom : (s.gitOld ?? null);
  const newP = s.pairNew !== undefined ? s.pairNew : s.renTo !== undefined ? s.renTo : (s.gitNew ?? null);
  const creation = s.newFile || s.pairOld === null;
  const deletion = !creation && (s.delFile || s.pairNew === null);
  if (creation) {
    const p = newP ?? '';
    const text = createdText(s.hunks);
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (deletion) {
    const p = oldP ?? '';
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const from = oldP ?? '';
  const to = newP ?? '';
  const hunks = s.hunks;
  if (from !== to) {
    const e: Edit = (tree: Tree) => {
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const t = tree.get(from);
      if (t === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      tree.now.set(to, joinFile(applyHunks(splitFile(t), hunks, strict, from)));
      tree.now.set(from, null);
    };
    e.move = { from, to };
    return e;
  }
  return (tree: Tree) => {
    if (!safe(from)) throw new Fail('unsafe', from);
    const t = tree.get(from);
    if (t === null) throw new Fail('missing', from);
    tree.now.set(from, joinFile(applyHunks(splitFile(t), hunks, strict, from)));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: USection[] = [];
  const newSection = (): USection => ({ gitOld: undefined, gitNew: undefined, pairOld: undefined, pairNew: undefined, renFrom: undefined, renTo: undefined, newFile: false, delFile: false, hunks: [] });
  let cur: USection | null = null;
  let header = false;
  let pair = false;
  const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const headerPath = (line: string): string => {
    let t = line.slice(4);
    const tab = t.indexOf('\t');
    if (tab >= 0) t = t.slice(0, tab);
    return stripPrefix(t.trim());
  };
  const takePair = (i: number): void => {
    const op = headerPath(lines[i]!);
    const np = headerPath(lines[i + 1]!);
    cur!.pairOld = op === '/dev/null' ? null : op;
    cur!.pairNew = np === '/dev/null' ? null : np;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      secs.push(cur);
      header = true;
      pair = false;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && header && !pair) {
        takePair(i);
        pair = true;
      } else {
        cur = newSection();
        secs.push(cur);
        takePair(i);
        header = true;
        pair = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      header = false;
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('diff --git ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) { body.push(b); j += 1; }
        else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(parseHunkBody(Number(m[1]), body));
      i = j;
      continue;
    }
    if (cur !== null && header) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        if (!pair) {
          const np = headerPath(l);
          cur.pairNew = np === '/dev/null' ? null : np;
        }
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) { cur.renFrom = l.slice(12).trim(); i += 1; continue; }
      if (l.startsWith('rename to ')) { cur.renTo = l.slice(10).trim(); i += 1; continue; }
      if (l.startsWith('new file mode')) { cur.newFile = true; i += 1; continue; }
      if (l.startsWith('deleted file mode')) { cur.delFile = true; i += 1; continue; }
    }
    i += 1;
  }
  return secs.map((s) => sectionEdit(s, strict));
}
function srEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  if (oldLines.length === 0) {
    const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  const nItems: NItem[] = newLines.map((t) => ({ text: t }));
  return (tree: Tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    const f = splitFile(t);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    tree.now.set(p, joinFile({ lines: applyReplace(f.lines, found.occ[0]!, oldLines, found.tier, nItems), br: f.br, final: f.final }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const s = i;
    let eq = -1;
    let rep = -1;
    for (let j = s + 1; j < n; j += 1) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') { eq = j; continue; }
      if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    prevPath = path;
    prevEnd = rep;
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    i = rep + 1;
  }
  return edits;
}
/** One V4A chunk: O = context + `-` lines, N = context + `+` lines (SPEC.md section 8). */
interface VChunk { anchor: string | null; o: string[]; n: NItem[]; eof: boolean; }

/** Whether O matches lines[pos..] at one tier. */
function matchesAt(lines: string[], pos: number, o: string[], tier: number): boolean {
  if (pos < 0 || pos + o.length > lines.length) return false;
  for (let k = 0; k < o.length; k += 1) {
    const a = lines[pos + k]!;
    const b = o[k]!;
    const eq = tier === 0 ? a === b : tier === 1 ? trimEndWs(a) === trimEndWs(b) : trimBothWs(a) === trimBothWs(b);
    if (!eq) return false;
  }
  return true;
}

/** Apply an Update section's chunks in order, with the cursor (SPEC.md section 8). */
function applyChunks(f: FileLines, chunks: VChunk[], strict: boolean, failPath: string): FileLines {
  let lines = [...f.lines];
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const found = findTier(lines.slice(cursor), [c.anchor], strict);
      if (found === null) throw new Fail('no-match', failPath);
      cursor = cursor + found.occ[0]! + 1;
    }
    if (c.o.length > 0) {
      if (c.eof) {
        const pos = lines.length - c.o.length;
        if (pos < cursor) throw new Fail('no-match', failPath);
        let tier = -1;
        const max = strict ? 0 : 2;
        for (let t = 0; t <= max; t += 1) if (matchesAt(lines, pos, c.o, t)) { tier = t; break; }
        if (tier < 0) throw new Fail('no-match', failPath);
        lines = applyReplace(lines, pos, c.o, tier, c.n);
        cursor = pos + c.n.length;
      } else {
        const found = findTier(lines.slice(cursor), c.o, strict);
        if (found === null) throw new Fail('no-match', failPath);
        const pos = cursor + found.occ[0]!;
        lines = applyReplace(lines, pos, c.o, found.tier, c.n);
        cursor = pos + c.n.length;
      }
    } else {
      const pos = c.eof ? lines.length : cursor;
      lines.splice(pos, 0, ...c.n.map((it) => it.text));
      cursor = pos + c.n.length;
    }
  }
  return { lines, br: f.br, final: f.final };
}

interface VSection { kind: string; path: string; head: number; }

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const secs: VSection[] = [];
  for (let j = first + 1; j < last; j += 1) {
    const l = lines[j]!;
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : l.startsWith('*** Update File: ') ? 'update' : null;
    if (kind !== null) {
      secs.push({ kind, path: l.slice(kind === 'add' ? 14 : 17).trim(), head: j });
      continue;
    }
    if (secs.length === 0) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${j + 1}`);
    }
  }
  const edits: Edit[] = [];
  for (let s = 0; s < secs.length; s += 1) {
    const sec = secs[s]!;
    let start = sec.head + 1;
    let end = s + 1 < secs.length ? secs[s + 1]!.head : last;
    while (end > start && blank(lines[end - 1]!)) end -= 1;
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      for (let j = start; j < end; j += 1) {
        const l = lines[j]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      const p = sec.path;
      const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      });
      continue;
    }
    if (sec.kind === 'delete') {
      for (let j = start; j < end; j += 1) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
      }
      const p = sec.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    let moveTo: string | null = null;
    let j = start;
    if (j < end && lines[j]!.startsWith('*** Move to: ')) {
      moveTo = lines[j]!.slice(13).trim();
      j += 1;
    }
    const chunks: VChunk[] = [];
    let curChunk: VChunk | null = null;
    const closeChunk = (): void => { if (curChunk !== null) { chunks.push(curChunk); curChunk = null; } };
    for (; j < end; j += 1) {
      const l = lines[j]!;
      if (l.startsWith('@@')) {
        closeChunk();
        const anchor = l.slice(2).trim();
        curChunk = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
        continue;
      }
      if (l === '*** End of File') {
        if (curChunk === null) throw new Exit2(`error: parse ${j + 1}`);
        curChunk.eof = true;
        closeChunk();
        continue;
      }
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (curChunk === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
          curChunk = { anchor: null, o: [], n: [], eof: false };
        }
        if (l === '' || l.startsWith(' ')) {
          const text = l === '' ? '' : l.slice(1);
          curChunk.o.push(text);
          curChunk.n.push({ text, ctx: curChunk.o.length - 1 });
        } else if (l.startsWith('-')) {
          curChunk.o.push(l.slice(1));
        } else {
          curChunk.n.push({ text: l.slice(1) });
        }
        continue;
      }
      throw new Exit2(`error: parse ${j + 1}`);
    }
    closeChunk();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.head + 1}`);
    const p = sec.path;
    const to = moveTo;
    if (to !== null) {
      const e: Edit = (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (!safe(to)) throw new Fail('unsafe', to);
        const t = tree.get(p);
        if (t === null) throw new Fail('missing', p);
        if (tree.get(to) !== null) throw new Fail('exists', to);
        tree.now.set(to, joinFile(applyChunks(splitFile(t), chunks, strict, p)));
        tree.now.set(p, null);
      };
      e.move = { from: p, to };
      edits.push(e);
    } else {
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const t = tree.get(p);
        if (t === null) throw new Fail('missing', p);
        tree.now.set(p, joinFile(applyChunks(splitFile(t), chunks, strict, p)));
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
        : kind === 'search-replace' ? srEdits(lines, strict)
          : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Write first (unchanged files are skipped), then build the report rows.
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const e of edits) {
    if (e.move === undefined) continue;
    const { from, to } = e.move;
    if (consumed.has(from) || consumed.has(to)) continue;
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      consumed.add(from);
      consumed.add(to);
      rows.push({ key: to, line: `R ${from} -> ${to}` });
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const linesOut = rows.map((r) => r.line);
  return { code: 0, out: [...linesOut, `ok: ${linesOut.length} ${linesOut.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
