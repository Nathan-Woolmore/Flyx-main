import {defineConfig} from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['tests/remote/*.fixture.ts'],testTimeout:600000,fileParallelism:false}});
