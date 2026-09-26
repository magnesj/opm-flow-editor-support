// Editor features for SIMEVENTS files, computed from the parsed document.
// Kept free of the vscode API so they can be unit-tested.

import {
  formatDate,
  SimEventsDocument,
  Span,
  VarKind,
} from './simevents';

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface OutlineItem {
  name: string;
  detail: string;
  kind: 'declaration' | 'block' | 'event';
  varKind?: VarKind;
  range: LineRange;
  selection: Span;
  children: OutlineItem[];
}

function lineSpan(lines: string[], line: number): Span {
  const text = lines[line] ?? '';
  const start = text.length - text.trimStart().length;
  return { line, start, end: text.trimEnd().length };
}

export function buildSimEventsOutline(doc: SimEventsDocument, lines: string[]): OutlineItem[] {
  const items: OutlineItem[] = doc.declarations.map(decl => ({
    name: decl.name,
    detail: decl.kind,
    kind: 'declaration',
    varKind: decl.kind,
    range: { startLine: decl.nameSpan.line, endLine: decl.nameSpan.line },
    selection: decl.nameSpan,
    children: [],
  }));
  for (const block of doc.blocks) {
    if (block.kind === 'NONE') {
      continue;
    }
    items.push({
      name: block.name !== undefined ? `${block.kind} ${block.name}` : block.kind,
      detail: block.valid ? '' : 'invalid',
      kind: 'block',
      range: { startLine: block.line, endLine: block.endLine },
      selection: block.nameSpan ?? lineSpan(lines, block.line),
      children: block.events.map(event => ({
        name: event.type,
        detail: event.date !== undefined ? formatDate(event.date) : '',
        kind: 'event',
        range: { startLine: event.line, endLine: event.rawBody ? event.rawBody.endLine + 1 : event.line },
        selection: event.typeSpan,
        children: [],
      })),
    });
  }
  return items.sort((a, b) => a.range.startLine - b.range.startLine);
}

export function foldingRanges(doc: SimEventsDocument, lines: string[]): LineRange[] {
  const ranges: LineRange[] = [];
  for (const block of doc.blocks) {
    if (block.kind !== 'NONE' && block.endLine > block.line) {
      ranges.push({ startLine: block.line, endLine: block.endLine });
    }
    for (const event of block.events) {
      if (event.rawBody) {
        ranges.push({ startLine: event.line, endLine: event.rawBody.endLine + 1 });
      }
    }
  }
  let commentStart = -1;
  for (let i = 0; i <= lines.length; i++) {
    const isComment = i < lines.length && lines[i].trimStart().startsWith('#');
    if (isComment && commentStart < 0) {
      commentStart = i;
    } else if (!isComment && commentStart >= 0) {
      if (i - 1 > commentStart) {
        ranges.push({ startLine: commentStart, endLine: i - 1 });
      }
      commentStart = -1;
    }
  }
  return ranges;
}

export interface VariableOccurrences {
  name: string;
  // The occurrence under the cursor.
  span: Span;
  definition?: Span;
  declarations: Span[];
  references: Span[];
}

function contains(span: Span, line: number, character: number): boolean {
  return span.line === line && span.start <= character && character <= span.end;
}

// All occurrences of the variable at a position. Occurrences are matched by
// name, since redeclaring a variable replaces it.
export function variableAt(doc: SimEventsDocument, line: number, character: number): VariableOccurrences | undefined {
  const decl = doc.declarations.find(d => contains(d.nameSpan, line, character));
  const ref = decl ? undefined : doc.references.find(r => contains(r.span, line, character));
  const name = decl?.name ?? ref?.name;
  if (name === undefined) {
    return undefined;
  }
  return {
    name,
    span: (decl?.nameSpan ?? ref?.span)!,
    definition: decl?.nameSpan ?? ref?.declaration?.nameSpan,
    declarations: doc.declarations.filter(d => d.name === name).map(d => d.nameSpan),
    references: doc.references.filter(r => r.name === name).map(r => r.span),
  };
}

export function isValidVariableName(name: string): boolean {
  return /^[A-Za-z_]\w*$/.test(name);
}
