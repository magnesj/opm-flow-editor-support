import * as vscode from 'vscode';
import { KeywordInfo, parseSimEvents, SimEventsDocument, Span, VarKind } from './simevents';
import { buildSimEventsOutline, foldingRanges, OutlineItem } from './simevents-language';

export const SIMEVENTS_LANGUAGE = 'opm-simevents';

// Parse results shared by all providers, reparsed only when the text changes.
class DocumentCache {
  private readonly entries = new WeakMap<vscode.TextDocument, { version: number; doc: SimEventsDocument }>();

  constructor(private readonly keywords: Map<string, KeywordInfo>) {}

  get(document: vscode.TextDocument): SimEventsDocument {
    const cached = this.entries.get(document);
    if (cached && cached.version === document.version) {
      return cached.doc;
    }
    const doc = parseSimEvents(document.getText(), { keywords: this.keywords });
    this.entries.set(document, { version: document.version, doc });
    return doc;
  }
}

export function toRange(span: Span): vscode.Range {
  return new vscode.Range(span.line, span.start, span.line, span.end);
}

function registerDiagnostics(context: vscode.ExtensionContext, cache: DocumentCache): void {
  const collection = vscode.languages.createDiagnosticCollection(SIMEVENTS_LANGUAGE);
  const refresh = (document: vscode.TextDocument): void => {
    if (document.languageId !== SIMEVENTS_LANGUAGE) {
      return;
    }
    collection.set(document.uri, cache.get(document).issues.map(issue => {
      const severity = issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
      const diagnostic = new vscode.Diagnostic(toRange(issue.span), issue.message, severity);
      diagnostic.source = 'SIMEVENTS';
      return diagnostic;
    }));
  };

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const refreshSoon = (document: vscode.TextDocument): void => {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      refresh(document);
    }, 250));
  };

  for (const document of vscode.workspace.textDocuments) {
    refresh(document);
  }
  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument(e => refreshSoon(e.document)),
    vscode.workspace.onDidCloseTextDocument(document => collection.delete(document.uri)),
  );
}

function documentLines(document: vscode.TextDocument): string[] {
  return document.getText().split(/\r\n|\r|\n/);
}

const VAR_SYMBOL_KINDS: Record<VarKind, vscode.SymbolKind> = {
  DATE: vscode.SymbolKind.Constant,
  DURATION: vscode.SymbolKind.Constant,
  WELL: vscode.SymbolKind.Variable,
  FILTER: vscode.SymbolKind.Object,
};

function toSymbol(document: vscode.TextDocument, item: OutlineItem): vscode.DocumentSymbol {
  const kind = item.kind === 'declaration'
    ? VAR_SYMBOL_KINDS[item.varKind!]
    : item.kind === 'block' ? vscode.SymbolKind.Namespace : vscode.SymbolKind.Event;
  const range = new vscode.Range(item.range.startLine, 0, item.range.endLine, document.lineAt(item.range.endLine).text.length);
  const symbol = new vscode.DocumentSymbol(item.name, item.detail, kind, range, toRange(item.selection));
  symbol.children = item.children.map(child => toSymbol(document, child));
  return symbol;
}

function registerNavigation(context: vscode.ExtensionContext, cache: DocumentCache): void {
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(SIMEVENTS_LANGUAGE, {
      provideDocumentSymbols: document =>
        buildSimEventsOutline(cache.get(document), documentLines(document)).map(item => toSymbol(document, item)),
    }),
    vscode.languages.registerFoldingRangeProvider(SIMEVENTS_LANGUAGE, {
      provideFoldingRanges: document =>
        foldingRanges(cache.get(document), documentLines(document))
          .map(r => new vscode.FoldingRange(r.startLine, r.endLine)),
    }),
  );
}

export function registerSimEvents(context: vscode.ExtensionContext, keywords: Map<string, KeywordInfo>): void {
  const cache = new DocumentCache(keywords);
  registerDiagnostics(context, cache);
  registerNavigation(context, cache);
}
