import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities } from './titles.js';

describe('decodeHtmlEntities', () => {
  it('decodes the named entities a model escapes into a title', () => {
    expect(decodeHtmlEntities('Node schema &amp; identity')).toBe('Node schema & identity');
    expect(decodeHtmlEntities('&lt;script&gt; &quot;quoted&quot; &apos;tag&apos;')).toBe(
      '<script> "quoted" \'tag\'',
    );
  });

  it('decodes numeric and hex references', () => {
    expect(decodeHtmlEntities('caf&#233;')).toBe('café');
    expect(decodeHtmlEntities('caf&#xe9;')).toBe('café');
  });

  it('leaves plain text and unknown entities untouched', () => {
    expect(decodeHtmlEntities('Structural hashing')).toBe('Structural hashing');
    expect(decodeHtmlEntities('A &notreal; entity')).toBe('A &notreal; entity');
  });
});
