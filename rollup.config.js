import typescript from 'rollup-plugin-typescript2';

export default {
  input: 'src/index.ts',
  output: {
    format: 'commonjs',
    exports: 'default',
    file: 'dist/index.js'
  },
  plugins: [
    typescript()
  ],
  external: [
    'postgres',
    'path'
  ]
};
