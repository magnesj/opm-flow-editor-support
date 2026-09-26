// Parser and validator for SIMEVENTS well-event-timeline files.
//
// A port of the parser layer of ResInsight's rips.simulator_events (format
// version 1.2), plus the event checks its applier performs without a live
// project. Regexes and messages follow the Python so both report the same
// problems; unlike the Python, parsing never aborts and every issue carries a
// source range.

export interface Span {
  line: number;
  start: number;
  end: number;
}

export type Severity = 'error' | 'warning';

export interface SimEventsIssue {
  message: string;
  severity: Severity;
  span: Span;
}

export type VarKind = 'DATE' | 'DURATION' | 'WELL' | 'FILTER';

export interface Duration {
  months: number;
  seconds: number;
}

export interface FilterTerm {
  resultName: string;
  resultType?: string;
  op: string;
  value: number;
}

export interface FilterExpr {
  terms: FilterTerm[];
  combineMode: string;
  raw: string;
}

export interface Declaration {
  name: string;
  kind: VarKind;
  nameSpan: Span;
  // Milliseconds since the epoch for DATE (naive, UTC fields), Duration,
  // well name, or FilterExpr. Undefined when the value failed to evaluate.
  value?: number | Duration | string | FilterExpr;
}

export interface VarReference {
  name: string;
  kind: VarKind;
  span: Span;
  declaration?: Declaration;
}

export type AttrValueType = 'bool' | 'int' | 'float' | 'string';

export interface Attribute {
  key: string;
  raw: string;
  quoted: boolean;
  value: string | number | boolean;
  valueType: AttrValueType;
  keySpan: Span;
  valueSpan: Span;
}

export interface SimEvent {
  type: string;
  typeSpan: Span;
  dateSpan: Span;
  date?: number;
  attributes: Map<string, Attribute>;
  line: number;
  // First and last line of a RAW_TEXT body.
  rawBody?: { startLine: number; endLine: number };
}

export type BlockKind = 'WELL' | 'GROUP' | 'SCHEDULE' | 'NONE';

export interface Block {
  kind: BlockKind;
  name?: string;
  nameSpan?: Span;
  line: number;
  endLine: number;
  events: SimEvent[];
  // False for a block whose opening line failed to parse (or event lines
  // outside any block); its events are kept for navigation but not validated.
  valid: boolean;
}

export interface SimEventsDocument {
  version?: string;
  unit: string;
  declarations: Declaration[];
  references: VarReference[];
  blocks: Block[];
  issues: SimEventsIssue[];
}

export const SUPPORTED_VERSION = '1.2';
export const TOP_LEVEL_KEYWORDS = ['SIMEVENTS', 'UNIT', 'DATE', 'DURATION', 'WELL', 'FILTER', 'GROUP', 'SCHEDULE'];
export const UNIT_SYSTEMS = ['METRIC', 'FIELD', 'LAB'];
export const DURATION_UNITS = ['mon', 'd', 'h', 'm', 's'];
export const RAW_TEXT_PLACEMENTS = ['AFTER_DATE', 'BEFORE_KEYWORD', 'AFTER_KEYWORD', 'END_OF_DATE'];
export const COMPLETION_EVENT_TYPES = ['PERFORATION', 'SEGMENT', 'VALVE', 'STATE', 'WELSPECS'];

export interface EventAttributeSpec {
  required: string[];
  optional: string[];
}

// Attributes of the built-in event types, keyed by upper-case event type.
export const BUILTIN_EVENT_ATTRIBUTES: Record<string, EventAttributeSpec> = {
  PERFORATION: {
    required: ['MDSTART', 'MDEND'],
    optional: ['DIAMETER', 'SKIN', 'COMPLETION_NUMBER', 'FILTER', 'COMMENT'],
  },
  SEGMENT: {
    required: ['MDSTART', 'MDEND'],
    optional: ['INNER_DIAMETER', 'ROUGHNESS', 'PRESSURE_COMPONENTS', 'COMMENT'],
  },
  VALVE: {
    required: ['MD', 'TYPE'],
    optional: [
      'STATE', 'CV', 'AREA', 'COMMENT', 'AICD_STRENGTH', 'AICD_DENSITY_CALIB_FLUID',
      'AICD_VISCOSITY_CALIB_FLUID', 'AICD_VOL_FLOW_EXP', 'AICD_VISC_FUNC_EXP',
    ],
  },
  STATE: { required: ['STATE'], optional: ['COMMENT'] },
  WELSPECS: { required: [], optional: ['GROUP', 'CROSSFLOW', 'REFDEPTH', 'PHASE', 'COMMENT'] },
  MEMBER: { required: ['MEMBERS'], optional: ['COMMENT'] },
  INSERT_DATE: { required: [], optional: ['EVERY', 'UNTIL', 'COMMENT'] },
  RAW_TEXT: { required: ['PLACEMENT'], optional: ['ANCHOR', 'PRIORITY'] },
  RESTART: { required: [], optional: [] },
};

// Enumerated attribute values, keyed by "EVENT.ATTRIBUTE".
export const ATTRIBUTE_VALUES: Record<string, string[]> = {
  'WELSPECS.PHASE': ['OIL', 'GAS', 'WATER', 'LIQUID'],
  'WELSPECS.CROSSFLOW': ['True', 'False'],
  'SEGMENT.PRESSURE_COMPONENTS': ['H--', 'HF-', 'HFA'],
  'RAW_TEXT.PLACEMENT': RAW_TEXT_PLACEMENTS,
};

// SIMEVENTS attribute names that rips renames before passing a keyword on.
export const KEYWORD_ITEM_ALIASES: Record<string, Record<string, string>> = {
  WCONHIST: { VFP: 'VFP_TABLE' },
  WELTARG: { VALUE: 'NEW_VALUE' },
};

const RESULT_TYPE_ALIASES: Record<string, string> = {
  STATIC: 'STATIC_NATIVE',
  STATIC_NATIVE: 'STATIC_NATIVE',
  DYNAMIC: 'DYNAMIC_NATIVE',
  DYNAMIC_NATIVE: 'DYNAMIC_NATIVE',
  GENERATED: 'GENERATED',
};

