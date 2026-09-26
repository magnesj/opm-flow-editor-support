import * as fs from 'fs';
import * as path from 'path';
import {
  closeMatch,
  formatDate,
  formatDuration,
  parseSimEvents,
  SimEventsDocument,
  stripComment,
} from './simevents';

const examplesDir = path.join(__dirname, '..', '..', 'examples', 'simevents');

const HEADER = 'SIMEVENTS 1.2\n';

function messages(doc: SimEventsDocument, severity = 'error'): string[] {
  return doc.issues.filter(i => i.severity === severity).map(i => i.message);
}

function errorsOf(text: string): string[] {
  return messages(parseSimEvents(HEADER + text));
}

function declared(doc: SimEventsDocument, name: string): unknown {
  return doc.declarations.find(d => d.name === name)?.value;
}

describe('sample files', () => {
  for (const file of fs.readdirSync(examplesDir).filter(f => f.endsWith('.events'))) {
    it(`parses ${file} without issues`, () => {
      const doc = parseSimEvents(fs.readFileSync(path.join(examplesDir, file), 'utf8'));
      expect(doc.issues).toEqual([]);
      expect(doc.version).toBe('1.2');
    });
  }

  it('builds blocks and events for simulator_events.events', () => {
    const doc = parseSimEvents(fs.readFileSync(path.join(examplesDir, 'simulator_events.events'), 'utf8'));
    expect(doc.blocks.map(b => `${b.kind}:${b.name ?? ''}:${b.events.length}`)).toEqual([
      'SCHEDULE::2',
      'SCHEDULE::1',
      'WELL:55_33-A-1:5',
      'WELL:55_33-A-2:3',
    ]);
    const raw = doc.blocks[1].events[0];
    expect(raw.type).toBe('RAW_TEXT');
    expect(raw.rawBody).toEqual({ startLine: 33, endLine: 36 });
    expect(doc.blocks[1].endLine).toBe(37);
  });
});

describe('header and unit', () => {
  it('requires the header on the first meaningful line', () => {
    expect(messages(parseSimEvents('# comment\n\nUNIT METRIC\n'))).toEqual([
      "File must start with 'SIMEVENTS <version>'",
    ]);
  });

  it('reports an empty file', () => {
    expect(messages(parseSimEvents('# nothing\n'))).toEqual(["Empty file: missing 'SIMEVENTS' header"]);
  });

  it('reports unsupported versions with a migration hint', () => {
    const [message] = messages(parseSimEvents('SIMEVENTS 1.1\n'));
    expect(message).toContain("Unsupported SIMEVENTS version '1.1'");
    expect(message).toContain('INSERT_DATE EVERY=3mon');
  });

  it('reports duplicate headers and malformed units', () => {
    expect(errorsOf('SIMEVENTS 1.2\nUNIT SI\n')).toEqual([
      'Duplicate SIMEVENTS header',
      "Malformed UNIT line: 'UNIT SI' (expected UNIT METRIC|FIELD|LAB)",
    ]);
    expect(parseSimEvents(HEADER + 'UNIT FIELD\n').unit).toBe('FIELD');
  });
});

