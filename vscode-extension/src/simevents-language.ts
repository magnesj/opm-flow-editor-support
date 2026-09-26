// Editor features for SIMEVENTS files, computed from the parsed document.
// Kept free of the vscode API so they can be unit-tested.

import {
  ATTRIBUTE_VALUES,
  BlockKind,
  BUILTIN_EVENT_ATTRIBUTES,
  Declaration,
  Duration,
  FilterExpr,
  formatDate,
  formatDuration,
  KEYWORD_ITEM_ALIASES,
  KeywordInfo,
  SimEventsDocument,
  Span,
  stripComment,
  TOP_LEVEL_KEYWORDS,
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

export const BUILTIN_EVENT_DOCS: Record<string, string> = {
  PERFORATION: 'Perforation interval from MDSTART to MDEND. FILTER limits it to cells matching a cell filter.',
  SEGMENT: 'Multi-segment tubing interval from MDSTART to MDEND.',
  VALVE: 'Valve at measured depth MD.',
  STATE: 'Change of well state.',
  WELSPECS: 'Partial WELSPECS update. Omitted values keep the previous state.',
  MEMBER: 'Shorthand for one GRUPTREE record per member, with the enclosing group as parent.',
  INSERT_DATE: 'Adds a DATES entry, and so a summary report, at this date. EVERY repeats it until UNTIL (inclusive) or the last event.',
  RESTART: 'Drops generated schedule output before this date. At most one per file.',
  RAW_TEXT: 'Copies the lines up to END_RAW_TEXT into the schedule unchanged, at PLACEMENT.',
};

const BLOCK_INJECTED_ITEM: Partial<Record<BlockKind, string>> = { WELL: 'WELL', GROUP: 'GROUP' };

function describeValue(decl: Declaration): string {
  const value = decl.value;
  if (value === undefined) {
    return '';
  }
  switch (decl.kind) {
    case 'DATE':
      return formatDate(value as number);
    case 'DURATION':
      return formatDuration(value as Duration);
    case 'WELL':
      return `"${value as string}"`;
    case 'FILTER':
      return `"${(value as FilterExpr).raw}"`;
  }
}

function describeAttributes(type: string): string {
  const spec = BUILTIN_EVENT_ATTRIBUTES[type];
  if (!spec) {
    return '';
  }
  const parts: string[] = [];
  if (spec.required.length) {
    parts.push(`Required: ${spec.required.map(a => `\`${a}\``).join(', ')}`);
  }
  if (spec.optional.length) {
    parts.push(`Optional: ${spec.optional.map(a => `\`${a}\``).join(', ')}`);
  }
  return parts.join('  \n');
}

// Markdown hover text for the construct at a position.
export function hoverAt(
  doc: SimEventsDocument,
  line: number,
  character: number,
  keywords?: Map<string, KeywordInfo>,
): { span: Span; markdown: string } | undefined {
  const occurrences = variableAt(doc, line, character);
  if (occurrences) {
    const decl = doc.declarations.find(d => d.nameSpan === occurrences.definition);
    if (!decl) {
      return undefined;
    }
    const value = describeValue(decl);
    return {
      span: occurrences.span,
      markdown: `${decl.kind} \`${decl.name}\`${value ? ` = \`${value}\`` : ''}`,
    };
  }

  for (const block of doc.blocks) {
    for (const event of block.events) {
      if (event.line !== line) {
        continue;
      }
      const type = event.type.toUpperCase();
      if (contains(event.dateSpan, line, character) && event.date !== undefined) {
        return { span: event.dateSpan, markdown: `Event date \`${formatDate(event.date)}\`` };
      }
      const keyword = keywords?.get(type);
      if (contains(event.typeSpan, line, character)) {
        if (BUILTIN_EVENT_DOCS[type]) {
          const attributes = describeAttributes(type);
          return {
            span: event.typeSpan,
            markdown: `**${type}** (SIMEVENTS)\n\n${BUILTIN_EVENT_DOCS[type]}${attributes ? `\n\n${attributes}` : ''}`,
          };
        }
        if (keyword) {
          const injected = BLOCK_INJECTED_ITEM[block.kind];
          const note = injected ? `\n\nThe ${block.kind.toLowerCase()} name is passed as the ${injected} item.` : '';
          return { span: event.typeSpan, markdown: `**${type}**\n\n${keyword.summary ?? ''}${note}` };
        }
        return undefined;
      }
      for (const attr of event.attributes.values()) {
        if (!contains(attr.keySpan, line, character)) {
          continue;
        }
        const options = ATTRIBUTE_VALUES[`${type}.${attr.key}`];
        if (BUILTIN_EVENT_ATTRIBUTES[type]) {
          const required = BUILTIN_EVENT_ATTRIBUTES[type].required.includes(attr.key) ? 'required' : 'optional';
          const values = options ? `\n\nValues: ${options.map(o => `\`${o}\``).join(', ')}` : '';
          return { span: attr.keySpan, markdown: `**${attr.key}** (${required} ${type} attribute)${values}` };
        }
        const item = KEYWORD_ITEM_ALIASES[type]?.[attr.key] ?? attr.key;
        const description = keyword?.itemDescriptions?.[item];
        if (description) {
          const alias = item !== attr.key ? ` (written as ${attr.key})` : '';
          return { span: attr.keySpan, markdown: `**${type} ${item}**${alias}\n\n${description}` };
        }
        return undefined;
      }
    }
  }
  return undefined;
}

// The simulator keyword of the event on a line, and the keyword item under the
// cursor, for the keyword reference panel.
export function simulatorKeywordAt(
  doc: SimEventsDocument,
  line: number,
  character: number,
  keywords: Map<string, KeywordInfo>,
): { keyword: string; item?: string } | undefined {
  for (const block of doc.blocks) {
    for (const event of block.events) {
      if (event.line !== line) {
        continue;
      }
      const keyword = event.type.toUpperCase();
      if (!keywords.has(keyword)) {
        return undefined;
      }
      for (const attr of event.attributes.values()) {
        if (contains(attr.keySpan, line, character) || contains(attr.valueSpan, line, character)) {
          return { keyword, item: KEYWORD_ITEM_ALIASES[keyword]?.[attr.key] ?? attr.key };
        }
      }
      return { keyword };
    }
  }
  return undefined;
}

// Declarations visible from a line: those declared before it, the latest one
// per name.
export function declarationsBefore(doc: SimEventsDocument, line: number, kind?: VarKind): Declaration[] {
  const visible = new Map<string, Declaration>();
  for (const decl of doc.declarations) {
    if (decl.nameSpan.line < line) {
      visible.set(decl.name, decl);
    }
  }
  return [...visible.values()].filter(decl => kind === undefined || decl.kind === kind);
}

export type CompletionContext =
  | { kind: 'lineStart'; blockKind?: BlockKind }
  | { kind: 'unit' }
  | { kind: 'variable'; varKind: VarKind }
  | { kind: 'eventType'; blockKind: BlockKind }
  | { kind: 'attributeKey'; eventType: string; blockKind: BlockKind; present: string[] }
  | { kind: 'attributeValue'; eventType: string; key: string }
  | { kind: 'none' };

const IDENT = String.raw`[A-Za-z_]\w*`;
const DATE_BASE = String.raw`(?:\d{4}-\d{2}-\d{2}(?:T[\d:.]+)?|${IDENT})`;
const TERMS = String.raw`(?:\s*[-+]\s*[-+]?[A-Za-z0-9_.]+)*`;
const EVENT_PREFIX = String.raw`^\s*(?<base>${DATE_BASE})${TERMS}`;

const DATE_OPERAND_RE = new RegExp(String.raw`${EVENT_PREFIX}\s*[-+]\s*[-+]?\w*$`);
const EVENT_TYPE_RE = new RegExp(String.raw`${EVENT_PREFIX}\s+\w*$`);
const ATTRIBUTE_RE = new RegExp(String.raw`${EVENT_PREFIX}\s+(?<type>${IDENT})\s+(?<attrs>.*)$`);

export function blockKindAt(doc: SimEventsDocument, line: number): BlockKind | undefined {
  let kind: BlockKind | undefined;
  for (const block of doc.blocks) {
    if (block.line < line) {
      kind = block.kind;
    }
  }
  return kind;
}

function inRawText(doc: SimEventsDocument, line: number): boolean {
  return doc.blocks.some(b => b.events.some(e => e.rawBody && e.rawBody.startLine <= line && line <= e.rawBody.endLine + 1));
}

// What kind of completion fits at a position, from the text before it.
export function completionContext(doc: SimEventsDocument, lines: string[], line: number, character: number): CompletionContext {
  const prefix = (lines[line] ?? '').slice(0, character);
  const inQuotes = (prefix.match(/"/g) ?? []).length % 2 === 1;
  if (inRawText(doc, line) || inQuotes || stripComment(prefix) !== prefix) {
    return { kind: 'none' };
  }
  const blockKind = blockKindAt(doc, line);

  if (/^\s*\w*$/.test(prefix)) {
    return { kind: 'lineStart', blockKind };
  }
  if (/^\s*UNIT\s+\w*$/.test(prefix)) {
    return { kind: 'unit' };
  }
  if (/^\s*WELL\s+\w*$/.test(prefix)) {
    return { kind: 'variable', varKind: 'WELL' };
  }
  const decl = new RegExp(String.raw`^\s*(?<kind>DATE|DURATION)\s+${IDENT}\s*=\s*(?<value>.*)$`).exec(prefix);
  if (decl) {
    const operand = /[-+]\s*\w*$/.test(decl.groups!.value);
    if (decl.groups!.kind === 'DATE' && !operand) {
      return /^\w*$/.test(decl.groups!.value) ? { kind: 'variable', varKind: 'DATE' } : { kind: 'none' };
    }
    return /^\w*$/.test(decl.groups!.value) || operand ? { kind: 'variable', varKind: 'DURATION' } : { kind: 'none' };
  }
  if (TOP_LEVEL_KEYWORDS.includes(prefix.trim().split(/\s+/)[0])) {
    return { kind: 'none' };
  }
  if (!blockKind) {
    return { kind: 'none' };
  }
  if (DATE_OPERAND_RE.test(prefix)) {
    return { kind: 'variable', varKind: 'DURATION' };
  }
  if (EVENT_TYPE_RE.test(prefix)) {
    return { kind: 'eventType', blockKind };
  }
  const event = ATTRIBUTE_RE.exec(prefix);
  if (event) {
    const eventType = event.groups!.type.toUpperCase();
    const attrs = event.groups!.attrs;
    const value = new RegExp(String.raw`(?:^|\s)(?<key>${IDENT})\s*=\s*[^\s"]*$`).exec(attrs);
    if (value) {
      return { kind: 'attributeValue', eventType, key: value.groups!.key.toUpperCase() };
    }
    if (/(?:^|\s)\w*$/.test(attrs)) {
      const present = [...attrs.matchAll(new RegExp(String.raw`(${IDENT})\s*=`, 'g'))].map(m => m[1].toUpperCase());
      return { kind: 'attributeKey', eventType, blockKind, present };
    }
  }
  return { kind: 'none' };
}