const DURATION_UNIT_SECONDS: Record<string, number | undefined> = { mon: undefined, d: 86400, h: 3600, m: 60, s: 1 };
const DURATION_UNIT_LIST = DURATION_UNITS.join(', ');
const DURATION_NO_FRACTION_UNITS = new Set(['mon', 's']);

// ---------------------------------------------------------------------------
// Regexes, ported from the Python. The 'd' flag gives group offsets, which
// become issue and reference ranges.
// ---------------------------------------------------------------------------

const IDENT = String.raw`[A-Za-z_]\w*`;
const ISO_DATE = String.raw`\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?`;
const DATE_BASE = `(?<base>${ISO_DATE}|${IDENT})`;
const DURATION_LIT = String.raw`[-+]?\d+(?:\.\d+)?(?:[A-Za-z]+\d+(?:\.\d+)?)*[A-Za-z]*`;
const TERMS_BODY = String.raw`(?:\s*[-+]\s*(?:${DURATION_LIT}|${IDENT}))*`;
const TERMS = `(?<terms>${TERMS_BODY})`;
const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const TIME_OF_DAY = String.raw`\d{2}:\d{2}:\d{2}(?:\.\d+)?`;

const rx = (source: string, flags = ''): RegExp => new RegExp(source, flags + 'd');

const HEADER_RE = rx(String.raw`^SIMEVENTS\s+(?<version>\d+\.\d+)$`);
const UNIT_RE = rx(String.raw`^UNIT\s+(?<unit>METRIC|FIELD|LAB)$`);
const DATE_DECL_RE = rx(String.raw`^DATE\s+(?<name>${IDENT})\s*=\s*${DATE_BASE}${TERMS}$`);
const DURATION_DECL_RE = rx(String.raw`^DURATION\s+(?<name>${IDENT})\s*=\s*(?<base>${DURATION_LIT}|${IDENT})${TERMS}$`);
const WELL_DECL_RE = rx(String.raw`^WELL\s+(?<name>${IDENT})\s*=\s*"(?<well>[^"]*)"$`);
const LEGACY_INSERT_DATE_RE = rx(
  String.raw`^INSERT_DATE\s+${DATE_BASE}${TERMS}` +
  String.raw`(?:\s+EVERY\s+(?:(?<count>\d+)\s+)?` +
  String.raw`(?<period>DAY|DAYS|MONTH|MONTHS|YEAR|YEARS)` +
  String.raw`(?:\s+UNTIL\s+(?<end_base>${ISO_DATE}|${IDENT})` +
  `(?<end_terms>${TERMS_BODY})` +
  ')?)?$',
);
const FILTER_DECL_RE = rx(String.raw`^FILTER\s+(?<name>${IDENT})\s*=\s*"(?<expr>[^"]*)"$`);
const FILTER_SPLIT_RE = /\s+(AND|OR)\s+/;
const FILTER_TERM_RE = rx(String.raw`^(?:(?<qual>${IDENT})\.)?(?<name>${IDENT})\s*(?<op>>=|<=|>|<)\s*(?<value>${NUMBER})$`);
const WELL_BLOCK_RE = rx(String.raw`^WELL\s+(?:"(?<qname>[^"]*)"|(?<ref>${IDENT}))$`);
const GROUP_BLOCK_RE = rx(String.raw`^GROUP\s+"(?<name>[^"]*)"$`);
const EVENT_RE = rx(String.raw`^${DATE_BASE}${TERMS}\s+(?<rest>.+)$`);
const DURATION_EXPR_RE = rx(String.raw`^\s*(?<base>${DURATION_LIT}|${IDENT})${TERMS}\s*$`);
const DATE_EXPR_RE = rx(String.raw`^\s*${DATE_BASE}${TERMS}\s*$`);
const TERM_RE = rx(String.raw`([-+])\s*(${DURATION_LIT}|${IDENT})`, 'g');
const DURATION_COMPONENT_RE = rx(String.raw`(?<number>\d+(?:\.\d+)?)(?<unit>[A-Za-z]*)`, 'y');
const ATTR_RE = rx(String.raw`(?<key>[A-Za-z_]\w*)\s*=\s*(?:"(?<qval>[^"]*)"|(?<val>\S+))`, 'g');
const IDENT_RE = new RegExp(`^${IDENT}$`);

type Indices = Array<[number, number] | undefined> & { groups?: Record<string, [number, number] | undefined> };
type IndexedMatch = RegExpExecArray & { indices: Indices };

function match(re: RegExp, text: string): IndexedMatch | null {
  re.lastIndex = 0;
  return re.exec(text) as IndexedMatch | null;
}

function matchAll(re: RegExp, text: string): IndexedMatch[] {
  return [...text.matchAll(re)] as IndexedMatch[];
}

function groupStart(m: IndexedMatch, name: string): number {
  return m.indices.groups?.[name]?.[0] ?? 0;
}

// ---------------------------------------------------------------------------
// Fuzzy matching: difflib.get_close_matches with n=1.
// ---------------------------------------------------------------------------

function matchingCharacters(a: string, b: string): number {
  let best = 0;
  let bestI = 0;
  let bestJ = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) {
        k++;
      }
      if (k > best) {
        best = k;
        bestI = i;
        bestJ = j;
      }
    }
  }
  if (best === 0) {
    return 0;
  }
  return best +
    matchingCharacters(a.slice(0, bestI), b.slice(0, bestJ)) +
    matchingCharacters(a.slice(bestI + best), b.slice(bestJ + best));
}

export function similarity(a: string, b: string): number {
  const total = a.length + b.length;
  return total === 0 ? 1 : (2 * matchingCharacters(a, b)) / total;
}

