-- Snapshot the pre-cutover grants from existing content and retained history.
-- No document, snapshot, operation or template body is rewritten.

INSERT INTO document_image_asset (doc_id, object_key)
SELECT source.id, CONCAT('images/', SUBSTRING_INDEX(image.url, '/images/', -1))
FROM document source
JOIN JSON_TABLE(
  IF(JSON_VALID(source.content) AND source.content LIKE '%/images/%', source.content, '{"ops":[]}'),
  '$.ops[*]' COLUMNS (url VARCHAR(2048) PATH '$.insert.image' NULL ON EMPTY NULL ON ERROR)
) image
WHERE REGEXP_LIKE(image.url, '^https?://[^/?#]+(/[^/?#]+)+/images/[0-9]{4}/(0[1-9]|1[0-2])/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|gif|webp)$', 'c')
ON DUPLICATE KEY UPDATE object_key = document_image_asset.object_key;

INSERT INTO document_image_asset (doc_id, object_key)
SELECT source.doc_id, CONCAT('images/', SUBSTRING_INDEX(image.url, '/images/', -1))
FROM doc_snapshot source
JOIN JSON_TABLE(
  IF(JSON_VALID(source.content) AND source.content LIKE '%/images/%', source.content, '{"ops":[]}'),
  '$.ops[*]' COLUMNS (url VARCHAR(2048) PATH '$.insert.image' NULL ON EMPTY NULL ON ERROR)
) image
WHERE REGEXP_LIKE(image.url, '^https?://[^/?#]+(/[^/?#]+)+/images/[0-9]{4}/(0[1-9]|1[0-2])/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|gif|webp)$', 'c')
ON DUPLICATE KEY UPDATE object_key = document_image_asset.object_key;

INSERT INTO document_image_asset (doc_id, object_key)
SELECT source.doc_id, CONCAT('images/', SUBSTRING_INDEX(image.url, '/images/', -1))
FROM doc_named_version source
JOIN JSON_TABLE(
  IF(JSON_VALID(source.content) AND source.content LIKE '%/images/%', source.content, '{"ops":[]}'),
  '$.ops[*]' COLUMNS (url VARCHAR(2048) PATH '$.insert.image' NULL ON EMPTY NULL ON ERROR)
) image
WHERE REGEXP_LIKE(image.url, '^https?://[^/?#]+(/[^/?#]+)+/images/[0-9]{4}/(0[1-9]|1[0-2])/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|gif|webp)$', 'c')
ON DUPLICATE KEY UPDATE object_key = document_image_asset.object_key;

INSERT INTO document_image_asset (doc_id, object_key)
SELECT source.doc_id, CONCAT('images/', SUBSTRING_INDEX(image.url, '/images/', -1))
FROM doc_operation source
JOIN JSON_TABLE(
  IF(JSON_VALID(source.op) AND source.op LIKE '%/images/%', source.op, '{"ops":[]}'),
  '$.ops[*]' COLUMNS (url VARCHAR(2048) PATH '$.insert.image' NULL ON EMPTY NULL ON ERROR)
) image
WHERE REGEXP_LIKE(image.url, '^https?://[^/?#]+(/[^/?#]+)+/images/[0-9]{4}/(0[1-9]|1[0-2])/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|gif|webp)$', 'c')
ON DUPLICATE KEY UPDATE object_key = document_image_asset.object_key;

INSERT INTO template_image_asset (template_id, object_key)
SELECT source.id, CONCAT('images/', SUBSTRING_INDEX(image.url, '/images/', -1))
FROM personal_template source
JOIN JSON_TABLE(
  IF(JSON_VALID(source.content) AND source.content LIKE '%/images/%', source.content, '{"ops":[]}'),
  '$.ops[*]' COLUMNS (url VARCHAR(2048) PATH '$.insert.image' NULL ON EMPTY NULL ON ERROR)
) image
WHERE REGEXP_LIKE(image.url, '^https?://[^/?#]+(/[^/?#]+)+/images/[0-9]{4}/(0[1-9]|1[0-2])/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|gif|webp)$', 'c')
ON DUPLICATE KEY UPDATE object_key = template_image_asset.object_key;

INSERT INTO image_asset (object_key, media_type)
SELECT refs.object_key,
       CASE SUBSTRING_INDEX(refs.object_key, '.', -1)
         WHEN 'jpg' THEN 'image/jpeg'
         ELSE CONCAT('image/', SUBSTRING_INDEX(refs.object_key, '.', -1))
       END
FROM (
  SELECT object_key FROM document_image_asset
  UNION
  SELECT object_key FROM template_image_asset
) refs
ON DUPLICATE KEY UPDATE object_key = image_asset.object_key;
