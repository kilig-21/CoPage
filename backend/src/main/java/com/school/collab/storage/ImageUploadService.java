package com.school.collab.storage;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import io.minio.MinioClient;
import io.minio.PutObjectArgs;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.InputStream;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.UUID;

@Service
public class ImageUploadService {
    static final long MAX_BYTES = 10L * 1024 * 1024;
    private static final DateTimeFormatter PATH_DATE = DateTimeFormatter.ofPattern("yyyy/MM");

    private final MinioClient minio;
    private final String bucket;
    private final String publicEndpoint;
    private final ImageAssetRepository assets;
    private final long countLimit;
    private final long byteLimit;

    public ImageUploadService(MinioClient minio, ImageAssetRepository assets,
                              @Value("${collab.minio.bucket}") String bucket,
                              @Value("${collab.minio.public-endpoint}") String publicEndpoint,
                              @Value("${collab.minio.image-count-limit}") long countLimit,
                              @Value("${collab.minio.image-byte-limit}") long byteLimit) {
        if (countLimit <= 0 || byteLimit <= 0) throw new IllegalArgumentException("图片配额必须为正整数");
        this.minio = minio;
        this.bucket = bucket;
        this.publicEndpoint = publicEndpoint.replaceAll("/+$", "");
        this.assets = assets;
        this.countLimit = countLimit;
        this.byteLimit = byteLimit;
    }

    @Transactional
    public ImageView upload(MultipartFile file) {
        if (file == null || file.isEmpty() || file.getSize() > MAX_BYTES) {
            throw new BizException(ErrorCode.PARAM_ERROR, "图片不能为空且不能超过 10 MiB");
        }
        ImageType type;
        try (InputStream input = file.getInputStream()) {
            type = ImageType.detect(input.readNBytes(12));
        } catch (Exception exception) {
            throw new BizException(ErrorCode.PARAM_ERROR, "无法读取图片文件");
        }
        if (type == null) {
            throw new BizException(ErrorCode.PARAM_ERROR, "仅支持 JPEG、PNG、GIF、WebP 图片");
        }

        Long owner = UserContext.getUserId();
        if (owner == null || owner <= 0) throw new BizException(ErrorCode.UNAUTHORIZED);
        var usage = assets.lockOwnerAndReadUsage(owner);
        if (usage.count() >= countLimit || file.getSize() > byteLimit - usage.bytes()) {
            throw new BizException(ErrorCode.PARAM_ERROR, "当前账号的图片数量或存储容量已达上限");
        }
        String key = "images/" + LocalDate.now().format(PATH_DATE) + "/"
                + UUID.randomUUID() + "." + type.extension;
        assets.create(key, owner, file.getSize(), type.mime);
        try (InputStream input = file.getInputStream()) {
            minio.putObject(PutObjectArgs.builder()
                    .bucket(bucket).object(key)
                    .stream(input, file.getSize(), -1)
                    .contentType(type.mime).build());
        } catch (Exception exception) {
            throw new IllegalStateException("MinIO 图片上传失败", exception);
        }
        String originalName = file.getOriginalFilename();
        String safeName = originalName == null ? "image." + type.extension
                : originalName.substring(Math.max(originalName.lastIndexOf('/'),
                originalName.lastIndexOf('\\')) + 1);
        if (safeName.isBlank()) {
            safeName = "image." + type.extension;
        }
        return new ImageView(publicEndpoint + "/" + bucket + "/" + key,
                safeName, file.getSize(), type.mime);
    }

    public record ImageView(String url, String name, long size, String contentType) {
    }

    enum ImageType {
        JPEG("jpg", "image/jpeg"), PNG("png", "image/png"),
        GIF("gif", "image/gif"), WEBP("webp", "image/webp");

        final String extension;
        final String mime;

        ImageType(String extension, String mime) {
            this.extension = extension;
            this.mime = mime;
        }

        static ImageType detect(byte[] bytes) {
            if (bytes.length >= 3 && u(bytes[0]) == 0xff && u(bytes[1]) == 0xd8 && u(bytes[2]) == 0xff) {
                return JPEG;
            }
            if (bytes.length >= 8 && u(bytes[0]) == 0x89 && ascii(bytes, 1, "PNG\r\n\u001a\n")) {
                return PNG;
            }
            if (bytes.length >= 6 && (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))) {
                return GIF;
            }
            if (bytes.length >= 12 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
                return WEBP;
            }
            return null;
        }

        private static boolean ascii(byte[] bytes, int offset, String value) {
            for (int i = 0; i < value.length(); i++) {
                if (u(bytes[offset + i]) != value.charAt(i)) return false;
            }
            return true;
        }

        private static int u(byte value) {
            return value & 0xff;
        }
    }
}