export function closeMatch(word: string, possibilities: Iterable<string>, cutoff = 0.6): string | undefined {
  let best: string | undefined;
  let bestScore = -1;
  for (const candidate of possibilities) {
    const score = similarity(candidate, word);
    // Ties go to the larger string, as heapq.nlargest does in difflib.
    if (score >= cutoff && (score > bestScore || (score === bestScore && best !== undefined && candidate > best))) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function didYouMean(word: string, possibilities: Iterable<string>, cutoff = 0.6): string {
  const close = closeMatch(word, possibilities, cutoff);
  return close ? `; did you mean '${close}'?` : '';
}

// Python's repr() of a str, as used in the rips messages.
function pyRepr(text: string): string {
  if (text.includes("'") && !text.includes('"')) {
    return `"${text}"`;
  }
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// ---------------------------------------------------------------------------
// Dates and durations. A date is milliseconds since the epoch, read with the
// UTC accessors as a naive date-time with second resolution.
// ---------------------------------------------------------------------------

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function makeDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

const MIN_DATE = makeDate(1, 1, 1);
const MAX_DATE = makeDate(9999, 12, 31, 23, 59, 59);

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff === 0.5) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(value);
}

export function addMonths(date: number, months: number): number {
  if (!months) {
    return date;
  }
  const d = new Date(date);
  const monthIndex = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  if (year < 1 || year > 9999) {
    throw new RangeError('year is out of range');
  }
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month));
  return makeDate(year, month, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

export function addDuration(date: number, duration: Duration): number {
  const result = addMonths(date, duration.months) + duration.seconds * 1000;
  if (result < MIN_DATE || result > MAX_DATE) {
    throw new RangeError('date value out of range');
  }
  return result;
}

export function formatDate(date: number): string {
  const iso = new Date(date).toISOString();
  const year = new Date(date).getUTCFullYear();
  const text = String(year).padStart(4, '0') + iso.slice(iso.indexOf('-', 1), 19);
  return text.endsWith('T00:00:00') ? text.slice(0, 10) : text;
}

export function formatDuration(duration: Duration): string {
  const { months, seconds } = duration;
  if (months && seconds && (months < 0) !== (seconds < 0)) {
    return `${formatDuration({ months, seconds: 0 })} ${seconds < 0 ? '-' : '+'} ${formatDuration({ months: 0, seconds: Math.abs(seconds) })}`;
  }
  const negative = months < 0 || (months === 0 && seconds < 0);
  let rest = Math.abs(seconds);
  const days = Math.floor(rest / 86400);
  rest -= days * 86400;
  const hours = Math.floor(rest / 3600);
  rest -= hours * 3600;
  const minutes = Math.floor(rest / 60);
  rest -= minutes * 60;
  const parts = ([[Math.abs(months), 'mon'], [days, 'd'], [hours, 'h'], [minutes, 'm'], [rest, 's']] as [number, string][])
    .filter(([value]) => value)
    .map(([value, unit]) => `${value}${unit}`);
  if (parts.length === 0) {
    return '0s';
  }
  return (negative ? '-' : '') + parts.join('');
}

function addDurations(a: Duration, b: Duration, sign = 1): Duration {
  return { months: a.months + sign * b.months, seconds: a.seconds + sign * b.seconds };
}

// Python's int()/float() acceptance, used to type bare attribute values.
function inferValue(raw: string): { value: string | number | boolean; valueType: AttrValueType } {
  const upper = raw.toUpperCase();
  if (upper === 'TRUE') {
    return { value: true, valueType: 'bool' };
  }
  if (upper === 'FALSE') {
    return { value: false, valueType: 'bool' };
  }
  if (/^[+-]?\d+(?:_\d+)*$/.test(raw)) {
    return { value: Number(raw.replace(/_/g, '')), valueType: 'int' };
  }
  if (/^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/.test(raw)) {
    return { value: Number(raw.replace(/_/g, '')), valueType: 'float' };
  }
  if (/^[+-]?(?:inf|infinity|nan)$/i.test(raw)) {
    return { value: Number(raw.replace(/inf(inity)?/i, 'Infinity').replace(/nan/i, 'NaN')), valueType: 'float' };
  }
  return { value: raw, valueType: 'string' };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class ParseFail extends Error {
  constructor(message: string, readonly start?: number, readonly end?: number) {
    super(message);
  }
}

interface LineContext {
  line: number;
  // Comment-stripped, trimmed text.
  text: string;
  // Column of text[0] in the source line.
  col: number;
}

interface InsertDateSpec {
  event: SimEvent;
  every?: Duration;
  end?: number;
}

export function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuote = !inQuote;
    }
    if (char === '#' && !inQuote) {
      return line.slice(0, i);
    }
  }
  return line;
}

function firstToken(text: string): string {
  return text.split(/\s+/, 1)[0];
}

class Parser {
  private readonly doc: SimEventsDocument = {
    unit: 'METRIC',
    declarations: [],
    references: [],
    blocks: [],
    issues: [],
  };
  private readonly variables = new Map<string, Declaration>();
  private readonly insertDates: InsertDateSpec[] = [];
  private current?: Block;
  private ctx: LineContext = { line: 0, text: '', col: 0 };

  constructor(private readonly lines: string[]) {}

  run(): SimEventsDocument {
    let headerSeen = false;
    let index = 0;
    while (index < this.lines.length) {
      const lineNo = index;
      const stripped = stripComment(this.lines[index]);
      index++;
      const text = stripped.trim();
      if (!text) {
        continue;
      }
      this.ctx = { line: lineNo, text, col: stripped.length - stripped.trimStart().length };

      if (!headerSeen) {
        headerSeen = true;
        if (this.parseHeader()) {
          continue;
        }
      }

      if (this.isRawTextHeader(text)) {
        let end = index;
        while (end < this.lines.length && this.lines[end].trim() !== 'END_RAW_TEXT') {
          end++;
        }
        if (end === this.lines.length) {
          this.error('Unterminated RAW_TEXT block');
          break;
        }
        const bodyStart = index;
        index = end + 1;
        this.guard(() => this.parseRawText(bodyStart, end - 1));
        continue;
      }

      const first = firstToken(text);
      const ok = this.guard(() => {
        this.current = this.parseLine(first);
      });
      if (!ok && (['WELL', 'GROUP', 'SCHEDULE'].includes(first) || (match(EVENT_RE, text) && !this.current))) {
        // Swallow the lines of a broken or missing block instead of
        // reporting each of them.
        this.current = this.openBlock(['WELL', 'GROUP', 'SCHEDULE'].includes(first) ? first as BlockKind : 'NONE', false);
      }
    }

    if (!headerSeen) {
      this.doc.issues.push({
        message: "Empty file: missing 'SIMEVENTS' header",
        severity: 'error',
        span: { line: 0, start: 0, end: 0 },
      });
    }

    for (const block of this.doc.blocks) {
      for (const event of block.events) {
        block.endLine = Math.max(block.endLine, event.rawBody?.endLine !== undefined ? event.rawBody.endLine + 1 : event.line);
      }
    }
    this.checkRestarts();
    this.checkDuplicateWellspecs();
    this.checkInsertDates();
    return this.doc;
  }

