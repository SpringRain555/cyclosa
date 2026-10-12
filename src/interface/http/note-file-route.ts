import type { FastifyInstance } from 'fastify';

import {
  MAX_NOTE_FILE_BYTES,
  parseNoteFile,
  type NoteFileInput,
} from '../../application/note-file-input.js';
import { httpStatusOf } from '../../domain/errors/codes.js';
import { correlationId } from '../../shared/id.js';
import { err, type Result } from '../../shared/result.js';

interface NoteFileTarget {
  readonly slug: string;
  readonly itemId: string;
}

/**
 * Stage 23 步驟 2：接收層。步驟 3 接上真正的儲存服務後才在主路由註冊。
 * 不提供假成功的預設 handler；測試可以注入服務來驗證 HTTP 邊界。
 * 沿用 server 的 octet-stream parser 與本機請求守門。
 */
export function registerNoteFileRoute<T>(
  app: FastifyInstance,
  attach: (target: NoteFileTarget, file: NoteFileInput) => Promise<Result<T>>,
): void {
  app.post<{ Params: NoteFileTarget }>(
    '/api/cases/:slug/items/:itemId/note-files',
    {
      bodyLimit: MAX_NOTE_FILE_BYTES,
      errorHandler(error, _req, reply) {
        if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
          return reply.code(413).send(err('NOTE_FILE_TOO_LARGE', correlationId()));
        }
        // 未預期錯誤仍交給 server 的既有處理器。
        throw error;
      },
    },
    async (req, reply) => {
      const mediaType = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
      const rawName = req.headers['x-file-name'];
      let fileName: string;
      try {
        fileName = typeof rawName === 'string' ? decodeURIComponent(rawName) : '';
      } catch {
        return reply.code(400).send(err('NOTE_FILE_UNSUPPORTED', correlationId()));
      }
      if (mediaType !== 'application/octet-stream' || !Buffer.isBuffer(req.body)) {
        return reply.code(400).send(err('NOTE_FILE_UNSUPPORTED', correlationId()));
      }
      const parsed = parseNoteFile(fileName, req.body);
      if (!parsed.ok) return reply.code(httpStatusOf(parsed.code)).send(parsed);
      const result = await attach(req.params, parsed.data);
      return reply.code(result.ok ? 200 : httpStatusOf(result.code)).send(result);
    },
  );
}
