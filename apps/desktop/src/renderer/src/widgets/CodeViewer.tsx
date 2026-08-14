// Read-only code viewer (decision 47): CodeMirror 6, opened from a rule's anchor and scrolled to
// the anchor line. Alethic is an IDE for the spec, so this is deliberately read-only; the actual
// editing happens via the agent or an external editor ("Open externally").
import { useEffect, useRef, useState } from 'react';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { javascript as jsLang } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { T } from '../shared/tokens';
import { btnGhost } from '../shared/ui';

interface CodeViewerProps {
  file: string;
  line: number;
  onClose: () => void;
}

function languageFor(file: string): Extension[] {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext))
    return [jsLang({ typescript: true, jsx: ext === '.tsx' })];
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return [jsLang({ jsx: true })];
  if (ext === '.py') return [python()];
  if (['.yaml', '.yml'].includes(ext)) return [yaml()];
  return [];
}

export function CodeViewer({ file, line, onClose }: CodeViewerProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let view: EditorView | null = null;
    let cancelled = false;
    void window.alethic.readCode(file).then((code) => {
      if (cancelled) return;
      if (!code) {
        setError(`Could not read ${file}`);
        return;
      }
      const state = EditorState.create({
        doc: code.text,
        extensions: [
          lineNumbers(),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.theme({
            '&': { backgroundColor: T.card, height: '100%' },
            '.cm-content': { fontFamily: T.mono, fontSize: '12.5px' },
            '.cm-gutters': { backgroundColor: T.paper, border: 'none', color: T.faint },
          }),
          ...languageFor(file),
        ],
      });
      view = new EditorView({ state, parent: host.current! });
      const target = Math.min(Math.max(1, line), state.doc.lines);
      const pos = state.doc.line(target).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
    });
    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [file, line]);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(720px, 60vw)',
        zIndex: 70,
        background: T.card,
        borderLeft: `1.5px solid ${T.line}`,
        boxShadow: '-8px 0 30px rgba(35,34,30,0.14)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
          borderBottom: `1.5px solid ${T.lineSoft}`,
        }}
      >
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.ink, flex: 1 }}>
          {file}:{line}
        </span>
        <button
          onClick={() => void window.alethic.openExternal(file)}
          style={{ ...btnGhost, padding: '6px 12px' }}
        >
          Open externally ↗
        </button>
        <button onClick={onClose} style={{ ...btnGhost, padding: '6px 12px' }}>
          ✕
        </button>
      </div>
      {error ? (
        <div style={{ padding: 20, color: T.sub, fontFamily: T.mono, fontSize: 12.5 }}>{error}</div>
      ) : (
        <div ref={host} style={{ flex: 1, overflow: 'auto' }} />
      )}
    </div>
  );
}
