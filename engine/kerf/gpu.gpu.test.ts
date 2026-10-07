import { expect, it } from 'vitest';
import { getDevice } from './gpu';

it('gets a WebGPU device in the test browser', async () => {
  const device = await getDevice();
  expect(device).toBeTruthy();
  device.destroy();
});
