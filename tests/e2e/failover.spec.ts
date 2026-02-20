import { expect, test } from '@playwright/test';

function url(name: string) {
	return `/test-app.html?name=${name}`;
}

test.describe('failover', () => {
	test('leader tab closes, follower reconnects', async ({ context }) => {
		const page1 = await context.newPage();
		await page1.goto(url('fail-reconnect'));
		await expect(page1.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		const page2 = await context.newPage();
		await page2.goto(url('fail-reconnect'));
		await expect(page2.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		await page1.close();

		// Follower becomes leader, creates new WebSocket, fires onopen again
		await expect
			.poll(() => page2.evaluate(() => (window as any).__openCount), {
				timeout: 10000,
			})
			.toBeGreaterThanOrEqual(2);

		const rs = await page2.evaluate(() => (window as any).__ws.readyState);
		expect(rs).toBe(1);
	});

	test('new leader can send and receive after failover', async ({
		context,
	}) => {
		const page1 = await context.newPage();
		await page1.goto(url('fail-send'));
		await expect(page1.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		const page2 = await context.newPage();
		await page2.goto(url('fail-send'));
		await expect(page2.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		await page1.close();

		await expect
			.poll(() => page2.evaluate(() => (window as any).__openCount), {
				timeout: 10000,
			})
			.toBeGreaterThanOrEqual(2);

		await page2.evaluate(() => (window as any).__ws.send('after-failover'));

		await expect
			.poll(() => page2.evaluate(() => (window as any).__messages), {
				timeout: 5000,
			})
			.toContain('after-failover');
	});

	test('3 tabs: leader dies, new leader sends, third tab receives', async ({
		context,
	}) => {
		const page1 = await context.newPage();
		await page1.goto(url('fail-three'));
		await expect(page1.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		const page2 = await context.newPage();
		await page2.goto(url('fail-three'));
		await expect(page2.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		const page3 = await context.newPage();
		await page3.goto(url('fail-three'));
		await expect(page3.locator('#status')).toHaveText('open', {
			timeout: 5000,
		});

		await page1.close();

		// Wait for failover to complete on remaining tabs
		await expect
			.poll(() => page2.evaluate(() => (window as any).__openCount), {
				timeout: 10000,
			})
			.toBeGreaterThanOrEqual(2);

		await expect
			.poll(() => page3.evaluate(() => (window as any).__openCount), {
				timeout: 10000,
			})
			.toBeGreaterThanOrEqual(2);

		await page2.evaluate(() => (window as any).__ws.send('three-tab-msg'));

		await expect
			.poll(() => page3.evaluate(() => (window as any).__messages), {
				timeout: 5000,
			})
			.toContain('three-tab-msg');
	});
});
