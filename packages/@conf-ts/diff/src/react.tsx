'use client';

import {
  DiffEditor,
  type Monaco,
  type MonacoDiffEditor,
} from '@monaco-editor/react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import type {
  DiffChange,
  DiffChangeKind,
  DiffClassification,
  DiffReport,
  SourceLocation,
  StructureNode,
} from './types.js';

export type { DiffReport } from './types.js';

export interface DiffExplorerProps {
  report: DiffReport;
  initialView?: 'structure' | 'source' | 'value' | 'dependencies';
  selectedChangeId?: string;
  onSelectedChange?: (changeId: string) => void;
  monacoTheme?: string;
  className?: string;
  style?: CSSProperties;
}

const CSS = `
.ctd{--ctd-bg:#0d0f13;--ctd-panel:#14171d;--ctd-panel2:#1b2028;--ctd-fg:#edf1f6;--ctd-muted:#929cab;--ctd-border:#2a303a;--ctd-accent:#8ea8ff;--ctd-add:#59c88a;--ctd-remove:#ff7d88;--ctd-modify:#f2b35f;--ctd-move:#74b7e7;display:grid;grid-template-rows:auto 1fr;min-height:620px;background:var(--ctd-bg);color:var(--ctd-fg);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;border:1px solid var(--ctd-border);border-radius:12px;overflow:hidden}
.ctd *{box-sizing:border-box}.ctd button,.ctd input,.ctd select{font:inherit;color:inherit}.ctd-toolbar{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--ctd-border);background:var(--ctd-panel);flex-wrap:wrap}.ctd-toolbar input,.ctd-toolbar select,.ctd-tool{border:1px solid var(--ctd-border);background:var(--ctd-bg);border-radius:7px;padding:6px 8px}.ctd-toolbar input{min-width:190px;flex:1}.ctd-tool{cursor:pointer}.ctd-count{font-variant-numeric:tabular-nums;color:var(--ctd-muted)}.ctd-body{min-height:0;display:grid;grid-template-columns:270px minmax(0,1fr) 300px}.ctd-nav,.ctd-inspector{overflow:auto;background:var(--ctd-panel)}.ctd-nav{border-right:1px solid var(--ctd-border);padding:8px}.ctd-inspector{border-left:1px solid var(--ctd-border);padding:14px}.ctd-change{display:grid;grid-template-columns:20px 1fr;width:100%;border:0;background:transparent;text-align:left;padding:8px;border-radius:7px;cursor:pointer}.ctd-change:hover,.ctd-change[data-selected=true]{background:var(--ctd-panel2)}.ctd-change-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.ctd-change-meta{display:block;color:var(--ctd-muted);font-size:11px}.ctd-mark[data-kind=add]{color:var(--ctd-add)}.ctd-mark[data-kind=remove]{color:var(--ctd-remove)}.ctd-mark[data-kind=move],.ctd-mark[data-kind=rename]{color:var(--ctd-move)}.ctd-mark{color:var(--ctd-modify);font-weight:700}.ctd-main{min-width:0;overflow:auto}.ctd-tabs{display:flex;gap:3px;padding:8px 10px;border-bottom:1px solid var(--ctd-border);background:var(--ctd-panel)}.ctd-tab{border:0;background:transparent;padding:6px 9px;border-radius:6px;cursor:pointer}.ctd-tab[data-active=true]{background:var(--ctd-panel2);color:var(--ctd-accent)}.ctd-view{padding:12px}.ctd-tree-grid,.ctd-value-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--ctd-border)}.ctd-tree,.ctd-value{background:var(--ctd-bg);padding:10px;min-width:0}.ctd-tree ul{list-style:none;padding-left:17px;margin:0;border-left:1px solid var(--ctd-border)}.ctd-tree>ul{border:0;padding-left:0}.ctd-tree button{border:0;background:transparent;padding:3px 5px;cursor:pointer}.ctd-kind{color:var(--ctd-muted);margin-left:6px;font-size:11px}.ctd-value pre,.ctd-preview{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.ctd-graph{display:grid;gap:7px}.ctd-file,.ctd-edge{width:100%;text-align:left;color:inherit;cursor:pointer}.ctd-file{padding:8px 10px;background:var(--ctd-panel2);border:0;border-left:3px solid var(--ctd-border);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.ctd-file[data-changed=true]{border-color:var(--ctd-modify)}.ctd-edge{border:0;background:transparent;padding:5px 5px 5px 13px;color:var(--ctd-muted)}.ctd-file:hover,.ctd-edge:hover{color:var(--ctd-accent)}.ctd-inspector h3{margin:0 0 12px;font-size:13px}.ctd-inspector h4{margin:16px 0 7px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ctd-muted)}.ctd-inspector dl{display:grid;grid-template-columns:75px 1fr;gap:7px;margin:0}.ctd-inspector dt{color:var(--ctd-muted)}.ctd-inspector dd{margin:0;overflow-wrap:anywhere}.ctd-preview{padding:10px;margin-top:14px;border-radius:7px;background:var(--ctd-panel2)}.ctd-origin,.ctd-diagnostic{padding:7px 8px;margin-top:5px;border-radius:6px;background:var(--ctd-panel2);overflow-wrap:anywhere}.ctd-origin{font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.ctd-diagnostic[data-severity=error]{border-left:3px solid var(--ctd-remove)}.ctd-empty{padding:35px;text-align:center;color:var(--ctd-muted)}
.ctd-source-shell{height:690px;display:grid;grid-template-rows:auto auto auto minmax(0,1fr);background:var(--ctd-bg)}.ctd-source-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-bottom:1px solid var(--ctd-border);background:var(--ctd-panel);flex-wrap:wrap}.ctd-source-controls,.ctd-code-legend{display:flex;align-items:center;gap:4px;flex-wrap:wrap}.ctd-source-toggle{border:1px solid transparent;background:transparent;color:var(--ctd-muted);border-radius:6px;padding:5px 8px;cursor:pointer}.ctd-source-toggle:hover{color:var(--ctd-fg);background:var(--ctd-panel2)}.ctd-source-toggle[aria-pressed=true]{color:var(--ctd-fg);border-color:var(--ctd-border);background:var(--ctd-panel2)}.ctd-source-separator{width:1px;height:18px;background:var(--ctd-border);margin:0 4px}.ctd-code-legend{color:var(--ctd-muted);font-size:11px}.ctd-code-legend span{display:inline-flex;align-items:center;gap:4px}.ctd-code-legend i{display:inline-block;width:7px;height:7px;border-radius:2px;background:var(--ctd-modify)}.ctd-code-legend [data-kind=add]{background:var(--ctd-add)}.ctd-code-legend [data-kind=remove]{background:var(--ctd-remove)}.ctd-code-legend [data-kind=move]{background:var(--ctd-move)}.ctd-source-focus{min-height:38px;display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--ctd-border);background:var(--ctd-panel2)}.ctd-source-focus strong{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}.ctd-source-focus .ctd-change-meta{margin-left:auto;text-align:right}.ctd-code-map{display:grid;grid-template-columns:52px minmax(0,1fr);gap:8px;padding:6px 12px 7px;border-bottom:1px solid var(--ctd-border);background:var(--ctd-panel)}.ctd-code-map-labels{height:58px;display:flex;flex-direction:column;justify-content:space-between;padding:1px 0;color:var(--ctd-muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.ctd-code-map-plot{position:relative;height:58px;min-width:0}.ctd-code-map-plot svg{display:block;width:100%;height:58px;overflow:visible}.ctd-code-map-track{stroke:var(--ctd-border);stroke-width:1}.ctd-code-map-change{color:var(--ctd-modify)}.ctd-code-map-change[data-kind=add]{color:var(--ctd-add)}.ctd-code-map-change[data-kind=remove]{color:var(--ctd-remove)}.ctd-code-map-change[data-kind=move],.ctd-code-map-change[data-kind=rename]{color:var(--ctd-move)}.ctd-code-map-change line{stroke:currentColor;stroke-width:1.2;opacity:.42}.ctd-code-map-change circle{fill:var(--ctd-panel);stroke:currentColor;stroke-width:2;vector-effect:non-scaling-stroke}.ctd-code-map-change[data-selected=true] line{stroke-width:3;opacity:.95}.ctd-code-map-change[data-selected=true] circle{fill:currentColor;stroke-width:3;r:6px}.ctd-code-map-hit{position:absolute;width:14px;height:14px;transform:translate(-50%,-50%);border:2px solid var(--ctd-panel);border-radius:50%;background:var(--ctd-modify);cursor:pointer;opacity:.01}.ctd-code-map-hit:focus-visible,.ctd-code-map-hit:hover,.ctd-code-map-hit[data-selected=true]{opacity:1;outline:2px solid var(--ctd-accent);outline-offset:2px}.ctd-code-map-hit[data-kind=add]{background:var(--ctd-add)}.ctd-code-map-hit[data-kind=remove]{background:var(--ctd-remove)}.ctd-code-map-hit[data-kind=move],.ctd-code-map-hit[data-kind=rename]{background:var(--ctd-move)}.ctd-source-editor{min-height:0;position:relative}.ctd-source-editor .monaco-editor .ctd-code-line{background:linear-gradient(90deg,color-mix(in srgb,var(--ctd-modify) 11%,transparent),transparent 70%)}.ctd-source-editor .monaco-editor .ctd-code-line.ctd-code-add{background:linear-gradient(90deg,color-mix(in srgb,var(--ctd-add) 15%,transparent),transparent 70%)}.ctd-source-editor .monaco-editor .ctd-code-line.ctd-code-remove{background:linear-gradient(90deg,color-mix(in srgb,var(--ctd-remove) 15%,transparent),transparent 70%)}.ctd-source-editor .monaco-editor .ctd-code-line.ctd-code-move,.ctd-source-editor .monaco-editor .ctd-code-line.ctd-code-rename{background:linear-gradient(90deg,color-mix(in srgb,var(--ctd-move) 13%,transparent),transparent 70%)}.ctd-source-editor .monaco-editor .ctd-code-line.ctd-code-source-only{opacity:.68}.ctd-source-editor .monaco-editor .ctd-code-line.ctd-code-unknown{background-image:repeating-linear-gradient(135deg,color-mix(in srgb,var(--ctd-accent) 14%,transparent) 0 5px,transparent 5px 10px)}.ctd-source-editor .monaco-editor .ctd-code-token{border-radius:2px;text-underline-offset:3px}.ctd-source-editor .monaco-editor .ctd-code-token.ctd-code-before.ctd-code-remove,.ctd-source-editor .monaco-editor .ctd-code-token.ctd-code-before.ctd-code-modify{background:color-mix(in srgb,var(--ctd-remove) 18%,transparent);text-decoration:line-through 2px var(--ctd-remove)}.ctd-source-editor .monaco-editor .ctd-code-token.ctd-code-after.ctd-code-add,.ctd-source-editor .monaco-editor .ctd-code-token.ctd-code-after.ctd-code-modify{background:color-mix(in srgb,var(--ctd-add) 17%,transparent);text-decoration:underline 2px var(--ctd-add)}.ctd-source-editor .monaco-editor .ctd-code-token.ctd-code-move,.ctd-source-editor .monaco-editor .ctd-code-token.ctd-code-rename{text-decoration:underline 2px dotted var(--ctd-move)}.ctd-source-editor .monaco-editor .ctd-code-selected{box-shadow:inset 3px 0 var(--ctd-accent),inset 0 1px color-mix(in srgb,var(--ctd-accent) 35%,transparent),inset 0 -1px color-mix(in srgb,var(--ctd-accent) 35%,transparent)}.ctd-source-editor .monaco-editor .ctd-code-lane{width:5px!important;margin-left:3px;background:var(--ctd-modify);border-radius:4px}.ctd-source-editor .monaco-editor .ctd-code-lane.ctd-code-add{background:var(--ctd-add)}.ctd-source-editor .monaco-editor .ctd-code-lane.ctd-code-remove{background:var(--ctd-remove)}.ctd-source-editor .monaco-editor .ctd-code-lane.ctd-code-move,.ctd-source-editor .monaco-editor .ctd-code-lane.ctd-code-rename{background:var(--ctd-move)}.ctd-source-editor .monaco-editor .ctd-code-glyph:before{display:block;text-align:center;color:var(--ctd-modify);content:"~";font-weight:700}.ctd-source-editor .monaco-editor .ctd-code-glyph.ctd-code-add:before{content:"+";color:var(--ctd-add)}.ctd-source-editor .monaco-editor .ctd-code-glyph.ctd-code-remove:before{content:"−";color:var(--ctd-remove)}.ctd-source-editor .monaco-editor .ctd-code-glyph.ctd-code-move:before,.ctd-source-editor .monaco-editor .ctd-code-glyph.ctd-code-rename:before{content:"↕";color:var(--ctd-move)}
.ctd-code-map-labels,.ctd-code-map-plot,.ctd-code-map-plot svg{height:70px}
@media(max-width:950px){.ctd-body{grid-template-columns:230px minmax(0,1fr)}.ctd-inspector{display:none}}@media(max-width:650px){.ctd-body{display:block}.ctd-nav{max-height:210px;border-right:0;border-bottom:1px solid var(--ctd-border)}.ctd-tree-grid,.ctd-value-grid{grid-template-columns:1fr}.ctd-source-shell{height:760px}.ctd-source-focus{align-items:flex-start;flex-wrap:wrap}.ctd-source-focus .ctd-change-meta{width:100%;margin-left:22px;text-align:left}.ctd-code-legend{display:none}}
`;

