import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

async function pdfFixture(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) doc.addPage([420 + index, 594 + index]);
  return Buffer.from(await doc.save());
}

test('opens a large preview automatically before rotating pages', async ({ page }) => {
  await page.goto('/zubaer-ahmed-PDF-TEST/');
  await page.locator('[data-open-tool="rotate"]').click();
  const dialog = page.getByRole('dialog', { name: 'Workspace' });

  await dialog.locator('#workspace-file').setInputFiles({
    name: 'rotate-source.pdf',
    mimeType: 'application/pdf',
    buffer: await pdfFixture(4)
  });

  const preview = dialog.locator('[data-pre-edit-preview]');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('data-preview-ready', 'true');
  await expect(preview.locator('.pre-edit-canvas-shell canvas')).toBeVisible();
  await expect(preview.locator('.pre-edit-thumbnail-item')).toHaveCount(4);

  const shellBox = await preview.locator('.pre-edit-canvas-shell').boundingBox();
  expect(shellBox).not.toBeNull();
  expect(shellBox?.height ?? 0).toBeGreaterThanOrEqual(500);

  await dialog.locator('select[name="target"]').selectOption('selected');
  await dialog.locator('input[name="pages"]').fill('2,4');
  await expect(preview.locator('[data-pre-edit-hint]')).toContainText('selected pages 2,4');

  await expect(dialog.getByRole('button', { name: 'Run Rotate pages' })).toBeEnabled();
});

test('lets Merge PDF switch between every selected source before merging', async ({ page }) => {
  await page.goto('/zubaer-ahmed-PDF-TEST/');
  await page.getByLabel('Search tools').fill('merge');
  await page.getByRole('button', { name: 'Open tool' }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspace' });

  await dialog.locator('#workspace-file').setInputFiles([
    { name: 'first.pdf', mimeType: 'application/pdf', buffer: await pdfFixture(2) },
    { name: 'second.pdf', mimeType: 'application/pdf', buffer: await pdfFixture(3) }
  ]);

  const preview = dialog.locator('[data-pre-edit-preview]');
  await expect(preview).toBeVisible();
  await expect(preview.locator('[data-pre-edit-source]')).toHaveCount(2);
  await expect(preview.locator('[data-pre-edit-source="0"]')).toHaveText('PDF 1');
  await expect(preview.locator('[data-pre-edit-source="0"]')).toHaveAttribute('aria-label', 'Preview source 1: first.pdf');
  await expect(preview.locator('[data-pre-edit-source="1"]')).toHaveText('PDF 2');
  await expect(preview.locator('[data-pre-edit-source="1"]')).toHaveAttribute('aria-label', 'Preview source 2: second.pdf');

  await preview.locator('[data-pre-edit-source="1"]').click();
  await expect(preview).toHaveAttribute('data-preview-ready', 'true');
  await expect(preview.locator('.pre-edit-thumbnail-item')).toHaveCount(3);
  await expect(preview.locator('[data-pre-edit-hint]')).toContainText('inspect each document before merging');
});
