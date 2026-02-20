import { expect, test } from '@playwright/test';

function url(name: string) {
	return `/test-app.html?name=${name}`;
}

test.describe('connection', () => {
	test('single tab connects and gets open status', async ({ page }) => {
		await page.goto(url('conn-single'));
		await expect(page.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});
	});

	test('two tabs both show open', async ({ context }) => {
		const page1 = await context.newPage();
		await page1.goto(url('conn-two'));
		await expect(page1.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		const page2 = await context.newPage();
		await page2.goto(url('conn-two'));
		await expect(page2.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});
	});

	test('readyState is OPEN on both tabs', async ({ context }) => {
		const page1 = await context.newPage();
		await page1.goto(url('conn-ready'));
		await expect(page1.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		const page2 = await context.newPage();
		await page2.goto(url('conn-ready'));
		await expect(page2.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		const rs1 = await page1.evaluate(() => (window as any).__ws.readyState);
		const rs2 = await page2.evaluate(() => (window as any).__ws.readyState);

		expect(rs1).toBe(1);
		expect(rs2).toBe(1);
	});
});
