package com.school.collab.storage;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import io.minio.GetObjectArgs;
import io.minio.MinioClient;
import io.minio.errors.ErrorResponseException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.InputStreamResource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/images")
public class ImageReadController {
    private final MinioClient minio;
    private final ImageGrants grants;
    private final String bucket;

    public ImageReadController(MinioClient minio, ImageGrants grants, @Value("${collab.minio.bucket}") String bucket) {
        this.minio = minio;
        this.grants = grants;
        this.bucket = bucket;
    }

    @GetMapping("/{year}/{month}/{filename}")
    public ResponseEntity<InputStreamResource> read(@PathVariable String year, @PathVariable String month,
                                                    @PathVariable String filename) {
        Long userId = UserContext.getUserId();
        if (userId == null || userId <= 0) throw new BizException(ErrorCode.UNAUTHORIZED);
        String key = "images/" + year + "/" + month + "/" + filename;
        var contentType = MediaType.parseMediaType(grants.requireReadable(key, userId));
        try {
            var object = minio.getObject(GetObjectArgs.builder().bucket(bucket).object(key).build());
            return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(contentType)
                    .header("X-Content-Type-Options", "nosniff").body(new InputStreamResource(object));
        } catch (ErrorResponseException exception) {
            if ("NoSuchKey".equals(exception.errorResponse().code())) {
                throw new BizException(ErrorCode.NOT_FOUND, "图片文件不存在");
            }
            throw new BizException(ErrorCode.SERVICE_UNAVAILABLE, "图片服务暂时不可用");
        } catch (Exception exception) {
            throw new BizException(ErrorCode.SERVICE_UNAVAILABLE, "图片服务暂时不可用");
        }
    }
}