  // Returns false when fn failed and its issue was recorded.
  private guard(fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (e) {
      if (!(e instanceof ParseFail)) {
        throw e;
      }
      this.error(e.message, e.start, e.end);
      return false;
    }
  }

  private span(start?: number, end?: number): Span {
    if (start === undefined || end === undefined) {
      return { line: this.ctx.line, start: this.ctx.col, end: this.ctx.col + this.ctx.text.length };
    }
    return { line: this.ctx.line, start: this.ctx.col + start, end: this.ctx.col + end };
  }

  private error(message: string, start?: number, end?: number): void {
    this.doc.issues.push({ message, severity: 'error', span: this.span(start, end) });
  }

  private warning(message: string, start?: number, end?: number): void {
    this.doc.issues.push({ message, severity: 'warning', span: this.span(start, end) });
  }

  private parseHeader(): boolean {
    const m = match(HEADER_RE, this.ctx.text);
    if (!m) {
      this.error("File must start with 'SIMEVENTS <version>'");
      return firstToken(this.ctx.text) === 'SIMEVENTS';
    }
    const version = m.groups!.version;
    this.doc.version = version;
    if (version !== SUPPORTED_VERSION) {
      let message = `Unsupported SIMEVENTS version '${version}'; expected ${SUPPORTED_VERSION}`;
      if (version === '1.1') {
        message += " (1.2 writes INSERT_DATE as a SCHEDULE event, e.g. " +
          "'INSERT_DATE 2024-01-01 EVERY 3 MONTHS' -> '2024-01-01 INSERT_DATE EVERY=3mon')";
      } else if (version === '1.0') {
        message += " (durations require a unit, e.g. '5 DAYS' -> '5d', dates use 'T' " +
          'between date and time, and INSERT_DATE is written as a SCHEDULE ' +
          "event, e.g. '2024-01-01 INSERT_DATE EVERY=3mon')";
      }
      const [start, end] = m.indices.groups!.version!;
      this.error(message, start, end);
    }
    return true;
  }

  private openBlock(kind: BlockKind, valid: boolean, name?: string, nameStart?: number, nameEnd?: number): Block {
    const block: Block = {
      kind,
      name,
      nameSpan: nameStart !== undefined ? this.span(nameStart, nameEnd) : undefined,
      line: this.ctx.line,
      endLine: this.ctx.line,
      events: [],
      valid,
    };
    this.doc.blocks.push(block);
    return block;
  }

  private parseLine(first: string): Block | undefined {
    const text = this.ctx.text;

    if (first === 'UNIT') {
      const m = match(UNIT_RE, text);
      if (!m) {
        throw new ParseFail(`Malformed UNIT line: ${pyRepr(text)} (expected UNIT METRIC|FIELD|LAB)`);
      }
      this.doc.unit = m.groups!.unit;
      return this.current;
    }

    if (first === 'GROUP') {
      const m = match(GROUP_BLOCK_RE, text);
      if (!m) {
        throw new ParseFail(`Malformed GROUP line: ${pyRepr(text)} (expected GROUP "<group-name>")`);
      }
      const [start, end] = m.indices.groups!.name!;
      return this.openBlock('GROUP', true, m.groups!.name, start - 1, end + 1);
    }

    if (first === 'SCHEDULE') {
      if (text !== 'SCHEDULE') {
        throw new ParseFail(`Malformed SCHEDULE line: ${pyRepr(text)} (SCHEDULE takes no arguments)`);
      }
      return this.openBlock('SCHEDULE', true);
    }

    if (first === 'INSERT_DATE') {
      throw new ParseFail(legacyInsertDateMessage(text));
    }

    if (first === 'DATE') {
      const m = match(DATE_DECL_RE, text);
      if (!m) {
        const hint = new RegExp(String.raw`\d{4}-\d{2}-\d{2}\s+${TIME_OF_DAY}`).test(text)
          ? "; a time-of-day must be joined to the date with 'T'"
          : '';
        throw new ParseFail(
          `Malformed DATE declaration: ${pyRepr(text)} ` +
          '(expected DATE NAME = <iso-datetime|DATE-var> [+|- <duration|DURATION-var> ...])' + hint,
        );
      }
      this.declareWith(m, 'DATE', () =>
        this.evalDateExpr(m.groups!.base, groupStart(m, 'base'), m.groups!.terms, groupStart(m, 'terms')));
      return this.current;
    }

    if (first === 'DURATION') {
      const m = match(DURATION_DECL_RE, text);
      if (!m) {
        const hint = /\b(?:DAYS|days)\b/.test(text) ? '; the DAYS suffix is not supported, write e.g. 5d' : '';
        throw new ParseFail(
          `Malformed DURATION declaration: ${pyRepr(text)} ` +
          '(expected DURATION NAME = <duration|DURATION-var> [+|- ...], e.g. DURATION RAMP = 5d12h)' + hint,
        );
      }
      this.declareWith(m, 'DURATION', () =>
        this.evalDurationExpr(m.groups!.base, groupStart(m, 'base'), m.groups!.terms, groupStart(m, 'terms')));
      return this.current;
    }

    if (first === 'FILTER') {
      const m = match(FILTER_DECL_RE, text);
      if (!m) {
        throw new ParseFail(
          `Malformed FILTER declaration: ${pyRepr(text)} ` +
          '(expected FILTER NAME = "<result> <op> <number> [AND|OR ...]")',
        );
      }
      const start = groupStart(m, 'expr');
      this.declareWith(m, 'FILTER', () => parseFilterExpr(m.groups!.expr, start, start + m.groups!.expr.length));
      return this.current;
    }

    if (first === 'WELL') {
      const decl = match(WELL_DECL_RE, text);
      if (decl) {
        this.declareWith(decl, 'WELL', () => decl.groups!.well);
        return this.current;
      }
      const m = match(WELL_BLOCK_RE, text);
      if (!m) {
        throw new ParseFail(
          `Malformed WELL line: ${pyRepr(text)} (well names containing special ` +
          'characters must be double-quoted, e.g. WELL "55_33-A-1")',
        );
      }
      if (m.groups!.qname !== undefined) {
        const [start, end] = m.indices.groups!.qname!;
        return this.openBlock('WELL', true, m.groups!.qname, start - 1, end + 1);
      }
      const [start, end] = m.indices.groups!.ref!;
      const value = this.lookup(m.groups!.ref, 'WELL', start);
      return this.openBlock('WELL', true, value as string | undefined, start, end);
    }

    if (first === 'REPORT') {
      throw new ParseFail('REPORT has been renamed to INSERT_DATE and is only valid in a SCHEDULE block');
    }

    const isEvent = match(EVENT_RE, text) !== null;
    if (this.current && isEvent) {
      const event = this.parseEventLine();
      if (event.type.toUpperCase() === 'INSERT_DATE') {
        if (this.current.kind !== 'SCHEDULE' || !this.current.valid) {
          throw new ParseFail('INSERT_DATE is only valid in a SCHEDULE block');
        }
        this.insertDates.push(this.insertDateSpec(event));
      }
      this.current.events.push(event);
      return this.current;
    }
    if (/^\d/.test(first) && isEvent) {
      throw new ParseFail('Event line found before any WELL or SCHEDULE block');
    }

    throw new ParseFail(unrecognizedLineMessage(text, first));
  }

