/**
 * Integrity regression suite. Runs against a LIVE API (default http://localhost:3000/api)
 * backed by the dev Neon DB in .env. Each run creates its own fixtures with a unique
 * run id, so the suite is safe to re-run without cleanup.
 *   npm run test:integrity
 */
module.exports = {
  rootDir: 'test',
  testMatch: ['**/*.e2e-spec.ts'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testEnvironment: 'node',
  testTimeout: 60000,
  verbose: true,
};
