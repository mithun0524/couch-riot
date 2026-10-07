import { expect, it } from 'vitest';
import { getDevice } from './gpu';

it('rejects with a clear message when WebGPU is missing', async () => {
  await expect(getDevice()).rejects.toThrow('Kerf needs WebGPU');
});