  // The value is evaluated before the name is declared, so a declaration
  // cannot refer to itself. A declaration whose value fails is still recorded
  // for navigation, without a value, so its uses are not reported again.
  private declareWith(m: IndexedMatch, kind: VarKind, evaluate: () => NonNullable<Declaration['value']>): void {
    const name = m.groups!.name;
    const [start, end] = m.indices.groups!.name!;
    let value: Declaration['value'];
    try {
      value = evaluate();
    } catch (e) {
      const existing = this.variables.get(name);
      if (e instanceof ParseFail && (!existing || existing.kind === kind)) {
        this.addDeclaration(name, kind, start, end);
      }
      throw e;
    }
    const existing = this.variables.get(name);
    if (existing) {
      if (existing.kind !== kind) {
        throw new ParseFail(
          `'${name}' is already declared as ${existing.kind} ` +
          `(line ${existing.nameSpan.line + 1}); cannot redeclare as ${kind}`,
          start,
          end,
        );
      }
      this.warning(`Duplicate ${kind} '${name}'`, start, end);
    }
    this.addDeclaration(name, kind, start, end).value = value;
  }

  private addDeclaration(name: string, kind: VarKind, start: number, end: number): Declaration {
    const decl: Declaration = { name, kind, nameSpan: this.span(start, end) };
    this.variables.set(name, decl);
    this.doc.declarations.push(decl);
    return decl;
  }

  private lookup(name: string, kind: VarKind, start: number): Declaration['value'] {
    const end = start + name.length;
    const decl = this.variables.get(name);
    this.doc.references.push({ name, kind, span: this.span(start, end), declaration: decl });
    if (!decl) {
      const sameKind = [...this.variables.values()].filter(v => v.kind === kind).map(v => v.name);
      const hint = didYouMean(name, sameKind.length ? sameKind : this.variables.keys());
      throw new ParseFail(`Unknown variable '${name}'${hint}`, start, end);
    }
    if (decl.kind !== kind) {
      throw new ParseFail(
        `Variable '${name}' is a ${decl.kind} (declared line ${decl.nameSpan.line + 1}) ` +
        `but a ${kind} is required here`,
        start,
        end,
      );
    }
    if (decl.value === undefined) {
      // The declaration itself failed and was reported there.
      throw new ParseFail('');
    }
    return decl.value;
  }

  private evalTerm(term: string, start: number): Duration {
    if (/^[\d+-]/.test(term)) {
      return parseDurationLiteral(term, start);
    }
    return this.lookup(term, 'DURATION', start) as Duration;
  }

  private evalTerms(terms: string, start: number): Duration {
    let total: Duration = { months: 0, seconds: 0 };
    for (const m of matchAll(TERM_RE, terms)) {
      const value = this.evalTerm(m[2], start + m.indices[2]![0]);
      total = addDurations(total, value, m[1] === '+' ? 1 : -1);
    }
    return total;
  }

  private evalDateExpr(base: string, baseStart: number, terms: string, termsStart: number): number {
    const date = /^\d/.test(base)
      ? parseIsoDateTime(base, baseStart)
      : this.lookup(base, 'DATE', baseStart) as number;
    const offset = this.evalTerms(terms, termsStart);
    try {
      return addDuration(date, offset);
    } catch {
      throw new ParseFail('Date is out of range (years 1 to 9999)', baseStart, termsStart + terms.length);
    }
  }

  private evalDurationExpr(base: string, baseStart: number, terms: string, termsStart: number): Duration {
    return addDurations(this.evalTerm(base, baseStart), this.evalTerms(terms, termsStart));
  }

  private isRawTextHeader(text: string): boolean {
    const m = match(EVENT_RE, text);
    return m !== null && firstToken(m.groups!.rest).toUpperCase() === 'RAW_TEXT';
  }

