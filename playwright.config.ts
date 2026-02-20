import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'tests/e2e',
	testMatch: '*.spec.ts',
	use: {
		baseURL: 'http://localhost:4173',
	},
	webServer: [
		{
			command: 'npx serve tests/e2e/fixtures --listen 4173',
			port: 4173,
			reuseExistingServer: !process.env.CI,
		},
		{
			command: 'bun tests/e2e/ws-server.ts',
			url: 'http://localhost:4174',
			reuseExistingServer: !process.env.CI,
		},
	],
});
