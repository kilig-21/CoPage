package com.school.collab.storage;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import io.minio.MinioClient;
import io.minio.PutObjectArgs;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
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

    public ImageUploadService(MinioClient minio,
                              @Value("${collab.minio.bucket}") String bucket,
                              @Value("${collab.minio.public-endpoint}") String publicEndpoint) {
        this.minio = minio;
        this.bucket = bucket;
        this.publicEndpoint = publicEndpoint.replaceAll("/+$", "");
    }

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

        String key = "images/" + LocalDate.now().format(PATH_DATE) + "/"
                + UUID.randomUUID() + "." + type.extension;
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
