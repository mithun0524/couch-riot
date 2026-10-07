import type { HostOut, RoomToHost } from '../protocol';
import { newPad, type Pad } from '../pad';
import type { Session } from './session';

// Room → host JSON events: keep pads in step with membership, then let the session decide.
export function handleRoomMessage(m: RoomToHost, session: Session, pads: (Pad | undefined)[], now: number): HostOut[] {
  switch (m.t) {
    case 'join':
      pads[m.slot] = newPad(); // also on `back`: a silently replaced socket never sent `leave`
      return session.join(m.slot, m.name, m.back, now);
    case 'leave':
      pads[m.slot] = newPad(); // dropped player stands still
      return session.leave(m.slot, now);
    case 'gone':
      pads[m.slot] = undefined;
      return session.gone(m.slot, now);
    case 'ready':
      return session.ready(m.slot, m.v, now);
    case 'vote':
      return session.vote(m.slot, m.game, now);
  }
}
