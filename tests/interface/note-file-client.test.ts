import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../web/src/api.js';

afterEach(() => vi.unstubAllGlobals());

it('超過上限時不傳檔，直接顯示大小錯誤；剛好上限仍交給伺服器驗證', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: {} }) });
  vi.stubGlobal('fetch', fetch);
  const tooLarge = new File([new Uint8Array(1048577)], '筆記.md');
  expect(await api.attachNoteFile('case', 'item', tooLarge)).toMatchObject({
    ok: false,
    error: { code: 'NOTE_FILE_TOO_LARGE' },
  });
  expect(fetch).not.toHaveBeenCalled();
  const boundary = new File([new Uint8Array(1048576)], '筆記.md');
  await api.attachNoteFile('case', 'item', boundary);
  expect(fetch).toHaveBeenCalledWith(
    '/api/cases/case/items/item/note-files',
    expect.objectContaining({
      method: 'POST',
      body: boundary,
      headers: expect.objectContaining({
        'x-file-name': encodeURIComponent('筆記.md'),
        'content-type': 'application/octet-stream',
      }),
    }),
  );
});
