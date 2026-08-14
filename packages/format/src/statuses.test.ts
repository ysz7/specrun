import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  worseStatus,
} from './statuses.js';

describe('status machine (format-spec §1.2)', () => {
  it('permits the legal plan-branch transitions', () => {
    expect(canTransition('planned', 'in-progress', 'executor')).toBe(true);
    expect(canTransition('in-progress', 'done', 'executor')).toBe(true);
    expect(canTransition('in-progress', 'blocked', 'executor')).toBe(true);
    expect(canTransition('blocked', 'in-progress', 'executor')).toBe(true);
    expect(canTransition('done', 'ok', 'sync')).toBe(true);
  });

  it('permits the legal code-branch transitions', () => {
    expect(canTransition('ok', 'stale', 'system')).toBe(true);
    expect(canTransition('drift', 'stale', 'system')).toBe(true);
    expect(canTransition('stale', 'ok', 'sync')).toBe(true);
    expect(canTransition('stale', 'drift', 'sync')).toBe(true);
    expect(canTransition('drift', 'ok', 'scanner')).toBe(true);
  });

  it('rejects illegal writer/edge combinations', () => {
    // system may only ever set stale
    expect(canTransition('stale', 'ok', 'system')).toBe(false);
    expect(canTransition('stale', 'drift', 'system')).toBe(false);
    // only sync closes the plan branch
    expect(canTransition('done', 'ok', 'executor')).toBe(false);
    // scanner cannot mark stale
    expect(canTransition('ok', 'stale', 'scanner')).toBe(false);
    // no jumping the plan branch
    expect(canTransition('planned', 'done', 'executor')).toBe(false);
  });

  it('treats identity as a no-op', () => {
    expect(canTransition('ok', 'ok', 'system')).toBe(true);
  });

  it('assertTransition throws on an illegal edge', () => {
    expect(() => assertTransition('ok', 'drift', 'system')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('planned', 'in-progress', 'executor')).not.toThrow();
  });

  it('worseStatus follows the roll-up priority (§1.3)', () => {
    expect(worseStatus('ok', 'drift')).toBe('drift');
    expect(worseStatus('stale', 'blocked')).toBe('blocked');
    expect(worseStatus('planned', 'in-progress')).toBe('in-progress');
    expect(worseStatus('done', 'ok')).toBe('done');
  });
});
