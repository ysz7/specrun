// App root: pick the page from the atlas state. No fake data — Welcome until a project is open,
// then the live Workspace. The whole app sits under our own title bar (the window is frameless).
import { useEffect, useState } from 'react';
import { T } from '../shared/tokens';
import { useAtlas } from './useAtlas';
import { Welcome } from '../pages/Welcome';
import { Workspace } from '../pages/Workspace';
import { ScanFlow } from '../features/ScanFlow';
import { TitleBar, TITLE_BAR_H } from '../widgets/TitleBar';

export function App(): React.JSX.Element {
  const { snapshot, loading, open, pick, setMode, close } = useAtlas();
  // Bumped by the title bar's search button; the Workspace opens its palette when it changes.
  const [searchNonce, setSearchNonce] = useState(0);
  const hasProject = !!snapshot;

  // Menu actions (decision 37: native on macOS, our title bar elsewhere) + the accelerators that
  // used to come from the native menu — on a frameless window the menu no longer supplies them.
  useEffect(() => {
    const off = window.alethic.onAppMenu((m) => {
      if (m.action === 'open-folder') void pick();
      else if (m.action === 'open-recent' && m.path) void open(m.path);
      else if (m.action === 'close-project') close();
    });
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'o') {
        e.preventDefault();
        void pick();
      } else if (key === 'w' && hasProject) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
    };
  }, [pick, open, close, hasProject]);

  const page = ((): React.JSX.Element => {
    if (loading) {
      return (
        <div
          style={{
            height: '100%',
            display: 'grid',
            placeItems: 'center',
            background: T.bg,
            color: T.sub,
            fontFamily: T.sans,
          }}
        >
          Loading the map…
        </div>
      );
    }
    if (!snapshot) return <Welcome onOpen={open} onPick={pick} />;
    // A project is open but has no map yet → Act 1: scan it (the pyramid grows behind the flow).
    if (Object.keys(snapshot.index.nodes).length === 0) {
      return <ScanFlow onDone={() => void open(snapshot.root)} />;
    }
    return (
      <Workspace
        snapshot={snapshot}
        onOpenFolder={pick}
        onCloseProject={close}
        onSetMode={setMode}
        openSearch={searchNonce}
      />
    );
  })();

  const searchable = !!snapshot && Object.keys(snapshot.index.nodes).length > 0;
  return (
    <>
      <TitleBar
        projectOpen={hasProject}
        onOpenFolder={() => void pick()}
        onOpenRecent={(path) => void open(path)}
        onCloseProject={close}
        onSearch={searchable ? () => setSearchNonce((n) => n + 1) : undefined}
      />
      {/*
        The app's panels and overlays are positioned `fixed`, which would put them under the title
        bar. A transform on this wrapper makes it their containing block, so `fixed; inset: 0` means
        "the area below the bar" — one line here instead of a hard-coded offset in every overlay.
      */}
      <div
        style={{
          position: 'fixed',
          top: TITLE_BAR_H,
          left: 0,
          right: 0,
          bottom: 0,
          transform: 'translateZ(0)',
        }}
      >
        {page}
      </div>
    </>
  );
}
