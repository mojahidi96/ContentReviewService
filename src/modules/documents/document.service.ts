import { Errors } from '../../shared/errors/app-error.js';
import { toObjectId } from '../../shared/utils/ids.js';
import { codePointLength } from '../../shared/utils/offsets.js';
import {
  toDocumentDto,
  toDocumentSummaryDto,
  type DocumentDto,
  type DocumentSummaryDto,
  type DocumentSummaryRecord,
} from './document.dto.js';
import { DocumentModel, type DocumentRecord } from './document.model.js';
import type {
  CreateDocumentBody,
  ListDocumentsQuery,
  UpdateDocumentBody,
} from './document.schemas.js';

export interface DocumentPage {
  items: DocumentSummaryDto[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const SUMMARY_PROJECTION = {
  title: 1,
  contentLength: 1,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
} as const;

/**
 * Authors' working documents. Every query is scoped by userId, so another user's document is
 * indistinguishable from a missing one (404).
 */
export class DocumentService {
  async create(userId: string, input: CreateDocumentBody): Promise<DocumentDto> {
    const created = await DocumentModel.create({
      userId: toObjectId(userId),
      title: input.title,
      content: input.content,
      contentLength: codePointLength(input.content),
      version: 1,
    });
    return toDocumentDto(created.toObject<DocumentRecord>());
  }

  async list(userId: string, query: ListDocumentsQuery): Promise<DocumentPage> {
    const filter = { userId: toObjectId(userId) };
    const [records, total] = await Promise.all([
      DocumentModel.find(filter)
        .select(SUMMARY_PROJECTION)
        .sort({ updatedAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean<DocumentSummaryRecord[]>(),
      DocumentModel.countDocuments(filter),
    ]);
    return {
      items: records.map(toDocumentSummaryDto),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async get(userId: string, documentId: string): Promise<DocumentDto> {
    const record = await DocumentModel.findOne({
      _id: toObjectId(documentId),
      userId: toObjectId(userId),
    }).lean<DocumentRecord>();
    if (!record) throw Errors.documentNotFound();
    return toDocumentDto(record);
  }

  /**
   * Replaces title and content if `input.version` is still current, and bumps the version.
   * A stale version means someone saved in the meantime (e.g. another tab): 409, nothing written.
   */
  async update(
    userId: string,
    documentId: string,
    input: UpdateDocumentBody,
  ): Promise<DocumentDto> {
    const owner = { _id: toObjectId(documentId), userId: toObjectId(userId) };
    const updated = await DocumentModel.findOneAndUpdate(
      { ...owner, version: input.version },
      {
        $set: {
          title: input.title,
          content: input.content,
          contentLength: codePointLength(input.content),
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    ).lean<DocumentRecord>();
    if (updated) return toDocumentDto(updated);

    const current = await DocumentModel.findOne(owner)
      .select({ version: 1 })
      .lean<{ version: number }>();
    if (!current) throw Errors.documentNotFound();
    throw Errors.documentVersionConflict();
  }

  async delete(userId: string, documentId: string): Promise<void> {
    const res = await DocumentModel.deleteOne({
      _id: toObjectId(documentId),
      userId: toObjectId(userId),
    });
    if (res.deletedCount === 0) throw Errors.documentNotFound();
  }
}
