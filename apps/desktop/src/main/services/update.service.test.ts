import { describe, expect, it } from 'vitest';
import { UpdateService, compareVersions } from './update.service';

const jsonResponse = (body: unknown, ok = true): Response =>
  ({ ok, json: () => Promise.resolve(body) }) as unknown as Response;

describe('compareVersions', () => {
  it('orders dotted numeric versions', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1', '0.1.0')).toBe(0); // missing patch treated as 0
  });
});

describe('UpdateService', () => {
  it('reports an available update when the feed is newer', async () => {
    const svc = new UpdateService('0.1.0', 'https://x/feed.json', () =>
      Promise.resolve(jsonResponse({ version: '0.2.0', url: 'https://x/dl' })),
    );
    const info = await svc.check();
    expect(info).toEqual({
      current: '0.1.0',
      latest: '0.2.0',
      available: true,
      url: 'https://x/dl',
    });
  });

  it('reports up to date when the feed matches or is older', async () => {
    const svc = new UpdateService('0.2.0', 'https://x/feed.json', () =>
      Promise.resolve(jsonResponse({ version: '0.1.0' })),
    );
    const info = await svc.check();
    expect(info.available).toBe(false);
    expect(info.latest).toBe('0.2.0'); // never regress below current
  });

  it('never throws on a network failure — reports up to date', async () => {
    const svc = new UpdateService('0.1.0', 'https://x/feed.json', () =>
      Promise.reject(new Error('offline')),
    );
    const info = await svc.check();
    expect(info).toEqual({ current: '0.1.0', latest: '0.1.0', available: false });
  });

  it('tolerates a malformed manifest', async () => {
    const svc = new UpdateService('0.1.0', 'https://x/feed.json', () =>
      Promise.resolve(jsonResponse({ nope: true })),
    );
    expect((await svc.check()).available).toBe(false);
  });
});
