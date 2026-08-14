import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AtlasEvent } from '@alethic/ipc';
import { AtlasService } from './atlas.service';

const FIXTURE = join(process.cwd(), 'fixtures/acme-commerce');

describe('AtlasService', () => {
  let tmp: string;
  let atlas: AtlasService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'alethic-atlas-'));
    cpSync(FIXTURE, tmp, { recursive: true });
    atlas = new AtlasService();
  });
  afterEach(() => {
    atlas.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loads a project into a valid snapshot', () => {
    const snapshot = atlas.open(tmp);
    expect(snapshot.root).toBe(tmp);
    expect(snapshot.nodes).toHaveLength(27);
    expect(Object.keys(snapshot.index.nodes)).toHaveLength(27);
    const rootId = Object.keys(snapshot.index.nodes).find(
      (id) => !snapshot.index.nodes[id]!.parent,
    )!;
    expect(snapshot.index.rollup[rootId]!.worst).toBe('drift');
  });

  it('emits an incremental patch when a file changes on disk', async () => {
    atlas.open(tmp);
    const rel = 'domains/payments/discounts/promo-codes.md';
    const abs = join(tmp, '.alethic', rel);

    const event = await new Promise<AtlasEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no patch event within timeout')), 9000);
      atlas.onEvent((e) => {
        if (e.path === rel) {
          clearTimeout(timer);
          resolve(e);
        }
      });
      // give chokidar a moment to arm the watch, then edit the file
      setTimeout(() => {
        const original = readFileSync(abs, 'utf8');
        writeFileSync(abs, `${original}\n\nEdited by another editor.\n`, 'utf8');
      }, 400);
    });

    expect(event.reason).toBe('change');
    expect(event.node?.meta?.id).toBe('r-000002');
    expect(Object.keys(event.index.nodes)).toHaveLength(27);
  }, 12000);
});
