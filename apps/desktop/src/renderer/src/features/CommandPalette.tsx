// Ctrl+K: instant local search over node titles + bodies, teleporting to the chosen node
// (decision 49). Zero tokens, well under 10ms — the counterpart to the chat's semantic search.
import { useEffect, useMemo, useRef, useState } from 'react';
import { T } from '../shared/tokens';
import { searchNodes, type SearchHit } from '../shared/search';
import type { AtlasVm } from '../shared/viewmodel';

interface CommandPaletteProps {
  vm: AtlasVm;
  onPick: (id: string) => void;
  onClose: () => void;
}

export function CommandPalette({ vm, onPick, onClose }: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const hits = useMemo<SearchHit[]>(() => searchNodes(vm, query), [vm, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setActive(0);
  }, [query]);

  const choose = (hit: SearchHit | undefined): void => {
    if (hit) onPick(hit.id);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      choose(hits[active]);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(35,34,30,0.24)',
        display: 'flex',
        justifyContent: 'center',
        paddingTop: '12vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, calc(100vw - 32px))',
          height: 'fit-content',
          maxHeight: '70vh',
          background: T.paper,
          border: `1.5px solid ${T.line}`,
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(35,34,30,0.25)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find a node by title or body…"
          style={{
            padding: '15px 18px',
            border: 'none',
            borderBottom: `1.5px solid ${T.lineSoft}`,
            outline: 'none',
            fontSize: 16,
            fontFamily: T.sans,
            color: T.ink,
            background: 'transparent',
          }}
        />
        <div style={{ overflowY: 'auto' }}>
          {hits.map((hit, i) => (
            <div
              key={hit.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(hit)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 18px',
                cursor: 'pointer',
                background: i === active ? T.orangeSoft : 'transparent',
              }}
            >
              <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.faint, width: 62 }}>
                {hit.kind}
              </span>
              <span style={{ fontSize: 13.5, color: T.ink, flex: 1 }}>{hit.title}</span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.faint }}>
                {hit.path.replace(/^.*\//, '')}
              </span>
            </div>
          ))}
          {query && hits.length === 0 && (
            <div style={{ padding: '16px 18px', color: T.faint, fontSize: 13 }}>
              No nodes match “{query}”.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