describe('declarations and variables', () => {
  it('evaluates dates and durations', () => {
    const doc = parseSimEvents(HEADER +
      'DATE A = 2024-01-31\n' +
      'DURATION M = 1mon\n' +
      'DATE B = A + M\n' +
      'DATE C = 2024-05-15T14:45:30.6 + -1d12h\n' +
      'DURATION F = 1.5h - 30m\n');
    expect(doc.issues).toEqual([]);
    expect(formatDate(declared(doc, 'B') as number)).toBe('2024-02-29');
    expect(formatDate(declared(doc, 'C') as number)).toBe('2024-05-14T02:45:31');
    expect(formatDuration(declared(doc, 'F') as never)).toBe('1h');
  });

  it('records declarations and references with ranges', () => {
    const doc = parseSimEvents(HEADER + 'DATE START = 2024-01-01\nWELL "W"\n  START + 1d  STATE  STATE=SHUT\n');
    expect(doc.declarations[0].nameSpan).toEqual({ line: 1, start: 5, end: 10 });
    expect(doc.references).toHaveLength(1);
    expect(doc.references[0].span).toEqual({ line: 3, start: 2, end: 7 });
    expect(doc.references[0].declaration).toBe(doc.declarations[0]);
  });

  it('reports unknown variables with suggestions', () => {
    const doc = parseSimEvents(HEADER + 'DATE START = 2024-01-01\nDATE X = STRAT + 1d\n');
    expect(messages(doc)).toEqual(["Unknown variable 'STRAT'; did you mean 'START'?"]);
    expect(doc.issues[0].span).toEqual({ line: 2, start: 9, end: 14 });
  });

  it('reports type mismatches citing the declaration', () => {
    expect(errorsOf('DURATION RAMP = 5d\nDATE X = RAMP\n')).toEqual([
      "Variable 'RAMP' is a DURATION (declared line 2) but a DATE is required here",
    ]);
  });

  it('warns on same-type redeclaration and rejects a type change', () => {
    const doc = parseSimEvents(HEADER + 'DATE A = 2024-01-01\nDATE A = 2024-01-02\nDURATION A = 1d\n');
    expect(messages(doc, 'warning')).toEqual(["Duplicate DATE 'A'"]);
    expect(messages(doc)).toEqual(["'A' is already declared as DATE (line 3); cannot redeclare as DURATION"]);
  });

  it('does not let a declaration refer to itself', () => {
    expect(errorsOf('DATE X = X + 1d\n')).toEqual(["Unknown variable 'X'"]);
  });

  it('does not repeat errors for uses of a failed declaration', () => {
    expect(errorsOf('DATE X = 2024-02-30\nDATE Y = X + 1d\n')).toEqual([
      "Invalid date '2024-02-30': day is out of range for month",
    ]);
  });

  it('hints at a time-of-day written without T', () => {
    expect(errorsOf('DATE X = 2024-01-01 12:00:00\n')[0]).toContain("joined to the date with 'T'");
  });

  it('checks duration literals', () => {
    const cases: Array<[string, string]> = [
      ['5', "a unit is required (mon, d, h, m, s), e.g. 5d"],
      ['5days', 'the DAYS suffix is not supported; write 5d'],
      ['12m1h', "'h' cannot follow 'm'"],
      ['1d2d', "unit 'd' given more than once"],
      ['1.5d2h', 'a fraction is only allowed on the last component'],
      ['1.5mon', "a fraction is not allowed on 'mon'"],
      ['5x', "unknown unit 'x'"],
      ['5hr', "did you mean 'h'?"],
    ];
    for (const [literal, reason] of cases) {
      expect(errorsOf(`DURATION D = ${literal}\n`)[0]).toContain(reason);
    }
    expect(errorsOf('DURATION D = 5 DAYS\n')[0]).toContain('the DAYS suffix is not supported');
  });

  it('parses and checks filter expressions', () => {
    const doc = parseSimEvents(HEADER + 'FILTER F = "static.PORO > 0.1 AND PERMX <= 1e3"\n');
    expect(declared(doc, 'F')).toEqual({
      terms: [
        { resultName: 'PORO', resultType: 'STATIC_NATIVE', op: '>', value: 0.1 },
        { resultName: 'PERMX', resultType: undefined, op: '<=', value: 1000 },
      ],
      combineMode: 'AND',
      raw: 'static.PORO > 0.1 AND PERMX <= 1e3',
    });
    expect(errorsOf('FILTER F = "PORO > 0.1 AND PERMX > 1 OR SOIL > 0"\n')[0]).toContain('mixes AND and OR');
    expect(errorsOf('FILTER F = "PORO > 0.1 and PERMX > 1"\n')[0]).toContain('must be uppercase AND / OR');
    expect(errorsOf('FILTER F = "PORO = 0.1"\n')[0]).toContain('only >, >=, < and <=');
    expect(errorsOf('FILTER F = "DYNAMC.SOIL > 0.1"\n')[0]).toContain("did you mean 'DYNAMIC'?");
    expect(errorsOf('FILTER F = ""\n')).toEqual(['Empty filter expression']);
  });

  it('rejects legacy syntax with guidance', () => {
    expect(errorsOf('SET X = 1\n')[0]).toContain('SET is not supported');
    expect(errorsOf("WELL 'A-1'\n")[0]).toContain('Malformed WELL line');
    expect(errorsOf('REPORT 2024-01-01\n')[0]).toContain('REPORT has been renamed to INSERT_DATE');
    expect(errorsOf('INSERT_DATE 2024-01-01 EVERY 3 MONTHS\n')[0])
      .toContain("write '2024-01-01 INSERT_DATE EVERY=3mon'");
    expect(errorsOf('DUARTION X = 1d\n')[0]).toContain("did you mean 'DURATION'?");
  });
});

