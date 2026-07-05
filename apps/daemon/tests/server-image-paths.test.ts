import { expect, test } from 'vitest';

import {
  collectPromptImagePathInputs,
  resolveSafePromptImagePaths,
  selectPromptImagePaths,
} from '../src/server.js';

test('selectPromptImagePaths uses staged AMR paths in prompt text', () => {
  expect(
    selectPromptImagePaths(
      'amr',
      ['/tmp/od-uploads/original.png'],
      ['/project/.amr-attachments/staged.png'],
    ),
  ).toEqual(['/project/.amr-attachments/staged.png']);
});

test('selectPromptImagePaths keeps original paths for non-AMR agents', () => {
  expect(
    selectPromptImagePaths(
      'opencode',
      ['/tmp/od-uploads/original.png'],
      ['/project/.amr-attachments/staged.png'],
    ),
  ).toEqual(['/tmp/od-uploads/original.png']);
});

test('collectPromptImagePathInputs includes visual screenshot paths from comment attachments', () => {
  expect(
    collectPromptImagePathInputs([], [
      { screenshotPath: '/tmp/od-uploads/drawing.png' },
    ]),
  ).toEqual(['/tmp/od-uploads/drawing.png']);
});

test('collectPromptImagePathInputs dedupes explicit image paths and visual screenshots', () => {
  expect(
    collectPromptImagePathInputs(
      ['/tmp/od-uploads/drawing.png', ''],
      [
        { screenshotPath: '/tmp/od-uploads/drawing.png' },
        { screenshotPath: '/tmp/od-uploads/other.png' },
      ],
    ),
  ).toEqual(['/tmp/od-uploads/drawing.png', '/tmp/od-uploads/other.png']);
});

test('resolveSafePromptImagePaths rejects images larger than 1 MB', () => {
  const result = resolveSafePromptImagePaths(
    ['/tmp/od-uploads/too-large.png', '/tmp/od-uploads/ok.png'],
    {
      uploadDir: '/tmp/od-uploads',
      existsSync: () => true,
      statSync: (inputPath: string) => ({
        isFile: () => true,
        size: inputPath.endsWith('too-large.png') ? 1024 * 1024 + 1 : 1024,
      }),
    },
  );

  expect(result.safeImages).toEqual(['/tmp/od-uploads/ok.png']);
  expect(result.oversizedImages).toEqual([
    { path: '/tmp/od-uploads/too-large.png', sizeBytes: 1024 * 1024 + 1 },
  ]);
});

test('resolveSafePromptImagePaths keeps images at or below 1 MB', () => {
  const result = resolveSafePromptImagePaths(
    ['/tmp/od-uploads/exactly-1mb.png'],
    {
      uploadDir: '/tmp/od-uploads',
      existsSync: () => true,
      statSync: () => ({
        isFile: () => true,
        size: 1024 * 1024,
      }),
    },
  );

  expect(result.safeImages).toEqual(['/tmp/od-uploads/exactly-1mb.png']);
  expect(result.oversizedImages).toEqual([]);
});

test('resolveSafePromptImagePaths surfaces stat failures instead of dropping the image', () => {
  const result = resolveSafePromptImagePaths(['/tmp/od-uploads/unreadable.png'], {
    uploadDir: '/tmp/od-uploads',
    existsSync: () => true,
    statSync: () => {
      throw Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
    },
  });

  expect(result.safeImages).toEqual([]);
  expect(result.oversizedImages).toEqual([]);
  expect(result.failedImages).toEqual([
    { path: '/tmp/od-uploads/unreadable.png', error: 'EACCES: permission denied' },
  ]);
});
