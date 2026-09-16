import { describe, it, expect } from 'vitest';
import { assertGate } from '../src/gate.js';
import { ToolError } from '../src/errors.js';

const cfg = (writes, writesInvalid = null) => ({ writes, writesInvalid });

describe('write gate', () => {
  it('always allows reads', () => {
    expect(() => assertGate('read', cfg('off'))).not.toThrow();
  });

  it('refuses writes when off', () => {
    expect(() => assertGate('write', cfg('off'))).toThrow(ToolError);
  });

  it('allows writes in write and full', () => {
    expect(() => assertGate('write', cfg('write'))).not.toThrow();
    expect(() => assertGate('write', cfg('full'))).not.toThrow();
  });

  it('allows destructive only in full', () => {
    expect(() => assertGate('destructive', cfg('write'))).toThrow(ToolError);
    expect(() => assertGate('destructive', cfg('full'))).not.toThrow();
  });

  it('reports an invalid write mode value on a refusal', () => {
    try {
      assertGate('write', cfg('off', 'yes'));
      throw new Error('should throw');
    } catch (e) {
      expect(e.reason).toBe('write_gate_disabled');
      expect(e.message).toContain('yes');
    }
  });
});
