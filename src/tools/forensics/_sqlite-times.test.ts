import { describe, expect, it } from 'vitest';
import { prtimeToIso, unixMicrosToIso, webkitToIso } from './_sqlite-times';

// Reference values worked out independently with Python's datetime:
//   datetime(1601, 1, 1) + timedelta(microseconds=13354882013123456) = 2024-03-14 09:26:53.123456
//   datetime(1970, 1, 1) + timedelta(microseconds=1700000000123456)  = 2023-11-14 22:13:20.123456
// and the well-known Unix time 1700000000 = 2023-11-14 22:13:20 UTC.
describe('Chrome / WebKit time', () => {
  it('11644473600000000 is the Unix epoch', () => {
    expect(webkitToIso('11644473600000000')).toBe('1970-01-01T00:00:00.000Z');
  });
  it('converts a real-looking history value, keeping the milliseconds', () => {
    expect(webkitToIso('13354882013123456')).toBe('2024-03-14T09:26:53.123Z');
  });
  it('does not lose the microseconds a double cannot hold (text in, BigInt inside)', () => {
    // 13354882013123457 is not representable as a double; the text form still converts exactly.
    expect(webkitToIso('13354882013123457')).toBe('2024-03-14T09:26:53.123Z');
    expect(webkitToIso(13354882013000000)).toBe('2024-03-14T09:26:53.000Z');
  });
  it('0, null and garbage are "no time"', () => {
    expect(webkitToIso('0')).toBeNull();
    expect(webkitToIso(null)).toBeNull();
    expect(webkitToIso('abc')).toBeNull();
    expect(webkitToIso('1e9')).toBeNull();
  });
  it('dates before 1970 work', () => {
    expect(webkitToIso('11644473599000000')).toBe('1969-12-31T23:59:59.000Z');
  });
  it('a value out of range is null, not an exception', () => {
    expect(webkitToIso('99999999999999999999')).toBeNull();
  });
});

describe('Firefox PRTime', () => {
  it('1700000000000000 is 2023-11-14 22:13:20 UTC', () => {
    expect(prtimeToIso('1700000000000000')).toBe('2023-11-14T22:13:20.000Z');
  });
  it('keeps the milliseconds', () => {
    expect(prtimeToIso('1700000000123456')).toBe('2023-11-14T22:13:20.123Z');
  });
  it('0 and garbage are "no time"', () => {
    expect(prtimeToIso('0')).toBeNull();
    expect(prtimeToIso('x')).toBeNull();
  });
});

describe('unixMicrosToIso', () => {
  it('floors negative values like a calendar does', () => {
    expect(unixMicrosToIso(-1n)).toBe('1969-12-31T23:59:59.999Z');
    expect(unixMicrosToIso(-1000n)).toBe('1969-12-31T23:59:59.999Z');
    expect(unixMicrosToIso(-1001n)).toBe('1969-12-31T23:59:59.998Z');
  });
});