export const BLOCK_EVENT_TYPES: Record<BlockKind, string[]> = {
  WELL: ['PERFORATION', 'SEGMENT', 'VALVE', 'STATE', 'WELSPECS'],
  GROUP: ['MEMBER'],
  SCHEDULE: ['INSERT_DATE', 'RESTART', 'RAW_TEXT'],
  NONE: [],
};

// Eclipse keywords that fit a block: SCHEDULE keywords whose first item the
// block supplies (WELL or GROUP), or any SCHEDULE keyword in a SCHEDULE block.
export function blockKeywords(keywords: Map<string, KeywordInfo>, blockKind: BlockKind): string[] {
  const injected = BLOCK_INJECTED_ITEM[blockKind];
  return [...keywords]
    .filter(([, k]) => k.sections.includes('SCHEDULE') && (blockKind === 'SCHEDULE' || k.items[0] === injected))
    .map(([name]) => name);
}

// Attribute names for a pass-through keyword, without the injected block
// item and with rips' SIMEVENTS spellings.
export function keywordAttributes(keyword: KeywordInfo, type: string, blockKind: BlockKind): string[] {
  const injected = BLOCK_INJECTED_ITEM[blockKind];
  const aliases = Object.entries(KEYWORD_ITEM_ALIASES[type] ?? {});
  return keyword.items
    .filter(item => item !== injected)
    .map(item => aliases.find(([, target]) => target === item)?.[0] ?? item);
}