  private parseEventLine(): SimEvent {
    const text = this.ctx.text;
    const m = match(EVENT_RE, text);
    if (!m) {
      throw new ParseFail(`Malformed event line: ${pyRepr(text)}`);
    }
    const baseStart = groupStart(m, 'base');
    const termsStart = groupStart(m, 'terms');
    const rest = m.groups!.rest.trim();
    const restStart = groupStart(m, 'rest') + (m.groups!.rest.length - m.groups!.rest.trimStart().length);
    const type = firstToken(rest);
    const typeStart = restStart;
    const typeEnd = typeStart + type.length;
    const event: SimEvent = {
      type,
      typeSpan: this.span(typeStart, typeEnd),
      dateSpan: this.span(baseStart, termsStart + m.groups!.terms.length),
      attributes: new Map(),
      line: this.ctx.line,
    };
    event.date = this.evalDateExpr(m.groups!.base, baseStart, m.groups!.terms, termsStart);
    if (new RegExp(`^${TIME_OF_DAY}$`).test(type)) {
      throw new ParseFail(
        `Malformed event line: ${pyRepr(text)} (a time-of-day must be joined to the ` +
        `date with 'T', e.g. ${m.groups!.base}T${type})`,
        typeStart,
        typeEnd,
      );
    }
    const afterType = rest.slice(type.length);
    const attrText = afterType.trimStart();
    const attrStart = typeEnd + (afterType.length - attrText.length);
    event.attributes = this.parseAttributes(attrText, attrStart);

    const filter = event.attributes.get('FILTER');
    if (type.toUpperCase() === 'PERFORATION' && filter) {
      this.resolveEventFilter(filter);
    }
    return event;
  }

  private parseAttributes(text: string, offset: number): Map<string, Attribute> {
    const attributes = new Map<string, Attribute>();
    let pos = 0;
    for (const m of matchAll(ATTR_RE, text)) {
      const gap = text.slice(pos, m.index);
      if (gap.trim()) {
        throw new ParseFail(`Malformed attribute near ${pyRepr(gap.trim())}`, offset + pos, offset + m.index);
      }
      const [keyStart, keyEnd] = m.indices.groups!.key!;
      const quoted = m.groups!.qval !== undefined;
      const raw = quoted ? m.groups!.qval : m.groups!.val;
      const [valueStart, valueEnd] = m.indices.groups![quoted ? 'qval' : 'val']!;
      const typed = quoted ? { value: raw, valueType: 'string' as const } : inferValue(raw);
      const key = m.groups!.key.toUpperCase();
      attributes.set(key, {
        key,
        raw,
        quoted,
        ...typed,
        keySpan: this.span(offset + keyStart, offset + keyEnd),
        valueSpan: this.span(offset + valueStart, offset + valueEnd),
      });
      pos = m.index + m[0].length;
    }
    const trailing = text.slice(pos);
    if (trailing.trim()) {
      throw new ParseFail(`Malformed attribute near ${pyRepr(trailing.trim())}`, offset + pos, offset + text.length);
    }
    return attributes;
  }

  // Column of an attribute value relative to the line text.
  private valueStart(attr: Attribute): number {
    return attr.valueSpan.start - this.ctx.col;
  }

  private resolveEventFilter(attr: Attribute): void {
    const start = this.valueStart(attr);
    const end = start + attr.raw.length;
    if (attr.quoted) {
      parseFilterExpr(attr.raw, start, end);
      return;
    }
    if (!IDENT_RE.test(attr.raw)) {
      throw new ParseFail(
        `FILTER must name a declared FILTER variable or be a quoted expression, got ${pyRepr(attr.raw)}`,
        start,
        end,
      );
    }
    this.lookup(attr.raw, 'FILTER', start);
  }

  private insertDateSpec(event: SimEvent): InsertDateSpec {
    const unknown = [...event.attributes.keys()].filter(k => !['EVERY', 'UNTIL', 'COMMENT'].includes(k)).sort();
    if (unknown.length) {
      const attr = event.attributes.get(unknown[0])!;
      throw new ParseFail(
        `Unknown INSERT_DATE attribute(s): ${unknown.join(', ')} (expected EVERY, UNTIL)`,
        attr.keySpan.start - this.ctx.col,
        attr.keySpan.end - this.ctx.col,
      );
    }
    const spec: InsertDateSpec = { event };
    const every = event.attributes.get('EVERY');
    if (every) {
      const start = this.valueStart(every);
      const m = match(DURATION_EXPR_RE, every.raw);
      if (!m) {
        throw new ParseFail(
          `INSERT_DATE EVERY must be a duration, e.g. EVERY=1mon or EVERY=30d, got ${pyRepr(every.raw)}`,
          start,
          start + every.raw.length,
        );
      }
      const value = this.evalDurationExpr(
        m.groups!.base, start + groupStart(m, 'base'), m.groups!.terms, start + groupStart(m, 'terms'));
      if (value.months < 0 || value.seconds < 0 || (!value.months && !value.seconds)) {
        throw new ParseFail(
          `INSERT_DATE EVERY must be a positive duration, got ${pyRepr(every.raw)}`, start, start + every.raw.length);
      }
      spec.every = value;
    }
    const until = event.attributes.get('UNTIL');
    if (until) {
      const start = this.valueStart(until);
      if (!spec.every) {
        throw new ParseFail('INSERT_DATE UNTIL requires EVERY', until.keySpan.start - this.ctx.col, until.keySpan.end - this.ctx.col);
      }
      const m = match(DATE_EXPR_RE, until.raw);
      if (!m) {
        throw new ParseFail(
          `INSERT_DATE UNTIL must be a date expression, got ${pyRepr(until.raw)}`, start, start + until.raw.length);
      }
      spec.end = this.evalDateExpr(
        m.groups!.base, start + groupStart(m, 'base'), m.groups!.terms, start + groupStart(m, 'terms'));
    }
    return spec;
  }

