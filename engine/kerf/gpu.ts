export async function getDevice(): Promise<GPUDevice> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('Kerf needs WebGPU. Use a recent Chrome or Edge on desktop.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Kerf needs WebGPU, but no GPU adapter is available.');
  return adapter.requestDevice();
}
