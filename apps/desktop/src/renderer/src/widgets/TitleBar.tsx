// TitleBar — the app's own title bar (the window is frameless on Windows/Linux). It carries only
// affordances that exist in the app: the project menu that used to be the native File menu
// (Open folder / Open Recent / Close project, decision 37), the Ctrl+K search, and — where the OS
// no longer draws them — minimize/maximize/close. Everything else stays where it already lives.
import { useEffect, useRef, useState } from 'react';
import { T } from '../shared/tokens';
import type { RecentProject, WindowState } from '../entities/node';

export const TITLE_BAR_H = 36;

// `-webkit-app-region` tells a frameless window which pixels drag it. React's CSSProperties does
// not type the vendor property, so the two values are declared once here rather than cast inline.
const DRAG = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

interface TitleBarProps {
  projectOpen: boolean;
  onOpenFolder: () => void;
  onOpenRecent: (path: string) => void;
  onCloseProject: () => void;
  /** Opens the command palette; absent while no project is open (there is nothing to search). */
  onSearch?: (() => void) | undefined;
}

export function TitleBar({
  projectOpen,
  onOpenFolder,
  onOpenRecent,
  onCloseProject,
  onSearch,
}: TitleBarProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [state, setState] = useState<WindowState>({ maximized: false, customControls: true });
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.alethic.windowState().then(setState);
    return window.alethic.onWindowState(setState);
  }, []);

  // Close the menu on an outside click or Escape — the two ways every menu closes.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const openMenu = (): void => {
    void window.alethic.recentProjects().then(setRecent);
    setMenuOpen((o) => !o);
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: TITLE_BAR_H,
        zIndex: 200, // above every panel and overlay: the window must always be draggable/closable
        display: 'flex',
        alignItems: 'center',
        background: T.paper,
        borderBottom: `1.5px solid ${T.lineSoft}`,
        ...DRAG, // the bar itself moves the window; the controls opt out below
        userSelect: 'none',
        // macOS keeps its native traffic lights on top of the content — leave them their corner.
        paddingLeft: state.customControls ? 4 : 78,
        paddingRight: state.customControls ? 0 : 6,
      }}
    >
      <div ref={menuRef} style={{ display: 'flex', alignItems: 'center', ...NO_DRAG }}>
        <BarButton label="Menu" active={menuOpen} onClick={openMenu}>
          <Glyph d="M2 3.5h10M2 7h10M2 10.5h10" />
        </BarButton>
        <BarButton label="Search the map (Ctrl+K)" onClick={onSearch} disabled={!onSearch}>
          <Glyph d="M6.4 2.4a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9.4 9.4 12.4 12.4" />
        </BarButton>
        {menuOpen && (
          <Menu
            recent={recent}
            projectOpen={projectOpen}
            onPick={(action, path) => {
              setMenuOpen(false);
              if (action === 'open') onOpenFolder();
              else if (action === 'recent' && path) onOpenRecent(path);
              else if (action === 'close') onCloseProject();
            }}
          />
        )}
      </div>

      <div style={{ flex: 1 }} />

      {state.customControls && (
        <div style={{ display: 'flex', alignSelf: 'stretch', ...NO_DRAG }}>
          <WindowButton label="Minimize" onClick={() => void window.alethic.windowMinimize()}>
            <Glyph d="M2.5 7h9" />
          </WindowButton>
          <WindowButton
            label={state.maximized ? 'Restore' : 'Maximize'}
            onClick={() => void window.alethic.windowToggleMaximize()}
          >
            {state.maximized ? (
              <Glyph d="M4 4.5V3.2h7.3v7.3H10M2.7 5.8h7.3v7.3H2.7z" />
            ) : (
              <Glyph d="M3 3.2h8v8H3z" />
            )}
          </WindowButton>
          <WindowButton label="Close" danger onClick={() => void window.alethic.windowClose()}>
            <Glyph d="M3.2 3.2 10.8 10.8M10.8 3.2 3.2 10.8" />
          </WindowButton>
        </div>
      )}
    </div>
  );
}

/** A 14×14 stroked icon — one path, so every glyph in the bar has the same weight. */
function Glyph({ d }: { d: string }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d={d} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function BarButton({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string;
  onClick?: (() => void) | undefined;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        placeItems: 'center',
        width: 34,
        height: 26,
        margin: '0 1px',
        border: 'none',
        borderRadius: 7,
        background: active || hover ? T.card : 'transparent',
        color: disabled ? T.faint : T.sub,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

/** A window control: full-height, square-cornered hit area, Windows-style. */
function WindowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        placeItems: 'center',
        width: 46,
        height: '100%',
        border: 'none',
        background: hover ? (danger ? '#C0392B' : T.card) : 'transparent',
        color: hover && danger ? '#fff' : T.sub,
        cursor: 'pointer',
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

/** The project menu — the same actions the native File menu carried, nothing more. */
function Menu({
  recent,
  projectOpen,
  onPick,
}: {
  recent: RecentProject[];
  projectOpen: boolean;
  onPick: (action: 'open' | 'recent' | 'close', path?: string) => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        position: 'absolute',
        top: TITLE_BAR_H - 2,
        left: 6,
        minWidth: 250,
        maxWidth: 380,
        padding: 5,
        borderRadius: 10,
        background: T.paper,
        border: `1.5px solid ${T.line}`,
        boxShadow: '0 10px 28px rgba(0,0,0,0.14)',
        fontFamily: T.sans,
        fontSize: 12.5,
        color: T.ink,
      }}
    >
      <Item label="Open folder…" hint="Ctrl+O" onClick={() => onPick('open')} />
      <Label text={recent.length ? 'Recent' : 'No recent projects'} />
      {recent.slice(0, 6).map((r) => (
        <Item
          key={r.path}
          label={r.name || r.path}
          hint={r.path}
          onClick={() => onPick('recent', r.path)}
        />
      ))}
      <Separator />
      <Item
        label="Close project"
        hint="Ctrl+W"
        disabled={!projectOpen}
        onClick={() => onPick('close')}
      />
    </div>
  );
}

function Item({
  label,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        padding: '6px 9px',
        borderRadius: 7,
        cursor: disabled ? 'default' : 'pointer',
        background: hover && !disabled ? T.card : 'transparent',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {hint && (
        <span
          style={{
            fontFamily: T.mono,
            fontSize: 10,
            color: T.faint,
            flex: '0 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl', // a long path keeps its tail (the folder name) visible
          }}
        >
          {hint}
        </span>
      )}
    </div>
  );
}

const Label = ({ text }: { text: string }): React.JSX.Element => (
  <div
    style={{
      padding: '7px 9px 3px',
      fontFamily: T.mono,
      fontSize: 9.5,
      letterSpacing: 1,
      textTransform: 'uppercase',
      color: T.faint,
    }}
  >
    {text}
  </div>
);

const Separator = (): React.JSX.Element => (
  <div style={{ height: 1, background: T.lineSoft, margin: '5px 4px' }} />
);
