// A small self-contained markdown renderer for content bodies (plan-mode note bodies, rule bodies)
// and anywhere we show agent-written markdown outside the chat. Handles the constructs the agent
// actually emits: ATX headings, bullet + numbered lists, **bold**, `code`, and paragraphs.
import { Fragment } from 'react';
import { T } from './tokens';

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'para'; text: string };

function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let ul: string[] = [];
  let ol: string[] = [];
  const flushPara = (): void => {
    if (para.length) blocks.push({ type: 'para', text: para.join('\n') });
    para = [];
  };
  const flushUl = (): void => {
    if (ul.length) blocks.push({ type: 'ul', items: ul });
    ul = [];
  };
  const flushOl = (): void => {
    if (ol.length) blocks.push({ type: 'ol', items: ol });
    ol = [];
  };
  const flushAll = (): void => {
    flushPara();
    flushUl();
    flushOl();
  };
  for (const line of src.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! });
    } else if (bullet) {
      flushPara();
      flushOl();
      ul.push(bullet[1]!);
    } else if (numbered) {
      flushPara();
      flushUl();
      ol.push(numbered[1]!);
    } else if (line.trim() === '') {
      flushAll();
    } else {
      flushUl();
      flushOl();
      para.push(line);
    }
  }
  flushAll();
  return blocks;
}

/** Inline: **bold** and `code`. */
function Inline({ text }: { text: string }): React.JSX.Element {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>);
    if (m[1] !== undefined)
      out.push(
        <strong key={key++} style={{ fontWeight: 650 }}>
          {m[1]}
        </strong>,
      );
    else
      out.push(
        <code
          key={key++}
          style={{
            fontFamily: T.mono,
            fontSize: '0.9em',
            background: T.bg,
            borderRadius: 4,
            padding: '0 4px',
            overflowWrap: 'anywhere', // a long path/command breaks rather than widening the column
          }}
        >
          {m[2]}
        </code>,
      );
    last = m.index + m[0]!.length;
  }
  if (last < text.length) out.push(<Fragment key={key}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}

/** Render a markdown string as styled blocks. */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'heading')
          return (
            <div
              key={i}
              style={{
                fontFamily: T.serif,
                fontWeight: 600,
                color: T.ink,
                fontSize: b.level <= 1 ? 17 : b.level === 2 ? 15.5 : 14.5,
                marginTop: i === 0 ? 0 : 16,
                marginBottom: 4,
              }}
            >
              <Inline text={b.text} />
            </div>
          );
        if (b.type === 'ul' || b.type === 'ol')
          return (
            <div
              key={i}
              style={{
                marginTop: i === 0 ? 0 : 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {b.items.map((it, j) => {
                // GitHub-style checklist items: "- [ ] …" / "- [x] …" render as checkboxes.
                const box = /^\[([ xX])\]\s+(.*)$/.exec(it);
                if (box) {
                  const done = box[1]!.toLowerCase() === 'x';
                  return (
                    <div key={j} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <span
                        style={{
                          flex: '0 0 auto',
                          width: 14,
                          height: 14,
                          borderRadius: 4,
                          border: `1.5px solid ${done ? T.green : T.line}`,
                          background: done ? T.green : 'transparent',
                          color: '#fff',
                          fontSize: 10,
                          lineHeight: '12px',
                          textAlign: 'center',
                          alignSelf: 'center',
                        }}
                      >
                        {done ? '✓' : ''}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflowWrap: 'anywhere',
                          lineHeight: 1.6,
                          color: done ? T.faint : T.ink,
                          textDecoration: done ? 'line-through' : 'none',
                        }}
                      >
                        <Inline text={box[2]!} />
                      </span>
                    </div>
                  );
                }
                return (
                  <div key={j} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span
                      style={{
                        color: T.faint,
                        fontVariantNumeric: 'tabular-nums',
                        flex: '0 0 auto',
                      }}
                    >
                      {b.type === 'ol' ? `${j + 1}.` : '•'}
                    </span>
                    <span
                      style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', lineHeight: 1.6 }}
                    >
                      <Inline text={it} />
                    </span>
                  </div>
                );
              })}
            </div>
          );
        return (
          <div
            key={i}
            style={{
              marginTop: i === 0 ? 0 : 10,
              lineHeight: 1.7,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            <Inline text={b.text} />
          </div>
        );
      })}
    </>
  );
}
