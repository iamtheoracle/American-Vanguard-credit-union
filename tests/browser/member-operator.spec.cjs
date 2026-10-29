const { test, expect } = require('@playwright/test');

async function openOperations(page) {
  await page.goto('/');
  await page.locator('[data-nav="operations"]:visible').first().click();
  await expect(page.locator('#view-operations')).toBeVisible();
}

async function fillBaseRequest(page, { type = 'internal-transfer', recipient, destination } = {}) {
  await page.locator('#workflow-type').selectOption(type);
  await page.locator('#workflow-from').selectOption('draft');
  if (type === 'internal-transfer') await page.locator('#workflow-to').selectOption('primary');
  if (recipient) await page.locator('#workflow-recipient').fill(recipient);
  if (destination) await page.locator('#workflow-destination').fill(destination);
  await page.locator('#workflow-amount').fill('12.50');
  await page.locator('#workflow-note').fill('Browser audit request');
}

test('member navigation works and mobile layout has no horizontal page overflow', async ({ page }) => {
  await page.goto('/');
  for (const [view, title] of [
    ['move', 'Payment requests'],
    ['deposit', 'Deposit a check'],
    ['card', 'Your debit card'],
    ['operations', 'Payments & approvals'],
    ['more', 'More from AVCU'],
    ['home', 'Welcome to AVCU']
  ]) {
    await page.locator(`[data-nav="${view}"]:visible`).first().click();
    await expect(page.locator('#page-title')).toContainText(title);
  }
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth
  }));
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport + 1);
});

