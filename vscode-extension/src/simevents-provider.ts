import * as vscode from 'vscode';
import {
  ATTRIBUTE_VALUES,
  BUILTIN_EVENT_ATTRIBUTES,
  KEYWORD_ITEM_ALIASES,
  KeywordInfo,
  parseSimEvents,
  SimEventsDocument,
  Span,
  SUPPORTED_VERSION,
  UNIT_SYSTEMS,
  VarKind,
} from './simevents';
import {
  BLOCK_EVENT_TYPES,
  blockKeywords,
  BUILTIN_EVENT_DOCS,
  buildSimEventsOutline,
  completionContext,
  declarationsBefore,
  foldingRanges,
  hoverAt,
  isValidVariableName,
  keywordAttributes,
  OutlineItem,
  simulatorKeywordAt,
  variableAt,
} from './simevents-language';

export const SIMEVENTS_LANGUAGE = 'opm-simevents';

// Parse results shared by all providers, reparsed only when the text changes.
class DocumentCache {
  private readonly entries = new WeakMap<vscode.TextDocument, { version: number; doc: SimEventsDocument }>();

  constructor(readonly keywords: Map<string, KeywordInfo>) {}

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

  const at = (document: vscode.TextDocument, position: vscode.Position) =>
    variableAt(cache.get(document), position.line, position.character);
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(SIMEVENTS_LANGUAGE, {
      provideDefinition: (document, position) => {
        const definition = at(document, position)?.definition;
        return definition ? new vscode.Location(document.uri, toRange(definition)) : undefined;
      },
    }),
    vscode.languages.registerReferenceProvider(SIMEVENTS_LANGUAGE, {
      provideReferences: (document, position, refContext) => {
        const occurrences = at(document, position);
        if (!occurrences) {
          return undefined;
        }
        const spans = refContext.includeDeclaration
          ? [...occurrences.declarations, ...occurrences.references]
          : occurrences.references;
        return spans.map(span => new vscode.Location(document.uri, toRange(span)));
      },
    }),
    vscode.languages.registerRenameProvider(SIMEVENTS_LANGUAGE, {
      prepareRename: (document, position) => {
        const occurrences = at(document, position);
        if (!occurrences) {
          throw new Error('Only declared variables can be renamed');
        }
        return { range: toRange(occurrences.span), placeholder: occurrences.name };
      },
      provideRenameEdits: (document, position, newName) => {
        const occurrences = at(document, position);
        if (!occurrences) {
          return undefined;
        }
        if (!isValidVariableName(newName)) {
          throw new Error(`'${newName}' is not a valid variable name`);
        }
        const edit = new vscode.WorkspaceEdit();
        for (const span of [...occurrences.declarations, ...occurrences.references]) {
          edit.replace(document.uri, toRange(span), newName);
        }
        return edit;
      },
    }),
  );
}

const STATEMENT_SNIPPETS: Array<[string, string, string]> = [
  ['DATE', 'Declare a date', 'DATE ${1:NAME} = ${2:2024-01-01}'],
  ['DURATION', 'Declare a duration', 'DURATION ${1:NAME} = ${2:1d}'],
  ['WELL', 'Declare a well-name alias', 'WELL ${1:ALIAS} = "${2:well-name}"'],
  ['FILTER', 'Declare a cell filter', 'FILTER ${1:NAME} = "${2:PORO > 0.1}"'],
  ['WELL block', 'Events for a well', 'WELL "${1:well-name}"'],
  ['GROUP block', 'Keyword events for a group', 'GROUP "${1:group-name}"'],
  ['SCHEDULE', 'Keyword events not tied to a well', 'SCHEDULE'],
  ['UNIT', 'Unit system', 'UNIT ${1|METRIC,FIELD,LAB|}'],
];

const EVENT_SNIPPETS: Record<string, string> = {
  PERFORATION: 'PERFORATION  MDSTART=$1  MDEND=$2',
  SEGMENT: 'SEGMENT  MDSTART=$1  MDEND=$2',
  VALVE: 'VALVE  MD=$1  TYPE=$2',
  STATE: 'STATE  STATE=${1:SHUT}',
  MEMBER: 'MEMBER  MEMBERS="$1"',
  RAW_TEXT: 'RAW_TEXT  PLACEMENT=${1|AFTER_DATE,BEFORE_KEYWORD,AFTER_KEYWORD,END_OF_DATE|}\n$0\nEND_RAW_TEXT',
};

function variableItems(doc: SimEventsDocument, line: number, kind: VarKind): vscode.CompletionItem[] {
  return declarationsBefore(doc, line, kind).map(decl => {
    const item = new vscode.CompletionItem(decl.name, vscode.CompletionItemKind.Variable);
    item.detail = kind;
    return item;
  });
}

// Accepting a key inserts "KEY=" and asks for its value.
function attributeItem(key: string, detail: string, sortPrefix: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
  item.detail = detail;
  item.insertText = `${key}=`;
  item.sortText = sortPrefix + key;
  item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest values' };
  return item;
}

