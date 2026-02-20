import { expect, test } from '@playwright/test';

function url(name: string) {
	return `/test-app.html?name=${name}`;
}

test.describe('late joiner', () => {
	test('late joiner gets onopen', async ({ context }) => {
		const page1 = await context.newPage();
		await page1.goto(url('late-open'));
		await expect(page1.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		const page2 = await context.newPage();
		await page2.goto(url('late-open'));
		await expect(page2.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});
	});

	test('late joiner receives messages sent after it joins', async ({
		context,
	}) => {
		const page1 = await context.newPage();
		await page1.goto(url('late-msg'));
		await expect(page1.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		const page2 = await context.newPage();
		await page2.goto(url('late-msg'));
		await expect(page2.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		await page1.evaluate(() => (window as any).__ws.send('after-join'));

		await expect
			.poll(() => page2.evaluate(() => (window as any).__messages), {
				timeout: 5000,
			})
			.toContain('after-join');
	});
});
