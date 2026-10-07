import { networkInterfaces } from 'node:os';
import { defineConfig } from 'vite';

// The QR code must point at an address phones on the same Wi-Fi can reach.
function lanIp(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}

export default defineConfig({
  server: { host: true, port: 5173, strictPort: true },
  define: { __LAN_HOST__: JSON.stringify(lanIp()) },
  build: { rollupOptions: { input: { tv: 'index.html', play: 'play.html', bench: 'bench/index.html' } } },
});
