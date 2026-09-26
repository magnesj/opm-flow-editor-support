import { parseSimEvents } from './simevents';
import { buildSimEventsOutline, foldingRanges, isValidVariableName, variableAt } from './simevents-language';

const TEXT = [
  'SIMEVENTS 1.2', //                                          0
  '# Header comment', //                                       1
  '# continues', //                                            2
  'DATE START = 2024-01-01', //                                3
  'WELL A1 = "W-1"', //                                        4
  '', //                                                       5
  'SCHEDULE', //                                               6
  '  START RAW_TEXT PLACEMENT=AFTER_DATE', //                  7
  'TUNING', //                                                 8
  '/', //                                                      9
  'END_RAW_TEXT', //                                          10
  'WELL A1', //                                               11
  '  START      STATE     STATE=OPEN', //                     12
  '  START + 1d WCONHIST  STATUS=SHUT', //                    13
  '# trailing', //                                            14
].join('\n');

const lines = TEXT.split('\n');
const doc = parseSimEvents(TEXT);

describe('buildSimEventsOutline', () => {
  it('lists declarations and blocks with their events in source order', () => {
    const outline = buildSimEventsOutline(doc, lines);
    expect(outline.map(i => [i.kind, i.name, i.detail, i.range.startLine, i.range.endLine])).toEqual([
      ['declaration', 'START', 'DATE', 3, 3],
      ['declaration', 'A1', 'WELL', 4, 4],
      ['block', 'SCHEDULE', '', 6, 10],
      ['block', 'WELL W-1', '', 11, 13],
    ]);
    expect(outline[2].children.map(c => [c.name, c.detail, c.range.endLine])).toEqual([['RAW_TEXT', '2024-01-01', 10]]);
    expect(outline[3].children.map(c => [c.name, c.detail])).toEqual([
      ['STATE', '2024-01-01'],
      ['WCONHIST', '2024-01-02'],
    ]);
    expect(outline[2].selection).toEqual({ line: 6, start: 0, end: 8 });
    expect(outline[3].selection).toEqual({ line: 11, start: 5, end: 7 });
  });

  it('marks blocks whose opening line failed', () => {
    const broken = parseSimEvents('SIMEVENTS 1.2\nWELL NOPE\n  2024-01-01 STATE STATE=OPEN\n');
    const outline = buildSimEventsOutline(broken, []);
    expect(outline.map(i => [i.name, i.detail, i.children.length])).toEqual([['WELL', 'invalid', 1]]);
  });
});

describe('foldingRanges', () => {
  it('folds blocks, RAW_TEXT bodies and comment runs', () => {
    expect(foldingRanges(doc, lines)).toEqual([
      { startLine: 6, endLine: 10 },
      { startLine: 7, endLine: 10 },
      { startLine: 11, endLine: 13 },
      { startLine: 1, endLine: 2 },
    ]);
  });
});

describe('variableAt', () => {
  it('finds a variable from a reference', () => {
    // 'START' in "  START + 1d WCONHIST ..." on line 13.
    const occurrences = variableAt(doc, 13, 4)!;
    expect(occurrences.name).toBe('START');
    expect(occurrences.span).toEqual({ line: 13, start: 2, end: 7 });
    expect(occurrences.definition).toEqual({ line: 3, start: 5, end: 10 });
    expect(occurrences.declarations).toEqual([{ line: 3, start: 5, end: 10 }]);
    expect(occurrences.references.map(r => r.line)).toEqual([7, 12, 13]);
  });

  it('finds a variable from its declaration and alias uses', () => {
    const occurrences = variableAt(doc, 4, 6)!;
    expect(occurrences.name).toBe('A1');
    expect(occurrences.references).toEqual([{ line: 11, start: 5, end: 7 }]);
  });

  it('returns nothing away from variables', () => {
    expect(variableAt(doc, 12, 15)).toBeUndefined();
  });

  it('includes redeclarations', () => {
    const redeclared = parseSimEvents('SIMEVENTS 1.2\nDATE A = 2024-01-01\nDATE A = 2024-01-02\nDATE B = A\n');
    const occurrences = variableAt(redeclared, 3, 9)!;
    expect(occurrences.definition).toEqual({ line: 2, start: 5, end: 6 });
    expect(occurrences.declarations.map(d => d.line)).toEqual([1, 2]);
  });

  it('validates new names', () => {
    expect(isValidVariableName('NEW_1')).toBe(true);
    expect(isValidVariableName('1X')).toBe(false);
    expect(isValidVariableName('A B')).toBe(false);
  });
});