describe('blocks and events', () => {
  it('rejects events before any block', () => {
    expect(errorsOf('2024-01-01 WCONHIST STATUS=OPEN\n')).toEqual([
      'Event line found before any WELL or SCHEDULE block',
    ]);
  });

  it('does not cascade errors from a broken block', () => {
    expect(errorsOf('WELL UNKNOWN\n  2024-01-01 STATE STATE=OPEN\n  2024-01-02 STATE STATE=SHUT\n')).toEqual([
      "Unknown variable 'UNKNOWN'",
    ]);
  });

  it('opens well blocks by alias and literal name', () => {
    const doc = parseSimEvents(HEADER + 'WELL A1 = "55_33-A-1"\nWELL A1\nWELL "B-2"\nGROUP "G"\nSCHEDULE\n');
    expect(doc.blocks.map(b => [b.kind, b.name])).toEqual([
      ['WELL', '55_33-A-1'],
      ['WELL', 'B-2'],
      ['GROUP', 'G'],
      ['SCHEDULE', undefined],
    ]);
    expect(doc.blocks[1].nameSpan).toEqual({ line: 3, start: 5, end: 10 });
  });

  it('parses attributes with ranges and inferred types', () => {
    const doc = parseSimEvents(HEADER + 'WELL "W"\n  2024-01-01 WCONHIST STATUS=OPEN VFP=2 X=1.5 C="a # b" B=true\n');
    expect(doc.issues).toEqual([]);
    const attrs = doc.blocks[0].events[0].attributes;
    expect([...attrs.values()].map(a => [a.key, a.value, a.valueType])).toEqual([
      ['STATUS', 'OPEN', 'string'],
      ['VFP', 2, 'int'],
      ['X', 1.5, 'float'],
      ['C', 'a # b', 'string'],
      ['B', true, 'bool'],
    ]);
    expect(attrs.get('STATUS')!.keySpan).toEqual({ line: 2, start: 22, end: 28 });
    expect(attrs.get('C')!.valueSpan).toEqual({ line: 2, start: 49, end: 54 });
  });

  it('rejects positional tokens', () => {
    expect(errorsOf('WELL "W"\n  2024-01-01 WCONHIST OPEN\n')).toEqual(["Malformed attribute near 'OPEN'"]);
  });

  it('hints at a time-of-day in an event line', () => {
    expect(errorsOf('WELL "W"\n  2024-01-01 12:00:00 STATE STATE=SHUT\n')[0])
      .toContain('e.g. 2024-01-01T12:00:00');
  });

  it('resolves PERFORATION filters', () => {
    expect(errorsOf('WELL "W"\n  2024-01-01 PERFORATION MDSTART=1 MDEND=2 FILTER=NOPE\n'))
      .toEqual(["Unknown variable 'NOPE'"]);
    expect(errorsOf('WELL "W"\n  2024-01-01 PERFORATION MDSTART=1 MDEND=2 FILTER=1x\n')[0])
      .toContain('FILTER must name a declared FILTER variable');
    expect(errorsOf('WELL "W"\n  2024-01-01 PERFORATION MDSTART=1 MDEND=2 FILTER="PORO"\n')[0])
      .toContain("Malformed filter term 'PORO'");
  });
});