test('preview access gate or unauthenticated sign-in boundary is enforced', async ({ page }) => {
  await page.goto('/');
  if (process.env.BASE_URL) await page.waitForURL(/\/edge-access/, { timeout: 5000 }).catch(() => {});
  if (process.env.BASE_URL && page.url().includes('/edge-access')) {
    expect(page.url()).toContain('/edge-access');
    console.log('Netlify Edge Access protects this preview; app-level deployed testing requires an authorized preview session.');
    return;
  }
  await expect(page.locator('#auth-status-text')).toContainText('Local mode');
  await expect(page.locator('#auth-button')).toHaveText('Sign in');
  await page.locator('#auth-button').click();
  await expect(page.locator('#auth-dialog')).toBeVisible();
  await expect(page.locator('#auth-title')).toHaveText('Sign in to AVCU');
  await expect(page.locator('#auth-form')).toContainText('institution-issued account');
  if (process.env.BASE_URL) {
    const api = await page.evaluate(async () => {
      const response = await fetch('/api/workflow', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    });
    expect([401, 503]).toContain(api.status);
    expect(api.status).not.toBe(404);
  }
});

test('member request enters approval queue and operator can request more information', async ({ page }) => {
  await openOperations(page);
  await fillBaseRequest(page);
  await page.locator('#workflow-form button[type="submit"]').click();
  const memberRequest = page.locator('#workflow-member-queue .workflow-request').first();
  await expect(memberRequest).toContainText('Internal account transfer');
  await expect(memberRequest.locator('.workflow-status')).toHaveText('Pending Approval');
  const operatorRequest = page.locator('#workflow-operator-queue .workflow-request').first();
  await operatorRequest.locator('input[data-note]').fill('Please confirm source details');
  await operatorRequest.locator('[data-review="needs-information"]').click();
  await expect(page.locator('#workflow-member-queue .workflow-request').first().locator('.workflow-status')).toHaveText('Needs Information');
  await expect(page.locator('#workflow-pending-count')).toHaveText('1 pending');
  const followUp = page.locator('#workflow-operator-queue .workflow-request').first();
  await followUp.locator('input[data-note]').fill('Reviewed details and rejected');
  await followUp.locator('[data-review="reject"]').click();
  await expect(page.locator('#workflow-member-queue .workflow-request').first().locator('.workflow-status')).toHaveText('Rejected');
  await expect(page.locator('#workflow-pending-count')).toHaveText('0 pending');
});

test('internal transfer approval cannot create money from zero balances', async ({ page }) => {
  await openOperations(page);
  await fillBaseRequest(page);
  await page.locator('#workflow-form button[type="submit"]').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#workflow-operator-queue .workflow-request').first().locator('[data-review="approve"]').click();
  await expect(page.locator('#workflow-operator-queue .workflow-request').first().locator('.workflow-status')).toHaveText('Pending Approval');
  const balances = await page.evaluate(() => JSON.parse(localStorage.getItem('avcu.member.v1') || 'null'));
  expect(balances).toBeNull();
  await expect(page.locator('#view-home [data-balance="draft"]')).toHaveText('Not connected');
});

test('external wire approval stays awaiting provider and is not reported as settled', async ({ page }) => {
  await openOperations(page);
  await fillBaseRequest(page, { type: 'wire-transfer', recipient: 'Test recipient', destination: 'Receiving institution reference' });
  await page.locator('#workflow-form button[type="submit"]').click();
  const operatorRequest = page.locator('#workflow-operator-queue .workflow-request').first();
  await operatorRequest.locator('[data-review="approve"]').click();
  const memberRequest = page.locator('#workflow-member-queue .workflow-request').first();
  await expect(memberRequest.locator('.workflow-status')).toHaveText('Approved · Awaiting Provider');
  await expect(memberRequest).not.toContainText('Settled · Provider Confirmed');
  await expect(memberRequest).toContainText('no external funds have been sent or settled');
});

test('Zelle name is not treated as verified when provider is absent', async ({ page }) => {
  await openOperations(page);
  await fillBaseRequest(page, { type: 'zelle', recipient: 'Unverified recipient' });
  await page.locator('#zelle-lookup').click();
  await expect(page.locator('#zelle-lookup-result')).toContainText('not verified');
  await page.locator('#workflow-form button[type="submit"]').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#workflow-operator-queue .workflow-request').first().locator('[data-review="approve"]').click();
  await expect(page.locator('#workflow-member-queue .workflow-request').first().locator('.workflow-status')).toHaveText('Pending Approval');
});

test('operator rejection is recorded with a review note', async ({ page }) => {
  await openOperations(page);
  await fillBaseRequest(page, { type: 'wire-transfer', recipient: 'Test recipient', destination: 'Receiving institution reference' });
  await page.locator('#workflow-form button[type="submit"]').click();
  const operatorRequest = page.locator('#workflow-operator-queue .workflow-request').first();
  await operatorRequest.locator('input[data-note]').fill('Rejected pending identity review');
  await operatorRequest.locator('[data-review="reject"]').click();
  const memberRequest = page.locator('#workflow-member-queue .workflow-request').first();
  await expect(memberRequest.locator('.workflow-status')).toHaveText('Rejected');
  await expect(memberRequest).toContainText('Rejected pending identity review');
  await expect(page.locator('#workflow-pending-count')).toHaveText('0 pending');
});

test('bill payment approval waits for provider and never claims settlement', async ({ page }) => {
  await openOperations(page);
  await fillBaseRequest(page, { type: 'bill-payment', recipient: 'Utility provider' });
  await page.locator('#workflow-form button[type="submit"]').click();
  const operatorRequest = page.locator('#workflow-operator-queue .workflow-request').first();
  await operatorRequest.locator('[data-review="approve"]').click();
  const memberRequest = page.locator('#workflow-member-queue .workflow-request').first();
  await expect(memberRequest.locator('.workflow-status')).toHaveText('Approved · Awaiting Provider');
  await expect(memberRequest).toContainText('no external funds have been sent or settled');
});

test('card freeze is clearly local-only and persists locally', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-nav="card"]:visible').first().click();
  await page.locator('#freeze-toggle').click();
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.locator('#dialog-confirm').click();
  await expect(page.locator('#card-state-heading')).toHaveText('Card frozen locally');
  await expect(page.locator('#ledger-card-status')).toHaveText('Frozen locally');
  const frozen = await page.evaluate(() => JSON.parse(localStorage.getItem('avcu.member.v1')));
  expect(frozen.frozen).toBe(true);
  await expect(page.locator('#card-state-description')).toContainText('locally');
});

test('check deposit rejects missing front and back images', async ({ page }) => {
  await openOperations(page);
  await fillBaseRequest(page, { type: 'check-deposit' });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#workflow-form button[type="submit"]').click();
  await expect(page.locator('#workflow-member-queue')).toContainText('No requests yet');
  await expect(page.locator('#workflow-operator-queue')).toContainText('No requests awaiting review');
});

test('check deposit previews both images and remains a review request', async ({ page }) => {
  await openOperations(page);
  await fillBaseRequest(page, { type: 'check-deposit' });
  const image = { name: 'check-side.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/X9sAAAAASUVORK5CYII=', 'base64') };
  await page.locator('#check-front').setInputFiles(image);
  await page.locator('#check-back').setInputFiles({ ...image, name: 'check-back.png' });
  await expect(page.locator('#check-front-preview img')).toHaveAttribute('alt', 'Front of check preview');
  await expect(page.locator('#check-back-preview img')).toHaveAttribute('alt', 'Back of check preview');
  await page.locator('#workflow-form button[type="submit"]').click();
  await expect(page.locator('#workflow-member-queue .workflow-request').first()).toContainText('Check deposit');
  await expect(page.locator('#workflow-member-queue .workflow-request').first().locator('.workflow-status')).toHaveText('Pending Approval');
});
