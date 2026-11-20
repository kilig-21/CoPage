ALTER TABLE document ADD INDEX idx_document_search_pending (search_pending, id), ALGORITHM=INPLACE, LOCK=NONE;
