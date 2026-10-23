import { describe, expect, test } from 'bun:test';
import { canonicalJson, sha256Hex } from '../../../src/domain/shared/canonical-json';

describe('canonicalJson', () => {
  test('sorts keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
    );
  });

  test('omits undefined properties', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  test('escapes strings like JSON.stringify', () => {
    expect(canonicalJson({ s: 'a"b\n' })).toBe('{"s":"a\\"b\\n"}');
  });
});

describe('sha256Hex', () => {
  test('is stable regardless of key order', () => {
    const first = sha256Hex(canonicalJson({ kind: 'BET', money: { amount: '1.00', currency: 'BRL' } }));
    const second = sha256Hex(canonicalJson({ money: { currency: 'BRL', amount: '1.00' }, kind: 'BET' }));
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test('changes when a business field changes', () => {
    expect(sha256Hex(canonicalJson({ gameId: 'a' }))).not.toBe(sha256Hex(canonicalJson({ gameId: 'b' })));
  });
});
