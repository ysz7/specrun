import { describe, expect, it } from 'vitest';
import { classifyAgentError } from './agentError';

describe('classifyAgentError', () => {
  it('detects auth failures', () => {
    for (const m of [
      'Error 401 Unauthorized',
      'OAuth token has expired',
      'Invalid API key provided',
      'Authentication failed — please sign in',
    ])
      expect(classifyAgentError(m)).toBe('auth');
  });

  it('detects rate limits (before auth, since 429s can mention tokens)', () => {
    for (const m of [
      'Error 429: too many requests',
      'You have hit your rate limit',
      'Overloaded, please retry',
      'Daily usage limit reached',
    ])
      expect(classifyAgentError(m)).toBe('rate-limit');
  });

  it('detects a lost connection', () => {
    for (const m of [
      'fetch failed',
      'connect ECONNREFUSED 127.0.0.1:443',
      'getaddrinfo ENOTFOUND api.anthropic.com',
      'Network error: you appear to be offline',
      'socket hang up',
    ])
      expect(classifyAgentError(m)).toBe('connection');
  });

  it('detects a model the account cannot use, before the generic auth pattern', () => {
    for (const m of [
      'This organization does not have access to the model claude-opus-5',
      'Model not found: claude-made-up-5',
      'Permission denied for model claude-opus-5',
    ])
      expect(classifyAgentError(m)).toBe('no-access');
  });

  it('leaves ordinary errors as other', () => {
    expect(classifyAgentError('ENOENT: no such file')).toBe('other');
    expect(classifyAgentError('the tool returned malformed JSON')).toBe('other');
  });
});
