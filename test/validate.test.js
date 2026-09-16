import { describe, it, expect } from 'vitest';
import { validate } from '../src/validate.js';

describe('schema validator', () => {
  it('enforces required and additionalProperties:false', () => {
    const schema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } };
    expect(validate(schema, { a: 'x' }).valid).toBe(true);
    expect(validate(schema, {}).valid).toBe(false);
    expect(validate(schema, { a: 'x', b: 1 }).valid).toBe(false);
  });

  it('checks integer ranges and string patterns and enums', () => {
    expect(validate({ type: 'integer', minimum: 1, maximum: 50 }, 0).valid).toBe(false);
    expect(validate({ type: 'integer', minimum: 1, maximum: 50 }, 25).valid).toBe(true);
    expect(validate({ type: 'string', pattern: '^[0-9a-f]{64}$' }, 'zz').valid).toBe(false);
    expect(validate({ enum: ['a', 'b'] }, 'c').valid).toBe(false);
  });

  it('validates array items and additionalProperties-as-schema maps', () => {
    expect(validate({ type: 'array', items: { type: 'integer' } }, [1, 2]).valid).toBe(true);
    expect(validate({ type: 'array', items: { type: 'integer' } }, [1, 'x']).valid).toBe(false);
    const map = { type: 'object', additionalProperties: { type: 'string' } };
    expect(validate(map, { k: 'v' }).valid).toBe(true);
    expect(validate(map, { k: 3 }).valid).toBe(false);
  });

  it('accepts integers where number is required, and null unions', () => {
    expect(validate({ type: 'number' }, 5).valid).toBe(true);
    expect(validate({ type: ['integer', 'null'] }, null).valid).toBe(true);
    expect(validate({ type: ['integer', 'null'] }, 3).valid).toBe(true);
    expect(validate({ type: ['integer', 'null'] }, 'x').valid).toBe(false);
  });
});
