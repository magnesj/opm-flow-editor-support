import * as fs from 'fs';
import * as path from 'path';
import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';

const syntaxDir = path.join(__dirname, '..', 'syntaxes');
const examplesDir = path.join(__dirname, '..', '..', 'examples', 'simevents');

const grammarFiles: Record<string, string> = {
  'source.opm-simevents': 'simevents.tmLanguage.json',
  'source.opm-flow': 'opm-flow.tmLanguage.json',
};

interface Token {
  text: string;
  scopes: string[];
}

let grammar: textmate.IGrammar;

beforeAll(async () => {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s: string) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scopeName: string) => {
      const file = grammarFiles[scopeName];
      if (!file) {
        return null;
      }
      const fullPath = path.join(syntaxDir, file);
      return textmate.parseRawGrammar(fs.readFileSync(fullPath, 'utf8'), fullPath);
    },
  });
  const loaded = await registry.loadGrammar('source.opm-simevents');
  if (!loaded) {
    throw new Error('SIMEVENTS grammar failed to load');
  }
  grammar = loaded;
});

function tokenize(text: string): Token[][] {
  let ruleStack = textmate.INITIAL;
  return text.split(/\r?\n/).map(line => {
    const result = grammar.tokenizeLine(line, ruleStack);
    ruleStack = result.ruleStack;
    return result.tokens
      .map(t => ({ text: line.substring(t.startIndex, t.endIndex), scopes: t.scopes }))
      .filter(t => t.text.trim() !== '');
  });
}

function scopeOf(tokens: Token[], text: string): string {
  const token = tokens.find(t => t.text === text);
  if (!token) {
    throw new Error(`no token '${text}' in ${JSON.stringify(tokens.map(t => t.text))}`);
  }
  return token.scopes[token.scopes.length - 1];
}