  private parseRawText(bodyStart: number, bodyEnd: number): void {
    if (!this.current || this.current.kind !== 'SCHEDULE' || !this.current.valid) {
      throw new ParseFail('RAW_TEXT is only valid in a SCHEDULE block');
    }
    const event = this.parseEventLine();
    event.rawBody = { startLine: bodyStart, endLine: bodyEnd };
    const keyFail = (key: string, message: string): ParseFail => {
      const attr = event.attributes.get(key)!;
      return new ParseFail(message, attr.keySpan.start - this.ctx.col, attr.valueSpan.end - this.ctx.col);
    };
    const typeFail = (message: string): ParseFail =>
      new ParseFail(message, event.typeSpan.start - this.ctx.col, event.typeSpan.end - this.ctx.col);

    const unknown = [...event.attributes.keys()].filter(k => !['PLACEMENT', 'ANCHOR', 'PRIORITY'].includes(k)).sort();
    if (unknown.length) {
      throw keyFail(unknown[0], `Unknown RAW_TEXT attribute(s): ${unknown.join(', ')}`);
    }
    const placementAttr = event.attributes.get('PLACEMENT');
    if (!placementAttr) {
      throw typeFail('RAW_TEXT requires PLACEMENT');
    }
    if (bodyEnd < bodyStart) {
      throw typeFail('RAW_TEXT body must not be empty');
    }
    const placement = placementAttr.valueType === 'string' ? (placementAttr.value as string).toUpperCase() : '';
    if (!RAW_TEXT_PLACEMENTS.includes(placement)) {
      throw keyFail('PLACEMENT', 'RAW_TEXT PLACEMENT must be AFTER_DATE, BEFORE_KEYWORD, AFTER_KEYWORD, or END_OF_DATE');
    }
    const anchorAttr = event.attributes.get('ANCHOR');
    if (anchorAttr && (anchorAttr.valueType !== 'string' || !(anchorAttr.value as string).trim())) {
      throw keyFail('ANCHOR', 'RAW_TEXT ANCHOR must be a keyword name');
    }
    const anchored = placement === 'BEFORE_KEYWORD' || placement === 'AFTER_KEYWORD';
    if (anchored && !anchorAttr) {
      throw keyFail('PLACEMENT', 'RAW_TEXT ANCHOR is required for BEFORE_KEYWORD and AFTER_KEYWORD');
    }
    if (!anchored && anchorAttr) {
      throw keyFail('ANCHOR', 'RAW_TEXT ANCHOR is only valid for BEFORE_KEYWORD and AFTER_KEYWORD');
    }
    const priority = event.attributes.get('PRIORITY');
    if (priority && priority.valueType !== 'int') {
      throw keyFail('PRIORITY', 'RAW_TEXT PRIORITY must be an integer');
    }
    this.current.events.push(event);
  }

  private validBlocks(kind: BlockKind): Block[] {
    return this.doc.blocks.filter(b => b.valid && b.kind === kind);
  }

  private eventIssue(event: SimEvent, message: string): void {
    this.doc.issues.push({ message, severity: 'error', span: event.typeSpan });
  }

  private checkRestarts(): void {
    for (const block of [...this.validBlocks('WELL'), ...this.validBlocks('GROUP')]) {
      for (const event of block.events) {
        if (event.type.toUpperCase() === 'RESTART') {
          this.eventIssue(event, 'RESTART is only valid in a SCHEDULE block');
        }
      }
    }
    const restarts = this.validBlocks('SCHEDULE')
      .flatMap(b => b.events)
      .filter(e => e.type.toUpperCase() === 'RESTART');
    for (const event of restarts) {
      if (event.attributes.size) {
        this.eventIssue(event, 'RESTART takes no attributes');
      }
    }
    for (const event of restarts.slice(1)) {
      this.eventIssue(event, 'Only one RESTART event is allowed per schedule');
    }
  }

  private checkDuplicateWellspecs(): void {
    const seen = new Map<string, SimEvent>();
    for (const block of this.validBlocks('WELL')) {
      for (const event of block.events) {
        if (event.type.toUpperCase() !== 'WELSPECS' || event.date === undefined) {
          continue;
        }
        const key = `${block.name}\u0000${event.date}`;
        const previous = seen.get(key);
        if (previous) {
          this.eventIssue(event, `WELSPECS already defined (first definition on line ${previous.line + 1})`);
        } else {
          seen.set(key, event);
        }
      }
    }
  }

  private checkInsertDates(): void {
    const eventDates = this.doc.blocks
      .filter(b => b.valid && b.kind !== 'NONE')
      .flatMap(b => b.events)
      .filter(e => e.type.toUpperCase() !== 'INSERT_DATE' && e.date !== undefined)
      .map(e => e.date!);
    const lastEventDate = eventDates.length ? Math.max(...eventDates) : undefined;
    for (const spec of this.insertDates) {
      if (!spec.every || spec.event.date === undefined) {
        continue;
      }
      const end = spec.end ?? lastEventDate;
      if (end === undefined) {
        this.eventIssue(spec.event, 'Recurring INSERT_DATE without UNTIL requires at least one event');
      } else if (end < spec.event.date) {
        this.eventIssue(spec.event, 'INSERT_DATE end date must not precede its start date');
      }
    }
  }
}

function parseIsoDateTime(base: string, start: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?$/.exec(base)!;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(v => (v === undefined ? 0 : Number(v)));
  const fail = (reason: string): ParseFail => new ParseFail(`Invalid date '${base}': ${reason}`, start, start + base.length);
  if (year < 1) {
    throw fail(`year ${year} is out of range`);
  }
  if (month < 1 || month > 12) {
    throw fail('month must be in 1..12');
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw fail('day is out of range for month');
  }
  if (hour > 23) {
    throw fail('hour must be in 0..23');
  }
  if (minute > 59) {
    throw fail('minute must be in 0..59');
  }
  if (second > 59) {
    throw fail('second must be in 0..59');
  }
  let result = makeDate(year, month, day, hour, minute, second);
  if (m[7] !== undefined) {
    // Python keeps microseconds and rounds half to even: only more than half
    // a second rounds up.
    const micro = Number((m[7] + '000000').slice(0, 6));
    if (micro > 500000) {
      result += 1000;
    }
  }
  return result;
}