const symbols: Record<DiffChange['kind'], string> = {
  add: '+',
  remove: '−',
  modify: '~',
  rename: '↪',
  move: '↕',
  reorder: '⇅',
  type: 'T',
  comment: '#',
  refactor: '◇',
};

type MonacoCodeEditor = ReturnType<MonacoDiffEditor['getOriginalEditor']>;
type MonacoDecoration = Parameters<
  MonacoCodeEditor['deltaDecorations']
>[1][number];
type SourceSide = 'before' | 'after';

function pathOf(change: DiffChange) {
  return change.pathAfter ?? change.pathBefore ?? '/';
}

function lineCount(source: string | undefined) {
  return source ? source.split('\n').length : 1;
}

function sameFile(location: SourceLocation, filePath: string | undefined) {
  return !filePath || location.file === filePath;
}

function locationRange(editor: MonacoCodeEditor, location: SourceLocation) {
  const model = editor.getModel();
  if (!model) return;
  const maxLine = model.getLineCount();
  const startLineNumber = Math.max(1, Math.min(location.line, maxLine));
  const endLineNumber = Math.max(
    startLineNumber,
    Math.min(location.endLine, maxLine),
  );
  const startColumn = Math.max(
    1,
    Math.min(location.column, model.getLineMaxColumn(startLineNumber)),
  );
  const endColumn = Math.max(
    endLineNumber === startLineNumber ? startColumn : 1,
    Math.min(location.endColumn, model.getLineMaxColumn(endLineNumber)),
  );
  return { startLineNumber, startColumn, endLineNumber, endColumn };
}

