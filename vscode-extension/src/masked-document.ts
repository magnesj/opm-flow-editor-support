import * as vscode from 'vscode';
import { LineRange, maskLines } from './simevents-language';

// A view of a document where only some lines keep their text. Positions are
// those of the original document, so results computed on the view apply to it
// unchanged. Used to run the OPM Flow providers on the Eclipse keyword text
// embedded in RAW_TEXT bodies of SIMEVENTS files.
export class MaskedTextDocument implements vscode.TextDocument {
  readonly languageId = 'opm-flow';
  private readonly lines: string[];
  private readonly eolText: string;

  constructor(private readonly document: vscode.TextDocument, visible: readonly LineRange[]) {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      lines.push(document.lineAt(i).text);
    }
    this.lines = maskLines(lines, visible);
    this.eolText = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  }

  get uri(): vscode.Uri { return this.document.uri; }
  get fileName(): string { return this.document.fileName; }
  get isUntitled(): boolean { return this.document.isUntitled; }
  get encoding(): string { return this.document.encoding; }
  get version(): number { return this.document.version; }
  get isDirty(): boolean { return this.document.isDirty; }
  get isClosed(): boolean { return this.document.isClosed; }
  get eol(): vscode.EndOfLine { return this.document.eol; }
  get lineCount(): number { return this.lines.length; }

  save(): Thenable<boolean> {
    return this.document.save();
  }

  lineAt(lineOrPosition: number | vscode.Position): vscode.TextLine {
    const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
    const text = this.lines[line];
    if (text === undefined) {
      throw new Error(`Illegal line ${line}`);
    }
    const firstNonWhitespace = text.search(/\S/);
    return {
      lineNumber: line,
      text,
      range: new vscode.Range(line, 0, line, text.length),
      rangeIncludingLineBreak: line < this.lines.length - 1
        ? new vscode.Range(line, 0, line + 1, 0)
        : new vscode.Range(line, 0, line, text.length),
      firstNonWhitespaceCharacterIndex: firstNonWhitespace < 0 ? text.length : firstNonWhitespace,
      isEmptyOrWhitespace: firstNonWhitespace < 0,
    };
  }

  offsetAt(position: vscode.Position): number {
    const pos = this.validatePosition(position);
    let offset = 0;
    for (let i = 0; i < pos.line; i++) {
      offset += this.lines[i].length + this.eolText.length;
    }
    return offset + pos.character;
  }

  positionAt(offset: number): vscode.Position {
    let remaining = Math.max(0, offset);
    for (let i = 0; i < this.lines.length; i++) {
      if (remaining <= this.lines[i].length) {
        return new vscode.Position(i, remaining);
      }
      remaining -= this.lines[i].length + this.eolText.length;
    }
    const last = this.lines.length - 1;
    return new vscode.Position(last, this.lines[last].length);
  }

  getText(range?: vscode.Range): string {
    const text = this.lines.join(this.eolText);
    if (!range) {
      return text;
    }
    const valid = this.validateRange(range);
    return text.slice(this.offsetAt(valid.start), this.offsetAt(valid.end));
  }

  getWordRangeAtPosition(position: vscode.Position, regex = /[\w-]+/): vscode.Range | undefined {
    const pos = this.validatePosition(position);
    const text = this.lines[pos.line];
    const global = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
    for (const m of text.matchAll(global)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (m[0].length > 0 && start <= pos.character && pos.character <= end) {
        return new vscode.Range(pos.line, start, pos.line, end);
      }
    }
    return undefined;
  }

  validateRange(range: vscode.Range): vscode.Range {
    const start = this.validatePosition(range.start);
    const end = this.validatePosition(range.end);
    return start.isEqual(range.start) && end.isEqual(range.end) ? range : new vscode.Range(start, end);
  }

  validatePosition(position: vscode.Position): vscode.Position {
    const line = Math.min(Math.max(position.line, 0), this.lines.length - 1);
    const character = Math.min(Math.max(position.character, 0), this.lines[line].length);
    return line === position.line && character === position.character ? position : new vscode.Position(line, character);
  }
}
