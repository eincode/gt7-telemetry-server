import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // ws has optional native deps that don't exist in a packaged exe;
  // serialport is native too and is loaded lazily (server runs without it)
  external: ['bufferutil', 'utf-8-validate', 'serialport'],
};

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/server.ts'],
    outfile: 'dist-bundled/server.cjs',
  }),
  build({
    ...common,
    entryPoints: ['src/recorder/cli.ts'],
    outfile: 'dist-bundled/cli.cjs',
  }),
]);

console.log('Bundling complete → dist-bundled/');