function sourceDecorations(
  editor: MonacoCodeEditor,
  monaco: Monaco,
  changes: DiffChange[],
  side: SourceSide,
  selectedId: string | undefined,
  filePath: string | undefined,
) {
  return changes.flatMap((change): MonacoDecoration[] => {
    const location = change.spans[side];
    if (!location || !sameFile(location, filePath)) return [];
    const range = locationRange(editor, location);
    if (!range) return [];
    const selectedClass = change.id === selectedId ? ' ctd-code-selected' : '';
    const classNames = `ctd-code-${side} ctd-code-${change.kind} ctd-code-${change.classification}${selectedClass}`;
    const color =
      change.kind === 'add'
        ? '#59c88a'
        : change.kind === 'remove'
          ? '#ff7d88'
          : change.kind === 'move' || change.kind === 'rename'
            ? '#74b7e7'
            : '#f2b35f';
    return [
      {
        range,
        options: {
          className: `ctd-code-line ${classNames}`,
          inlineClassName: `ctd-code-token ${classNames}`,
          linesDecorationsClassName: `ctd-code-lane ${classNames}`,
          glyphMarginClassName: `ctd-code-glyph ${classNames}`,
          glyphMarginHoverMessage: {
            value: `${symbols[change.kind]} **${change.kind}** · \`${pathOf(change)}\``,
          },
          overviewRuler: {
            color,
            position: monaco.editor.OverviewRulerLane.Full,
          },
          minimap: {
            color,
            position: monaco.editor.MinimapPosition.Inline,
          },
          zIndex: change.id === selectedId ? 20 : 5,
        },
      },
    ];
  });
}

