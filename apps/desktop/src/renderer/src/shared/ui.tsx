// Small presentational primitives ported from the original design reference:
// the status dot, the ⚠ drift badge, the card shell, and the two button styles.
import type { CSSProperties, ReactNode, Ref } from 'react';
import { T } from './tokens';

export function Tick({ color }: { color: string }): React.JSX.Element {
  return (
    <span
      style={{ width: 8, height: 8, borderRadius: 99, flexShrink: 0, background: color }}
      aria-hidden
    />
  );
}

export function Warn({ n }: { n: number }): React.JSX.Element | null {
  if (n <= 0) return null;
  return (
    <span
      style={{
        fontFamily: T.mono,
        fontSize: 9.5,
        color: T.orange,
        background: T.orangeSoft,
        border: '1px solid rgba(217,98,43,0.35)',
        borderRadius: 5,
        padding: '1px 5px',
      }}
    >
      ⚠{n}
    </span>
  );
}

export function Chip({
  text,
  tone = 'faint',
}: {
  text: string;
  tone?: 'faint' | 'green' | 'orange';
}): React.JSX.Element {
  const color = tone === 'green' ? T.green : tone === 'orange' ? T.orange : T.faint;
  const bg = tone === 'green' ? T.greenSoft : tone === 'orange' ? T.orangeSoft : 'transparent';
  return (
    <span
      style={{
        fontFamily: T.mono,
        fontSize: 9,
        color,
        background: bg,
        border: `1px solid ${color}55`,
        borderRadius: 5,
        padding: '1px 5px',
      }}
    >
      {text}
    </span>
  );
}

export function Card({
  children,
  onClick,
  dashed,
  hot,
  dim,
  hidden,
  pad = '12px 16px',
  style,
  cardRef,
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  dashed?: boolean;
  hot?: boolean;
  dim?: boolean;
  hidden?: boolean;
  pad?: string;
  style?: CSSProperties;
  cardRef?: Ref<HTMLDivElement>;
}): React.JSX.Element {
  return (
    <div
      ref={cardRef}
      onClick={onClick}
      style={{
        background: T.card,
        borderRadius: 10,
        padding: pad,
        cursor: 'pointer',
        position: 'relative',
        zIndex: 1,
        border: `1.5px ${dashed ? 'dashed' : 'solid'} ${hot ? T.orange : dashed ? T.orange : T.line}`,
        boxShadow: hot ? '0 3px 14px rgba(35,34,30,0.12)' : '0 1px 2px rgba(35,34,30,0.04)',
        opacity: hidden ? 0 : dim ? 0.28 : 1,
        transition: 'opacity 0.25s, border-color 0.2s, box-shadow 0.2s',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export const btnPrimary: CSSProperties = {
  fontFamily: T.sans,
  fontSize: 13.5,
  fontWeight: 600,
  color: '#fff',
  background: T.orange,
  border: 'none',
  borderRadius: 9,
  padding: '11px 16px',
  cursor: 'pointer',
};

export const btnGhost: CSSProperties = {
  fontFamily: T.sans,
  fontSize: 13.5,
  color: T.sub,
  background: 'none',
  border: `1.5px solid ${T.line}`,
  borderRadius: 9,
  padding: '10px 16px',
  cursor: 'pointer',
};
