import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

async function pdfFixture(pageCount: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage([595, 842]);
  return Buffer.from(await document.save());
}

async function openMerge(page: import('@playwright/test').Page) {
  await page.goto('/zubaer-ahmed-PDF-TEST/');
  await page.getByLabel('Search tools').fill('merge');
  await page.locator('[data-tool="merge"]').getByRole('button', { name: 'Open tool' }).click();
  return page.getByRole('dialog', { name: 'Workspace' });
}

test('Merge PDF matches the preserved four-pane editor experience', async ({ page }) => {
  const dialog = await openMerge(page);
  await expect(dialog.locator('.legacy-editor-shell')).toBeVisible();
  await expect(dialog.locator('.legacy-files-pane')).toBeVisible();
  await expect(dialog.locator('.legacy-center-pane')).toBeVisible();
  await expect(dialog.locator('.legacy-settings-pane')).toBeVisible();
  await expect(dialog.locator('[data-legacy-overview]')).toHaveText(/Overview/);
  await expect(dialog.locator('[data-parity-trash]')).toBeVisible();
  await expect(dialog.locator('[data-parity-restore]')).toBeVisible();
  await expect(dialog.locator('[data-parity-undo]')).toBeVisible();
  await expect(dialog.locator('[data-parity-redo]')).toBeVisible();
  await expect(dialog.locator('input[name="outputFilename"]')).toHaveValue('merged.pdf');

  await dialog.locator('#workspace-file').setInputFiles({
    name: 'source.pdf',
    mimeType: 'application/pdf',
    buffer: await pdfFixture(2)
  });

  await expect(dialog.locator('[data-pre-edit-preview]')).toBeVisible();
  await expect(dialog.locator('[data-pre-edit-preview]')).toHaveAttribute('data-preview-ready', 'true');
  await expect(dialog.locator('#file-list .file-row')).toHaveCount(1);
  await expect(dialog.locator('#file-list .file-row small')).toContainText('2 pages');
  await expect(dialog.locator('.legacy-replace-file')).toBeVisible();
  await expect(dialog.locator('[data-parity-file-status]')).toHaveText('1 file added.');
  await expect(dialog.locator('[data-legacy-footer-state-ui]')).toHaveText('0 selected / 0 removed / 2 output pages');
  await expect(dialog.locator('[data-parity-page-meta]')).toContainText('595 × 842 pt');

  const filesBox = await dialog.locator('.legacy-files-pane').boundingBox();
  const centerBox = await dialog.locator('.legacy-center-pane').boundingBox();
  const settingsBox = await dialog.locator('.legacy-settings-pane').boundingBox();
  expect(filesBox).not.toBeNull();
  expect(centerBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect((centerBox?.width ?? 0)).toBeGreaterThan(filesBox?.width ?? 0);
  expect((centerBox?.width ?? 0)).toBeGreaterThan(settingsBox?.width ?? 0);
});

test('Merge file ordering, custom output name and PDF Overview stay connected to the real workflow', async ({ page }) => {
  const dialog = await openMerge(page);
  await dialog.locator('#workspace-file').setInputFiles([
    { name: 'first.pdf', mimeType: 'application/pdf', buffer: await pdfFixture(1) },
    { name: 'second.pdf', mimeType: 'application/pdf', buffer: await pdfFixture(2) }
  ]);

  await expect(dialog.locator('#file-list .file-row')).toHaveCount(2);
  await expect(dialog.locator('#file-list .file-row').nth(0)).toContainText('first.pdf');
  await dialog.locator('#file-list .file-row').nth(1).getByRole('button', { name: 'Move second.pdf up' }).click();
  await expect(dialog.locator('#file-list .file-row').nth(0)).toContainText('second.pdf');
  await expect(dialog.locator('[data-legacy-footer-state-ui]')).toContainText('3 output pages');

  await dialog.locator('[data-legacy-overview]').click();
  const overview = dialog.getByRole('dialog', { name: /PDF overview for/i });
  await expect(overview).toBeVisible();
  await expect(overview.locator('[data-overview-thumbnails]')).toBeVisible();
  await expect(overview.locator('[data-overview-canvas]')).toBeVisible();
  await expect(overview.locator('.legacy-overview-text')).toBeVisible();
  await overview.getByRole('button', { name: 'Close PDF overview' }).click();
  await expect(overview).toBeHidden();

  await dialog.locator('input[name="outputFilename"]').fill('My merged result.pdf');
  await dialog.getByRole('button', { name: 'Run Merge PDF' }).click();
  const download = dialog.locator('#result a.download');
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute('download', 'My merged result.pdf');
});