function valueItems(values: string[]): vscode.CompletionItem[] {
  return values.map(value => new vscode.CompletionItem(value, vscode.CompletionItemKind.EnumMember));
}

function provideCompletions(
  cache: DocumentCache,
  document: vscode.TextDocument,
  position: vscode.Position,
): vscode.CompletionItem[] {
  const doc = cache.get(document);
  const keywords = cache.keywords;
  const context = completionContext(doc, documentLines(document), position.line, position.character);
  switch (context.kind) {
    case 'lineStart': {
      const items = STATEMENT_SNIPPETS.map(([label, detail, snippet]) => {
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
        item.detail = detail;
        item.insertText = new vscode.SnippetString(snippet);
        return item;
      });
      if (doc.version === undefined) {
        const header = new vscode.CompletionItem('SIMEVENTS', vscode.CompletionItemKind.Keyword);
        header.insertText = `SIMEVENTS ${SUPPORTED_VERSION}`;
        items.push(header);
      }
      if (context.blockKind) {
        items.push(...variableItems(doc, position.line, 'DATE'));
      }
      return items;
    }
    case 'unit':
      return valueItems(UNIT_SYSTEMS);
    case 'variable':
      return variableItems(doc, position.line, context.varKind);
    case 'eventType': {
      const builtins = BLOCK_EVENT_TYPES[context.blockKind].map(type => {
        const item = new vscode.CompletionItem(type, vscode.CompletionItemKind.Function);
        item.detail = 'SIMEVENTS event';
        item.documentation = BUILTIN_EVENT_DOCS[type];
        item.insertText = new vscode.SnippetString(EVENT_SNIPPETS[type] ?? type);
        item.sortText = `0${type}`;
        return item;
      });
      const passThrough = blockKeywords(keywords, context.blockKind).map(name => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Keyword);
        item.detail = 'Eclipse keyword';
        item.documentation = keywords.get(name)!.summary;
        item.sortText = `1${name}`;
        return item;
      });
      return [...builtins, ...passThrough];
    }
    case 'attributeKey': {
      const present = new Set(context.present);
      const spec = BUILTIN_EVENT_ATTRIBUTES[context.eventType];
      if (spec) {
        return [
          ...spec.required.filter(a => !present.has(a)).map(a => attributeItem(a, 'required', '0')),
          ...spec.optional.filter(a => !present.has(a)).map(a => attributeItem(a, 'optional', '1')),
        ];
      }
      const keyword = keywords.get(context.eventType);
      if (!keyword) {
        return [];
      }
      return [...keywordAttributes(keyword, context.eventType, context.blockKind), 'COMMENT']
        .filter(a => !present.has(a))
        .map((a, i) => attributeItem(a, context.eventType, String(i).padStart(3, '0')));
    }
    case 'attributeValue': {
      const { eventType, key } = context;
      if (key === 'FILTER') {
        return variableItems(doc, position.line, 'FILTER');
      }
      if (eventType === 'INSERT_DATE' && key === 'EVERY') {
        return variableItems(doc, position.line, 'DURATION');
      }
      if (eventType === 'INSERT_DATE' && key === 'UNTIL') {
        return variableItems(doc, position.line, 'DATE');
      }
      if (eventType === 'RAW_TEXT' && key === 'ANCHOR') {
        return blockKeywords(keywords, 'SCHEDULE').map(name => new vscode.CompletionItem(name, vscode.CompletionItemKind.Keyword));
      }
      const values = ATTRIBUTE_VALUES[`${eventType}.${key}`];
      if (values) {
        return valueItems(values);
      }
      const item = KEYWORD_ITEM_ALIASES[eventType]?.[key] ?? key;
      return valueItems(keywords.get(eventType)?.itemOptions?.[item] ?? []);
    }
    case 'none':
      return [];
  }
}

export type SimulatorKeywordLookup = (
  document: vscode.TextDocument,
  position: vscode.Position,
) => { keyword: string; item?: string } | undefined;

export function registerSimEvents(
  context: vscode.ExtensionContext,
  keywords: Map<string, KeywordInfo>,
): SimulatorKeywordLookup {
  const cache = new DocumentCache(keywords);
  registerDiagnostics(context, cache);
  registerNavigation(context, cache);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      SIMEVENTS_LANGUAGE,
      { provideCompletionItems: (document, position) => provideCompletions(cache, document, position) },
      ' ',
      '=',
    ),
    vscode.languages.registerHoverProvider(SIMEVENTS_LANGUAGE, {
      provideHover: (document, position) => {
        const hover = hoverAt(cache.get(document), position.line, position.character, cache.keywords);
        return hover ? new vscode.Hover(new vscode.MarkdownString(hover.markdown), toRange(hover.span)) : undefined;
      },
    }),
  );
  return (document, position) => simulatorKeywordAt(cache.get(document), position.line, position.character, keywords);
}