describe('SCHEDULE events', () => {
  it('checks INSERT_DATE', () => {
    expect(errorsOf('WELL "W"\n  2024-01-01 INSERT_DATE\n')).toEqual(['INSERT_DATE is only valid in a SCHEDULE block']);
    expect(errorsOf('SCHEDULE\n  2024-01-01 INSERT_DATE EVERY=0d UNTIL=2025-01-01\n')[0])
      .toContain('must be a positive duration');
    expect(errorsOf('SCHEDULE\n  2024-01-01 INSERT_DATE UNTIL=2025-01-01\n')).toEqual(['INSERT_DATE UNTIL requires EVERY']);
    expect(errorsOf('SCHEDULE\n  2024-01-01 INSERT_DATE EVERY=1mon FOO=1\n')[0])
      .toContain('Unknown INSERT_DATE attribute(s): FOO');
    expect(errorsOf('SCHEDULE\n  2024-01-01 INSERT_DATE EVERY=1mon\n'))
      .toEqual(['Recurring INSERT_DATE without UNTIL requires at least one event']);
    expect(errorsOf('SCHEDULE\n  2024-01-01 INSERT_DATE EVERY=1mon UNTIL="2024-01-01 - 1d"\n'))
      .toEqual(['INSERT_DATE end date must not precede its start date']);
    expect(errorsOf('DURATION P = 1mon\nSCHEDULE\n  2024-01-01 INSERT_DATE EVERY=P UNTIL="2024-01-01 + 12mon"\n'))
      .toEqual([]);
  });

  it('checks RESTART', () => {
    expect(errorsOf('WELL "W"\n  2024-01-01 RESTART\n')).toEqual(['RESTART is only valid in a SCHEDULE block']);
    expect(errorsOf('SCHEDULE\n  2024-01-01 RESTART VALUE=1\n')).toEqual(['RESTART takes no attributes']);
    expect(errorsOf('SCHEDULE\n  2024-01-01 RESTART\n  2024-02-01 RESTART\n'))
      .toEqual(['Only one RESTART event is allowed per schedule']);
  });

  it('checks RAW_TEXT', () => {
    const raw = (attrs: string, body = 'TUNING\n/\n'): string[] =>
      errorsOf(`SCHEDULE\n  2024-01-01 RAW_TEXT ${attrs}\n${body}END_RAW_TEXT\n`);
    expect(raw('PLACEMENT=AFTER_DATE')).toEqual([]);
    expect(raw('PLACEMENT=BEFORE_KEYWORD ANCHOR=COMPDAT PRIORITY=-2')).toEqual([]);
    expect(raw('')).toEqual(['RAW_TEXT requires PLACEMENT']);
    expect(raw('PLACEMENT=AFTER_DATE', '')).toEqual(['RAW_TEXT body must not be empty']);
    expect(raw('PLACEMENT=MIDDLE')[0]).toContain('PLACEMENT must be');
    expect(raw('PLACEMENT=AFTER_KEYWORD')[0]).toContain('ANCHOR is required');
    expect(raw('PLACEMENT=AFTER_DATE ANCHOR=COMPDAT')[0]).toContain('ANCHOR is only valid');
    expect(raw('PLACEMENT=AFTER_DATE PRIORITY=1.5')).toEqual(['RAW_TEXT PRIORITY must be an integer']);
    expect(raw('PLACEMENT=AFTER_DATE EXTRA=1')).toEqual(['Unknown RAW_TEXT attribute(s): EXTRA']);
    expect(errorsOf('WELL "W"\n  2024-01-01 RAW_TEXT PLACEMENT=AFTER_DATE\nX\nEND_RAW_TEXT\n'))
      .toEqual(['RAW_TEXT is only valid in a SCHEDULE block']);
    expect(errorsOf('SCHEDULE\n  2024-01-01 RAW_TEXT PLACEMENT=AFTER_DATE\nX\n')).toEqual(['Unterminated RAW_TEXT block']);
  });

  it('does not parse RAW_TEXT bodies', () => {
    expect(errorsOf('SCHEDULE\n  2024-01-01 RAW_TEXT PLACEMENT=AFTER_DATE\nnot # an event\nEND_RAW_TEXT\n')).toEqual([]);
  });
});

describe('helpers', () => {
  it('strips comments outside quotes', () => {
    expect(stripComment('A B="x # y" # tail')).toBe('A B="x # y" ');
  });

  it('matches like difflib.get_close_matches', () => {
    expect(closeMatch('STRAT', ['START', 'STOP'])).toBe('START');
    expect(closeMatch('XYZ', ['START'])).toBeUndefined();
  });

  it('formats durations like rips', () => {
    expect(formatDuration({ months: 1, seconds: 5 * 86400 + 12 * 3600 + 30 * 60 })).toBe('1mon5d12h30m');
    expect(formatDuration({ months: 0, seconds: -3 * 86400 })).toBe('-3d');
    expect(formatDuration({ months: 1, seconds: -86400 })).toBe('1mon - 1d');
    expect(formatDuration({ months: 0, seconds: 0 })).toBe('0s');
  });
});
