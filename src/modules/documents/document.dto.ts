import type { DocumentRecord } from './document.model.js';

export interface DocumentSummaryDto {
  documentId: string;
  title: string;
  contentLength: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDto extends DocumentSummaryDto {
  content: string;
}

export type DocumentSummaryRecord = Omit<DocumentRecord, 'content' | 'userId'>;

export function toDocumentSummaryDto(d: DocumentSummaryRecord): DocumentSummaryDto {
  return {
    documentId: d._id.toString(),
    title: d.title,
    contentLength: d.contentLength,
    version: d.version,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export function toDocumentDto(d: DocumentRecord): DocumentDto {
  return { ...toDocumentSummaryDto(d), content: d.content };
}
