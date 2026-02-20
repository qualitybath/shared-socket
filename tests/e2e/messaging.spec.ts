import { expect, test } from '@playwright/test';

function url(name: string) {
	return `/test-app.html?name=${name}`;
}

test.describe('messaging', () => {
	test('leader sends and receives echo', async ({ page }) => {
		await page.goto(url('msg-leader-echo'));
		await expect(page.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		await page.evaluate(() => (window as any).__ws.send('hello'));

		await expect
			.poll(() => page.evaluate(() => (window as any).__messages), {
				timeout: 5000,
			})
			.toContain('hello');
	});

	test('follower sends, both tabs receive echo', async ({ context }) => {
		const page1 = await context.newPage();
		await page1.goto(url('msg-follower-echo'));
		await expect(page1.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		const page2 = await context.newPage();
		await page2.goto(url('msg-follower-echo'));
		await expect(page2.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		await page2.evaluate(() => (window as any).__ws.send('from-follower'));

		await expect
			.poll(() => page1.evaluate(() => (window as any).__messages), {
				timeout: 5000,
			})
			.toContain('from-follower');

		await expect
			.poll(() => page2.evaluate(() => (window as any).__messages), {
				timeout: 5000,
			})
			.toContain('from-follower');
	});

	test('leader sends, follower receives via relay', async ({ context }) => {
		const page1 = await context.newPage();
		await page1.goto(url('msg-relay'));
		await expect(page1.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		const page2 = await context.newPage();
		await page2.goto(url('msg-relay'));
		await expect(page2.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		await page1.evaluate(() => (window as any).__ws.send('from-leader'));

		await expect
			.poll(() => page2.evaluate(() => (window as any).__messages), {
				timeout: 5000,
			})
			.toContain('from-leader');
	});
});
