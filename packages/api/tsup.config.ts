import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/testing.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'lib',
  target: 'es2020',
  tsconfig: './tsconfig.json',
})
