import { describe, expect, it } from 'vitest';
import { dms } from './map';

describe('dms', () => {
  it('formats the Eiffel Tower test point', () => {
    expect(dms(48.8584, 'N', 'S')).toBe('48° 51′ 30.24″ N');
    expect(dms(2.2945, 'E', 'W')).toBe('2° 17′ 40.20″ E');
  });
  it('never prints 60 seconds', () => {
    expect(dms(10.999999, 'N', 'S')).toBe('11° 0′ 0.00″ N');
    expect(dms(-33.5, 'N', 'S')).toBe('33° 30′ 0.00″ S');
  });
});