function parseDurationLiteral(text: string, start: number): Duration {
  const fail = (reason: string): ParseFail =>
    new ParseFail(`Invalid duration ${pyRepr(text)}: ${reason}`, start, start + text.length);
  let body = text;
  let negative = false;
  if (body[0] === '+' || body[0] === '-') {
    negative = body[0] === '-';
    body = body.slice(1);
  }
  if (!body || !/^\d/.test(body)) {
    throw fail(`expected <number><unit> components with units ${DURATION_UNIT_LIST}`);
  }

  const components: Array<[string, string]> = [];
  let pos = 0;
  while (pos < body.length) {
    DURATION_COMPONENT_RE.lastIndex = pos;
    const m = DURATION_COMPONENT_RE.exec(body);
    if (!m) {
      throw fail(`unexpected text ${pyRepr(body.slice(pos))}`);
    }
    components.push([m.groups!.number, m.groups!.unit]);
    pos = DURATION_COMPONENT_RE.lastIndex;
  }

  let months = 0;
  let seconds = 0;
  let previousOrder = -1;
  components.forEach(([number, unit], index) => {
    if (!unit) {
      if (components.length === 1) {
        throw fail(`a unit is required (${DURATION_UNIT_LIST}), e.g. ${number}d`);
      }
      throw fail(`missing unit after ${pyRepr(number)}`);
    }
    if (['DAY', 'DAYS'].includes(unit.toUpperCase())) {
      throw fail(`the DAYS suffix is not supported; write ${number}d`);
    }
    const order = DURATION_UNITS.indexOf(unit);
    if (order < 0) {
      throw fail(`unknown unit ${pyRepr(unit)} (expected ${DURATION_UNIT_LIST})${didYouMean(unit.toLowerCase(), DURATION_UNITS)}`);
    }
    if (order === previousOrder) {
      throw fail(`unit '${unit}' given more than once`);
    }
    if (order < previousOrder) {
      throw fail(
        `units must be in descending order (${DURATION_UNIT_LIST}); ` +
        `'${unit}' cannot follow '${components[index - 1][1]}'`,
      );
    }
    previousOrder = order;
    if (number.includes('.')) {
      if (index !== components.length - 1) {
        throw fail('a fraction is only allowed on the last component');
      }
      if (DURATION_NO_FRACTION_UNITS.has(unit)) {
        throw fail(`a fraction is not allowed on '${unit}'`);
      }
    }
    const unitSeconds = DURATION_UNIT_SECONDS[unit];
    if (unitSeconds === undefined) {
      months += Number(number);
    } else {
      seconds += Number(number) * unitSeconds;
    }
  });

  const duration = { months, seconds: roundHalfEven(seconds) };
  return negative ? { months: -duration.months, seconds: -duration.seconds } : duration;
}

// start/end locate the expression text in the line, for issue ranges.
function parseFilterExpr(text: string, start: number, end: number): FilterExpr {
  const stripped = text.trim();
  if (!stripped) {
    throw new ParseFail('Empty filter expression', start, end);
  }
  const parts = stripped.split(FILTER_SPLIT_RE);
  const chunks = parts.filter((_, i) => i % 2 === 0);
  const connectors = parts.filter((_, i) => i % 2 === 1);
  if (new Set(connectors).size > 1) {
    throw new ParseFail(
      'Filter expression mixes AND and OR; a combined filter has a single combine mode', start, end);
  }
  const terms = chunks.map(chunk => parseFilterTerm(chunk.trim(), start, end));
  return { terms, combineMode: connectors[0] ?? 'AND', raw: stripped };
}

function parseFilterTerm(chunk: string, start: number, end: number): FilterTerm {
  const m = match(FILTER_TERM_RE, chunk);
  if (!m) {
    throw new ParseFail(malformedFilterTermMessage(chunk), start, end);
  }
  const qual = m.groups!.qual;
  let resultType: string | undefined;
  if (qual !== undefined) {
    resultType = RESULT_TYPE_ALIASES[qual.toUpperCase()];
    if (!resultType) {
      const hint = didYouMean(qual.toUpperCase(), Object.keys(RESULT_TYPE_ALIASES).sort());
      throw new ParseFail(`Unknown result type '${qual}' in filter term ${pyRepr(chunk)}${hint}`, start, end);
    }
  }
  return {
    resultName: m.groups!.name.toUpperCase(),
    resultType,
    op: m.groups!.op,
    value: Number(m.groups!.value),
  };
}

function malformedFilterTermMessage(chunk: string): string {
  if (/\b(and|or)\b/.test(chunk)) {
    return `Malformed filter term ${pyRepr(chunk)}: combine keywords must be uppercase AND / OR`;
  }
  if (/(?<![<>])=/.test(chunk)) {
    return `Malformed filter term ${pyRepr(chunk)}: only >, >=, < and <= are ` +
      'supported in filter expressions (bounds are inclusive, so > behaves as >=)';
  }
  return `Malformed filter term ${pyRepr(chunk)} ` +
    '(expected NAME <op> NUMBER with >, >=, < or <=, optionally TYPE.NAME)';
}

function legacyInsertDateMessage(text: string): string {
  const message = 'INSERT_DATE is written as a SCHEDULE event since SIMEVENTS 1.2: ' +
    '<date-expr> INSERT_DATE [EVERY=<duration>] [UNTIL=<date-expr>]';
  const m = match(LEGACY_INSERT_DATE_RE, text);
  if (!m) {
    return message;
  }
  const g = m.groups!;
  const parts = [(g.base + g.terms).trim(), 'INSERT_DATE'];
  if (g.period) {
    const [unit, factor] = ({ DAY: ['d', 1], MONTH: ['mon', 1], YEAR: ['mon', 12] } as Record<string, [string, number]>)[g.period.replace(/S$/, '')];
    parts.push(`EVERY=${Number(g.count ?? 1) * factor}${unit}`);
  }
  if (g.end_base) {
    const until = (g.end_base + g.end_terms).trim();
    parts.push(until.includes(' ') ? `UNTIL="${until}"` : `UNTIL=${until}`);
  }
  return `${message}; write ${pyRepr(parts.join(' '))}`;
}

function unrecognizedLineMessage(text: string, first: string): string {
  if (first === 'SIMEVENTS') {
    return 'Duplicate SIMEVENTS header';
  }
  if (first === 'SET') {
    return 'SET is not supported; declare a typed variable instead, e.g. DATE NAME = 2018-01-01';
  }
  if (text.startsWith("'")) {
    return 'Single-quoted well names are not supported; open a well block with WELL "name"';
  }
  return `Unrecognized line: ${pyRepr(text)}${didYouMean(first, TOP_LEVEL_KEYWORDS)}`;
}

export function parseSimEvents(text: string): SimEventsDocument {
  const doc = new Parser(text.split(/\r\n|\r|\n/)).run();
  // An empty message marks a follow-on failure already reported elsewhere.
  doc.issues = doc.issues.filter(issue => issue.message !== '');
  return doc;
}
