import { describe, it, expect } from 'vitest';
import { parseGrammar, GrammarError } from '../src/grammar.js';

describe('credential-file grammar', () => {
  it('ignores blank lines and comments, trims around the first =', () => {
    const m = parseGrammar('\n# a comment\n   VBCDX_AGENTS_USER =  bot  \n');
    expect(m.get('VBCDX_AGENTS_USER')).toBe('bot');
  });

  it('keeps a literal dollar, hash and equals in an unquoted value', () => {
    const m = parseGrammar('VBCDX_AGENTS_TOKEN=a$b#c=d');
    expect(m.get('VBCDX_AGENTS_TOKEN')).toBe('a$b#c=d');
  });

  it('treats single quotes as literal', () => {
    const m = parseGrammar("VBCDX_AGENTS_TOKEN='a b $c'");
    expect(m.get('VBCDX_AGENTS_TOKEN')).toBe('a b $c');
  });

  it('applies JSON escaping inside double quotes', () => {
    const m = parseGrammar('VBCDX_AGENTS_TOKEN="a\\tb"');
    expect(m.get('VBCDX_AGENTS_TOKEN')).toBe('a\tb');
  });

  it('rejects duplicate keys case-insensitively', () => {
    expect(() => parseGrammar('A=1\na=2')).toThrow(GrammarError);
  });

  it('rejects trailing data after a quoted value', () => {
    expect(() => parseGrammar('K="v" junk')).toThrow(GrammarError);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseGrammar("K='oops")).toThrow(GrammarError);
    expect(() => parseGrammar('K="oops')).toThrow(GrammarError);
  });

  it('rejects a decoded line break inside a double-quoted value', () => {
    expect(() => parseGrammar('K="a\\nb"')).toThrow(GrammarError);
  });

  it('rejects a NUL byte anywhere', () => {
    expect(() => parseGrammar('K=a\u0000b')).toThrow(GrammarError);
  });

  it('never puts the value in the error message', () => {
    try {
      parseGrammar('K="unterminated-secret');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GrammarError);
      expect(e.message).not.toContain('unterminated-secret');
    }
  });
});