describe('SIMEVENTS grammar', () => {
  it('scopes header, unit and declarations', () => {
    const [header, unit, date, duration] = tokenize(
      'SIMEVENTS 1.2\nUNIT METRIC\nDATE X = 2024-05-15T14:45:30 + 1mon\nDURATION RAMP = 1d12h30m',
    );
    expect(scopeOf(header, 'SIMEVENTS')).toBe('keyword.control.header.simevents');
    expect(scopeOf(header, '1.2')).toBe('constant.numeric.version.simevents');
    expect(scopeOf(unit, 'METRIC')).toBe('constant.language.unit.simevents');
    expect(scopeOf(date, 'DATE')).toBe('storage.type.simevents');
    expect(scopeOf(date, 'X')).toBe('entity.name.variable.simevents');
    expect(scopeOf(date, '2024-05-15T14:45:30')).toBe('constant.numeric.date.simevents');
    expect(scopeOf(date, '1mon')).toBe('constant.numeric.duration.simevents');
    expect(scopeOf(duration, '1d12h30m')).toBe('constant.numeric.duration.simevents');
  });

  it('distinguishes block openers from declarations', () => {
    const [decl, alias, quoted, group, schedule] = tokenize(
      'WELL A1 = "55_33-A-1"\nWELL A1\nWELL "55_33-A-2"\nGROUP "FIELD"\nSCHEDULE',
    );
    expect(scopeOf(decl, 'WELL')).toBe('storage.type.simevents');
    expect(scopeOf(alias, 'WELL')).toBe('keyword.control.block.simevents');
    expect(scopeOf(alias, 'A1')).toBe('variable.other.well.simevents');
    expect(scopeOf(quoted, '"55_33-A-2"')).toBe('string.quoted.double.simevents');
    expect(scopeOf(group, 'GROUP')).toBe('keyword.control.block.simevents');
    expect(scopeOf(schedule, 'SCHEDULE')).toBe('keyword.control.block.simevents');
  });

  it('scopes event lines', () => {
    const [builtin, passThrough] = tokenize(
      '  START + RAMP  PERFORATION  MDSTART=10.5  FILTER=POROPERM  # tail\n' +
      '  START - 2d  WCONHIST  STATUS=OPEN  COMMENT="a # b"',
    );
    expect(scopeOf(builtin, 'START')).toBe('variable.other.simevents');
    expect(scopeOf(builtin, '+')).toBe('keyword.operator.arithmetic.simevents');
    expect(scopeOf(builtin, 'PERFORATION')).toBe('support.function.builtin-event.simevents');
    expect(scopeOf(builtin, 'MDSTART')).toBe('variable.parameter.attribute.simevents');
    expect(scopeOf(builtin, '10.5')).toBe('constant.numeric.simevents');
    expect(scopeOf(builtin, '# tail')).toBe('comment.line.number-sign.simevents');
    expect(scopeOf(passThrough, '2d')).toBe('constant.numeric.duration.simevents');
    expect(scopeOf(passThrough, 'WCONHIST')).toBe('entity.name.function.keyword.simevents');
    expect(scopeOf(passThrough, 'OPEN')).toBe('string.unquoted.value.simevents');
    expect(scopeOf(passThrough, '"a # b"')).toBe('string.quoted.double.simevents');
  });

  it('scopes filter expressions', () => {
    const [decl, inline] = tokenize(
      'FILTER F = "DYNAMIC.SOIL >= 0.6 OR PERMX > 250"\n' +
      '  X PERFORATION MDSTART=1 MDEND=2 FILTER="PORO > 0.2"',
    );
    expect(scopeOf(decl, 'DYNAMIC')).toBe('support.type.result-type.simevents');
    expect(scopeOf(decl, 'SOIL')).toBe('variable.other.property.result.simevents');
    expect(scopeOf(decl, '>=')).toBe('keyword.operator.comparison.simevents');
    expect(scopeOf(decl, 'OR')).toBe('keyword.operator.logical.simevents');
    expect(scopeOf(inline, 'PORO')).toBe('variable.other.property.result.simevents');
  });

  it('embeds OPM Flow in RAW_TEXT bodies', () => {
    const lines = tokenize(
      'SCHEDULE\n' +
      '  START RAW_TEXT PLACEMENT=AFTER_DATE\n' +
      'WTRACER\n' +
      "  'W' 'T' 1.0 /\n" +
      '/\n' +
      'END_RAW_TEXT\n' +
      '  START RESTART',
    );
    expect(scopeOf(lines[1], 'RAW_TEXT')).toBe('keyword.control.raw-text.simevents');
    expect(scopeOf(lines[2], 'WTRACER')).toBe('keyword.control.opm-flow');
    expect(lines[2][0].scopes).toContain('meta.embedded.block.opm-flow');
    expect(scopeOf(lines[5], 'END_RAW_TEXT')).toBe('keyword.control.raw-text.simevents');
    expect(scopeOf(lines[6], 'RESTART')).toBe('support.function.builtin-event.simevents');
  });

  it('gives every event type in the samples an event scope', () => {
    const eventScopes = [
      'support.function.builtin-event.simevents',
      'entity.name.function.keyword.simevents',
      'keyword.control.raw-text.simevents',
    ];
    let checked = 0;
    for (const file of fs.readdirSync(examplesDir).filter(f => f.endsWith('.events'))) {
      const text = fs.readFileSync(path.join(examplesDir, file), 'utf8');
      tokenize(text).forEach((tokens, i) => {
        const line = text.split(/\r?\n/)[i];
        if (/^\s+(\d{4}-|[A-Za-z_])/.test(line) && !line.trim().startsWith('#') && tokens[0].scopes.length === 2) {
          checked++;
          const hasEvent = tokens.some(t => eventScopes.includes(t.scopes[t.scopes.length - 1]));
          expect({ file, line, hasEvent }).toEqual({ file, line, hasEvent: true });
        }
      });
    }
    expect(checked).toBeGreaterThan(20);
  });
});
