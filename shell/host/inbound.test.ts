import { expect, it } from 'vitest';
import { applyInput, newPad, type Pad } from '../pad';
import { encodeStick } from '../protocol';
import { handleRoomMessage } from './inbound';
import { Session } from './session';

it('a reconnecting player (join back, no leave seen) starts from a neutral pad', () => {
  const s = new Session([{ id: 'dots', name: 'Dots', minPlayers: 2 }]);
  const pads: (Pad | undefined)[] = [];
  handleRoomMessage({ t: 'join', slot: 0, name: 'A', back: false }, s, pads, 0);
  applyInput(pads[0]!, encodeStick(0, 0, 3)); // holding full right
  handleRoomMessage({ t: 'join', slot: 0, name: 'A', back: true }, s, pads, 1); // old socket replaced silently
  expect(pads[0]).toEqual(newPad());
});

it('leave neutralises the pad; gone removes it', () => {
  const s = new Session([{ id: 'dots', name: 'Dots', minPlayers: 2 }]);
  const pads: (Pad | undefined)[] = [];
  handleRoomMessage({ t: 'join', slot: 2, name: 'C', back: false }, s, pads, 0);
  applyInput(pads[2]!, encodeStick(0, 4, 3));
  handleRoomMessage({ t: 'leave', slot: 2 }, s, pads, 1);
  expect(pads[2]).toEqual(newPad());
  handleRoomMessage({ t: 'gone', slot: 2 }, s, pads, 2);
  expect(pads[2]).toBeUndefined();
});

it('routes ready and vote to the session', () => {
  const s = new Session([{ id: 'dots', name: 'Dots', minPlayers: 2 }]);
  const pads: (Pad | undefined)[] = [];
  handleRoomMessage({ t: 'join', slot: 0, name: 'A', back: false }, s, pads, 0);
  handleRoomMessage({ t: 'join', slot: 1, name: 'B', back: false }, s, pads, 0);
  handleRoomMessage({ t: 'ready', slot: 0, v: true }, s, pads, 1);
  handleRoomMessage({ t: 'ready', slot: 1, v: true }, s, pads, 1);
  expect(s.phase).toBe('vote');
  const outs = handleRoomMessage({ t: 'vote', slot: 0, game: 'dots' }, s, pads, 2);
  expect(outs[0]).toMatchObject({ to: 0, screen: 'vote', data: { mine: 'dots' } });
});
