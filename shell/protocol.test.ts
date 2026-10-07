import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET, PALETTE_HEX, decodeInput, encodeButton, encodeStick, isRoomCode, newRoomCode,
  parseHostOut, parsePhoneMsg, type Stick,
} from './protocol';

describe('input bytes', () => {
  it('stick bytes round-trip for every dir, mag and stick', () => {
    for (const stick of [0, 1] as Stick[])
      for (let dir = 0; dir < 16; dir++)
        for (let mag = 0; mag < 4; mag++) {
          const b = encodeStick(stick, dir, mag);
          expect(b).toBeLessThan(0x80);
          expect(decodeInput(b)).toEqual({ kind: 'stick', stick, dir, mag });
        }
  });

  it('button bytes round-trip for ids 0-63 down and up', () => {
    for (let id = 0; id < 64; id++)
      for (const down of [true, false]) {
        const b = encodeButton(id, down);
        expect(b).toBeGreaterThanOrEqual(0x80);
        expect(decodeInput(b)).toEqual({ kind: 'button', id, down });
      }
  });
});

describe('room codes', () => {
  it('are 4 letters without I or O', () => {
    expect(CODE_ALPHABET).not.toMatch(/[IO]/);
    let i = 0;
    const code = newRoomCode(() => (i++ % 24) / 24);
    expect(code).toBe('ABCD');
    expect(isRoomCode(code)).toBe(true);
    expect(isRoomCode('ABCI')).toBe(false);
    expect(isRoomCode('abcd')).toBe(false);
    expect(isRoomCode('ABCDE')).toBe(false);
  });
});

describe('parsePhoneMsg', () => {
  it('accepts ready and vote', () => {
    expect(parsePhoneMsg('{"t":"ready","v":true}')).toEqual({ t: 'ready', v: true });
    expect(parsePhoneMsg('{"t":"vote","game":"dots"}')).toEqual({ t: 'vote', game: 'dots' });
  });

  it('strips extra fields', () => {
    expect(parsePhoneMsg('{"t":"ready","v":false,"slot":7}')).toEqual({ t: 'ready', v: false });
  });

  it('rejects junk', () => {
    for (const s of ['', 'nope', '[]', 'null', '{"t":"ready"}', '{"t":"ready","v":"yes"}',
      '{"t":"vote","game":""}', `{"t":"vote","game":"${'x'.repeat(33)}"}`, '{"t":"join"}'])
      expect(parsePhoneMsg(s)).toBeNull();
  });
});

describe('parseHostOut', () => {
  it('splits target from message', () => {
    expect(parseHostOut('{"to":3,"t":"buzz","ms":40}')).toEqual({ to: 3, msg: { t: 'buzz', ms: 40 } });
    expect(parseHostOut('{"to":"all","t":"screen","screen":"wait","data":{"reason":"next-round"}}'))
      .toEqual({ to: 'all', msg: { t: 'screen', screen: 'wait', data: { reason: 'next-round' } } });
  });

  it('rejects bad targets and unknown types', () => {
    for (const s of ['{"to":8,"t":"buzz","ms":1}', '{"to":-1,"t":"buzz","ms":1}', '{"to":1.5,"t":"buzz","ms":1}',
      '{"t":"buzz","ms":1}', '{"to":0,"t":"welcome"}', 'x'])
      expect(parseHostOut(s)).toBeNull();
  });
});

it('palette has 8 colors', () => {
  expect(PALETTE_HEX).toHaveLength(8);
  for (const c of PALETTE_HEX) expect(c).toMatch(/^#[0-9a-f]{6}$/);
});
