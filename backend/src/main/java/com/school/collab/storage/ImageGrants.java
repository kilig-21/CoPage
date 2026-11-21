package com.school.collab.storage;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import org.springframework.stereotype.Service;

/** Extends image access with the same transaction that saves document or template content. */
@Service
public class ImageGrants {
    private final ImageAssetRepository assets;
    private final ObjectMapper mapper;

    public ImageGrants(ImageAssetRepository assets, ObjectMapper mapper) {
        this.assets = assets;
        this.mapper = mapper;
    }

    public void attachToDocument(long docId, long userId, String content) {
        for (String key : ImageReferences.keys(content, mapper)) {
            requireReadable(key, userId);
            assets.associateDocument(docId, key);
        }
    }

    public void attachToTemplate(long templateId, long userId, String content) {
        for (String key : ImageReferences.keys(content, mapper)) {
            requireReadable(key, userId);
            assets.associateTemplate(templateId, key);
        }
    }

    public void removeTemplate(long templateId) {
        assets.removeTemplateReferences(templateId);
    }

    public String requireReadable(String key, long userId) {
        if (!ImageReferences.validObjectKey(key)) throw new BizException(ErrorCode.NOT_FOUND, "图片不可用");
        return assets.readableMediaType(key, userId)
                .orElseThrow(() -> new BizException(ErrorCode.NOT_FOUND, "图片不存在或当前账号无权访问"));
    }
}