function changeAtLine(
  changes: DiffChange[],
  side: SourceSide,
  line: number,
  filePath: string | undefined,
) {
  return changes
    .filter(change => {
      const location = change.spans[side];
      return (
        location &&
        sameFile(location, filePath) &&
        line >= location.line &&
        line <= location.endLine
      );
    })
    .sort((left, right) => {
      const leftSpan = left.spans[side]!;
      const rightSpan = right.spans[side]!;
      return leftSpan.end - leftSpan.start - (rightSpan.end - rightSpan.start);
    })[0];
}

function mapPosition(line: number, lines: number) {
  return 20 + ((Math.max(1, line) - 1) / Math.max(1, lines - 1)) * 960;
}

function SourceChangeMap({
  changes,
  selectedId,
  beforeLines,
  afterLines,
  beforeFile,
  afterFile,
  onSelect,
}: {
  changes: DiffChange[];
  selectedId?: string;
  beforeLines: number;
  afterLines: number;
  beforeFile?: string;
  afterFile?: string;
  onSelect: (id: string) => void;
}) {
  const mapped = changes
    .map((change, index) => {
      const before =
        change.spans.before && sameFile(change.spans.before, beforeFile)
          ? change.spans.before
          : undefined;
      const after =
        change.spans.after && sameFile(change.spans.after, afterFile)
          ? change.spans.after
          : undefined;
      if (!before && !after) return;
      const beforeX = before
        ? mapPosition(before.line, beforeLines)
        : undefined;
      const afterX = after ? mapPosition(after.line, afterLines) : undefined;
      return {
        change,
        index,
        beforeX,
        afterX,
        hitX:
          beforeX === undefined
            ? afterX!
            : afterX === undefined
              ? beforeX
              : (beforeX + afterX) / 2,
      };
    })
    .filter(
      (
        value,
      ): value is {
        change: DiffChange;
        index: number;
        beforeX: number | undefined;
        afterX: number | undefined;
        hitX: number;
      } => value !== undefined,
    );

  return (
    <div className="ctd-code-map" aria-label="Code change map">
      <div className="ctd-code-map-labels" aria-hidden="true">
        <span>Before</span>
        <span>After</span>
      </div>
      <div className="ctd-code-map-plot">
        <svg
          viewBox="0 0 1000 70"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${mapped.length} mapped source changes`}
        >
          <line
            className="ctd-code-map-track"
            x1="20"
            x2="980"
            y1="10"
            y2="10"
          />
          <line
            className="ctd-code-map-track"
            x1="20"
            x2="980"
            y1="60"
            y2="60"
          />
          {mapped.map(({ change, beforeX, afterX }) => (
            <g
              className="ctd-code-map-change"
              data-kind={change.kind}
              data-selected={change.id === selectedId}
              key={change.id}
            >
              {beforeX !== undefined && afterX !== undefined && (
                <line x1={beforeX} x2={afterX} y1="10" y2="60" />
              )}
              {beforeX !== undefined && <circle cx={beforeX} cy="10" r="4" />}
              {afterX !== undefined && <circle cx={afterX} cy="60" r="4" />}
            </g>
          ))}
        </svg>
        {mapped.map(({ change, index, hitX }) => (
          <button
            type="button"
            className="ctd-code-map-hit"
            data-kind={change.kind}
            data-selected={change.id === selectedId}
            aria-label={`${change.kind}: ${pathOf(change)}`}
            key={change.id}
            onClick={() => onSelect(change.id)}
            style={{
              left: `${hitX / 10}%`,
              top: `${12 + (index % 4) * 14}px`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function StructureTree({
  node,
  onPath,
}: {
  node?: StructureNode;
  onPath: (path: string) => void;
}) {
  if (!node) return <div className="ctd-empty">Structure unavailable</div>;
  return (
    <ul>
      <li>
        <button type="button" onClick={() => onPath(node.path)}>
          <span className="ctd-change-path">{node.path || '/'}</span>
          <span className="ctd-kind">{node.kind}</span>
        </button>
        {node.children.map(child => (
          <StructureTree key={child.id} node={child} onPath={onPath} />
        ))}
      </li>
    </ul>
  );
}

export function DiffExplorer({
  report,
  initialView = 'structure',
  selectedChangeId,
  onSelectedChange,
  monacoTheme = 'vs-dark',
  className,
  style,
}: DiffExplorerProps) {
  const activeChanges = report.changes.filter(change => !change.ignored);
  const [internalSelected, setInternalSelected] = useState(
    selectedChangeId ?? activeChanges[0]?.id,
  );
  const [view, setView] = useState(initialView);
  const [query, setQuery] = useState('');
  const [classification, setClassification] = useState<'' | DiffClassification>(
    '',
  );
  const [expanded, setExpanded] = useState(false);
  const [kind, setKind] = useState<'' | DiffChangeKind>('');
  const [sideBySide, setSideBySide] = useState(true);
  const [sourceEditorVersion, setSourceEditorVersion] = useState(0);
  const editorRef = useRef<MonacoDiffEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const originalDecorationIds = useRef<string[]>([]);
  const modifiedDecorationIds = useRef<string[]>([]);
  const editorListeners = useRef<Array<{ dispose(): void }>>([]);
  const selected = selectedChangeId ?? internalSelected;
  const filtered = useMemo(
    () =>
      activeChanges.filter(
        change =>
          (!classification || change.classification === classification) &&
          (!kind || change.kind === kind) &&
          (!query ||
            pathOf(change).toLowerCase().includes(query.toLowerCase()) ||
            change.spans.after?.file
              .toLowerCase()
              .includes(query.toLowerCase()) ||
            change.spans.before?.file
              .toLowerCase()
              .includes(query.toLowerCase())),
      ),
    [activeChanges, classification, kind, query],
  );
  const change = report.changes.find(candidate => candidate.id === selected);
  const file = report.files[0];
  const beforeSource = expanded
    ? (file?.beforeExpandedSource ?? file?.beforeSource)
    : file?.beforeSource;
  const afterSource = expanded
    ? (file?.afterExpandedSource ?? file?.afterSource)
    : file?.afterSource;

  const select = (id: string) => {
    setInternalSelected(id);
    onSelectedChange?.(id);
    if (typeof window !== 'undefined') {
      window.history.replaceState(
        null,
        '',
        `#change=${encodeURIComponent(id)}&view=${view}`,
      );
    }
  };

  const selectView = (
    nextView: 'structure' | 'source' | 'value' | 'dependencies',
  ) => {
    setView(nextView);
    if (typeof window !== 'undefined' && selected) {
      window.history.replaceState(
        null,
        '',
        `#change=${encodeURIComponent(selected)}&view=${nextView}`,
      );
    }
  };

  const move = (delta: number) => {
    if (filtered.length === 0) return;
    const current = filtered.findIndex(item => item.id === selected);
    const index =
      current < 0 ? 0 : (current + delta + filtered.length) % filtered.length;
    select(filtered[index].id);
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const values = new URLSearchParams(window.location.hash.slice(1));
    const id = values.get('change');
    const requestedView = values.get('view');
    if (id && report.changes.some(candidate => candidate.id === id)) {
      setInternalSelected(id);
    }
    if (
      requestedView === 'structure' ||
      requestedView === 'source' ||
      requestedView === 'value' ||
      requestedView === 'dependencies'
    ) {
      setView(requestedView);
    }
  }, [report]);

  useEffect(() => {
    if (view !== 'source' || !editorRef.current || !monacoRef.current) {
      return;
    }
    const original = editorRef.current.getOriginalEditor();
    const modified = editorRef.current.getModifiedEditor();
    originalDecorationIds.current = original.deltaDecorations(
      originalDecorationIds.current,
      sourceDecorations(
        original,
        monacoRef.current,
        report.changes,
        'before',
        selected,
        file?.pathBefore,
      ),
    );
    modifiedDecorationIds.current = modified.deltaDecorations(
      modifiedDecorationIds.current,
      sourceDecorations(
        modified,
        monacoRef.current,
        report.changes,
        'after',
        selected,
        file?.pathAfter,
      ),
    );
    if (!change) return;
    if (change.spans.before) {
      const range = locationRange(original, change.spans.before);
      if (range) {
        original.setSelection(range);
        original.revealRangeInCenter(range);
      }
    }
    if (change.spans.after) {
      const range = locationRange(modified, change.spans.after);
      if (range) {
        modified.setSelection(range);
        modified.revealRangeInCenter(range);
      }
    }
  }, [
    change,
    expanded,
    file?.pathAfter,
    file?.pathBefore,
    report.changes,
    selected,
    sourceEditorVersion,
    view,
  ]);

  const selectPath = (path: string) => {
    const candidate = activeChanges.find(item => pathOf(item) === path);
    if (candidate) select(candidate.id);
  };

  const selectFile = (path: string) => {
    const candidate = activeChanges.find(
      item =>
        item.spans.before?.file === path || item.spans.after?.file === path,
    );
    if (candidate) select(candidate.id);
  };

  return (
    <section
      className={`ctd${className ? ` ${className}` : ''}`}
      style={style}
      aria-label="conf.ts structural diff"
      tabIndex={0}
      onKeyDown={event => {
        if (!event.altKey) return;
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        }
      }}
    >
      <style>{CSS}</style>
      <header className="ctd-toolbar">
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Filter JSON Pointer or file"
          aria-label="Filter changes"
        />
        <select
          value={classification}
          onChange={event =>
            setClassification(event.target.value as '' | DiffClassification)
          }
          aria-label="Change classification"
        >
          <option value="">All layers</option>
          <option value="semantic">Semantic</option>
          <option value="source-only">Source-only</option>
          <option value="unknown">Unknown</option>
        </select>
        <select
          value={kind}
          onChange={event => setKind(event.target.value as '' | DiffChangeKind)}
          aria-label="Change kind"
        >
          <option value="">All kinds</option>
          {Object.keys(symbols).map(candidate => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ctd-tool"
          onClick={() => move(-1)}
          aria-label="Previous change"
        >
          ↑
        </button>
        <button
          type="button"
          className="ctd-tool"
          onClick={() => move(1)}
          aria-label="Next change"
        >
          ↓
        </button>
        <span className="ctd-count">
          {report.summary.semantic} semantic · {report.summary.sourceOnly}{' '}
          source-only · {report.summary.unknown} unknown
        </span>
      </header>
      <div className="ctd-body">
        <nav className="ctd-nav" aria-label="Changes">
          {filtered.length ? (
            filtered.map(item => (
              <button
                key={item.id}
                type="button"
                className="ctd-change"
                data-selected={selected === item.id}
                onClick={() => select(item.id)}
              >
                <span
                  className="ctd-mark"
                  data-kind={item.kind}
                  aria-hidden="true"
                >
                  {symbols[item.kind]}
                </span>
                <span>
                  <span className="ctd-change-path">{pathOf(item)}</span>
                  <span className="ctd-change-meta">
                    {item.classification} · {item.kind}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <div className="ctd-empty">No matching changes</div>
          )}
        </nav>
        <div className="ctd-main">
          <div className="ctd-tabs" role="tablist">
            {(['structure', 'source', 'value', 'dependencies'] as const).map(
              candidate => (
                <button
                  key={candidate}
                  type="button"
                  role="tab"
                  className="ctd-tab"
                  data-active={view === candidate}
                  aria-selected={view === candidate}
                  onClick={() => selectView(candidate)}
                >
                  {candidate[0].toUpperCase()}
                  {candidate.slice(1)}
                </button>
              ),
            )}
          </div>
          {view === 'structure' && (
            <div className="ctd-view ctd-tree-grid">
              <div className="ctd-tree">
                <StructureTree
                  node={report.structure.before}
                  onPath={selectPath}
                />
              </div>
              <div className="ctd-tree">
                <StructureTree
                  node={report.structure.after}
                  onPath={selectPath}
                />
              </div>
            </div>
          )}
          {view === 'source' && (
            <div className="ctd-source-shell">
              <div className="ctd-source-toolbar">
                <div className="ctd-source-controls">
                  <button
                    type="button"
                    className="ctd-source-toggle"
                    aria-pressed={!expanded}
                    onClick={() => setExpanded(false)}
                  >
                    Raw
                  </button>
                  <button
                    type="button"
                    className="ctd-source-toggle"
                    aria-pressed={expanded}
                    disabled={
                      file?.beforeExpandedSource === undefined &&
                      file?.afterExpandedSource === undefined
                    }
                    onClick={() => setExpanded(true)}
                  >
                    Expanded
                  </button>
                  <span className="ctd-source-separator" aria-hidden="true" />
                  <button
                    type="button"
                    className="ctd-source-toggle"
                    aria-pressed={sideBySide}
                    onClick={() => setSideBySide(true)}
                  >
                    Split
                  </button>
                  <button
                    type="button"
                    className="ctd-source-toggle"
                    aria-pressed={!sideBySide}
                    onClick={() => setSideBySide(false)}
                  >
                    Inline
                  </button>
                </div>
                <div className="ctd-code-legend" aria-label="Change legend">
                  <span>
                    <i data-kind="remove" /> removed
                  </span>
                  <span>
                    <i data-kind="add" /> added
                  </span>
                  <span>
                    <i /> changed
                  </span>
                  <span>
                    <i data-kind="move" /> moved
                  </span>
                </div>
              </div>
              <SourceChangeMap
                changes={filtered}
                selectedId={selected}
                beforeLines={lineCount(beforeSource)}
                afterLines={lineCount(afterSource)}
                beforeFile={file?.pathBefore}
                afterFile={file?.pathAfter}
                onSelect={select}
              />
              <div
                className="ctd-source-focus"
                aria-live="polite"
                data-kind={change?.kind}
              >
                {change ? (
                  <>
                    <span
                      className="ctd-mark"
                      data-kind={change.kind}
                      aria-hidden="true"
                    >
                      {symbols[change.kind]}
                    </span>
                    <strong>{pathOf(change)}</strong>
                    <span className="ctd-change-meta">
                      {change.spans.before
                        ? `L${change.spans.before.line}`
                        : '∅'}{' '}
                      →{' '}
                      {change.spans.after ? `L${change.spans.after.line}` : '∅'}{' '}
                      · {change.matchReason ?? 'direct match'}
                    </span>
                  </>
                ) : (
                  <span className="ctd-change-meta">
                    Select a change marker or highlighted line
                  </span>
                )}
              </div>
              {file?.beforeSource !== undefined &&
              file.afterSource !== undefined ? (
                <div className="ctd-source-editor">
                  <DiffEditor
                    height="100%"
                    original={beforeSource}
                    modified={afterSource}
                    originalModelPath={`${file.pathBefore ?? '/config.conf.ts'}#conf-ts-diff-before`}
                    modifiedModelPath={`${file.pathAfter ?? '/config.conf.ts'}#conf-ts-diff-after`}
                    language="typescript"
                    theme={monacoTheme}
                    onMount={(editor, monaco) => {
                      editorListeners.current.forEach(listener =>
                        listener.dispose(),
                      );
                      editorListeners.current = [];
                      editorRef.current = editor;
                      monacoRef.current = monaco;
                      originalDecorationIds.current = [];
                      modifiedDecorationIds.current = [];
                      const original = editor.getOriginalEditor();
                      const modified = editor.getModifiedEditor();
                      editorListeners.current.push(
                        original.onMouseDown(event => {
                          const line = event.target.position?.lineNumber;
                          if (!line) return;
                          const candidate = changeAtLine(
                            report.changes,
                            'before',
                            line,
                            file.pathBefore,
                          );
                          if (candidate) select(candidate.id);
                        }),
                        modified.onMouseDown(event => {
                          const line = event.target.position?.lineNumber;
                          if (!line) return;
                          const candidate = changeAtLine(
                            report.changes,
                            'after',
                            line,
                            file.pathAfter,
                          );
                          if (candidate) select(candidate.id);
                        }),
                      );
                      setSourceEditorVersion(version => version + 1);
                    }}
                    options={{
                      readOnly: true,
                      originalEditable: false,
                      renderSideBySide: sideBySide,
                      useInlineViewWhenSpaceIsLimited: true,
                      renderSideBySideInlineBreakpoint: 720,
                      renderIndicators: true,
                      renderMarginRevertIcon: false,
                      ignoreTrimWhitespace: true,
                      diffWordWrap: 'on',
                      glyphMargin: true,
                      lineDecorationsWidth: 16,
                      minimap: { enabled: true, showSlider: 'always' },
                      renderOverviewRuler: true,
                      overviewRulerBorder: false,
                      scrollBeyondLastLine: false,
                      folding: true,
                      automaticLayout: true,
                    }}
                  />
                </div>
              ) : (
                <div className="ctd-empty">Source omitted from report</div>
              )}
            </div>
          )}
          {view === 'value' && (
            <div className="ctd-view ctd-value-grid">
              <div className="ctd-value">
                <pre>{JSON.stringify(report.evaluation.before, null, 2)}</pre>
              </div>
              <div className="ctd-value">
                <pre>{JSON.stringify(report.evaluation.after, null, 2)}</pre>
              </div>
            </div>
          )}
          {view === 'dependencies' && (
            <div className="ctd-view ctd-graph">
              {report.dependencyGraph.nodes.map(node => (
                <button
                  type="button"
                  key={node.id}
                  className="ctd-file"
                  data-changed={node.before !== node.after}
                  onClick={() => selectFile(node.path)}
                >
                  {node.path}{' '}
                  <span className="ctd-change-meta">
                    {node.before && node.after
                      ? 'both'
                      : node.before
                        ? 'removed'
                        : 'added'}
                  </span>
                </button>
              ))}
              {report.dependencyGraph.edges.map(edge => (
                <button
                  type="button"
                  key={`${edge.side}:${edge.from}:${edge.specifier}`}
                  className="ctd-edge"
                  onClick={() => selectFile(edge.to)}
                >
                  {edge.from} → {edge.to} · {edge.specifier}
                </button>
              ))}
            </div>
          )}
        </div>
        <aside className="ctd-inspector" aria-label="Selected change">
          {change ? (
            <>
              <h3>{pathOf(change)}</h3>
              <dl>
                <dt>Layer</dt>
                <dd>{change.classification}</dd>
                <dt>Change</dt>
                <dd>{change.kind}</dd>
                <dt>Before</dt>
                <dd>{change.pathBefore ?? '∅'}</dd>
                <dt>After</dt>
                <dd>{change.pathAfter ?? '∅'}</dd>
                <dt>Match</dt>
                <dd>{change.matchReason ?? 'direct'}</dd>
                <dt>Types</dt>
                <dd>
                  {change.before?.valueType ?? '∅'} →{' '}
                  {change.after?.valueType ?? '∅'}
                </dd>
                <dt>Sensitive</dt>
                <dd>{change.sensitive ? 'redacted' : 'no'}</dd>
                <dt>Location</dt>
                <dd>
                  {change.spans.after
                    ? `${change.spans.after.file}:${change.spans.after.line}`
                    : change.spans.before
                      ? `${change.spans.before.file}:${change.spans.before.line}`
                      : '—'}
                </dd>
              </dl>
              <div className="ctd-preview">
                {JSON.stringify(
                  {
                    before: change.before?.preview,
                    after: change.after?.preview,
                  },
                  null,
                  2,
                )}
              </div>
              <h4>Origin chain</h4>
              {change.originChain.length ? (
                change.originChain.map((origin, index) => (
                  <div
                    className="ctd-origin"
                    key={`${origin.file}:${origin.start}:${index}`}
                  >
                    {origin.file}:{origin.line}:{origin.column}
                  </div>
                ))
              ) : (
                <div className="ctd-change-meta">No mapped origin</div>
              )}
              {change.relatedChangeIds.length > 0 && (
                <>
                  <h4>Related changes</h4>
                  {change.relatedChangeIds.map(id => (
                    <button
                      type="button"
                      className="ctd-origin"
                      key={id}
                      onClick={() => select(id)}
                    >
                      {id}
                    </button>
                  ))}
                </>
              )}
              {report.diagnostics.length > 0 && (
                <>
                  <h4>Diagnostics</h4>
                  {report.diagnostics.map((diagnostic, index) => (
                    <div
                      className="ctd-diagnostic"
                      data-severity={diagnostic.severity}
                      key={`${diagnostic.code}:${index}`}
                    >
                      <strong>{diagnostic.code}</strong>
                      <br />
                      {diagnostic.message}
                    </div>
                  ))}
                </>
              )}
            </>
          ) : (
            <div className="ctd-empty">Select a change</div>
          )}
        </aside>
      </div>
    </section>
  );
}
