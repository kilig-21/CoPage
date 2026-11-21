package com.school.collab.storage;

import com.school.collab.common.BizException;
import com.school.collab.common.UserContext;
import io.minio.MinioClient;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ImageUploadServiceTest {
    private final MinioClient minio = mock(MinioClient.class);
    private final ImageAssetRepository assets = mock(ImageAssetRepository.class);
    private final ImageUploadService service = new ImageUploadService(
            minio, assets, "collab", "http://localhost:9000/", 3, 1024);

    @BeforeEach
    void signIn() {
        UserContext.set(9L, "synthetic");
        when(assets.lockOwnerAndReadUsage(9L)).thenReturn(new ImageAssetRepository.Usage(0, 0));
    }

    @AfterEach
    void clearIdentity() {
        UserContext.clear();
    }

    @Test
    void 应以文件签名判断类型并清理原始文件名() throws Exception {
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 0};
        MockMultipartFile file = new MockMultipartFile(
                "file", "C:\\fakepath\\diagram.png", "text/plain", png);

        ImageUploadService.ImageView view = service.upload(file);

        assertEquals("diagram.png", view.name());
        assertEquals("image/png", view.contentType());
        assertTrue(view.url().startsWith("http://localhost:9000/collab/images/"));
        assertTrue(view.url().endsWith(".png"));
        verify(minio).putObject(any(io.minio.PutObjectArgs.class));
    }

    @Test
    void 假图片和超大文件应拒绝且不得写入存储() {
        MockMultipartFile fake = new MockMultipartFile(
                "file", "fake.png", "image/png", "not an image".getBytes());
        MockMultipartFile tooLarge = new MockMultipartFile(
                "file", "large.png", "image/png", new byte[(int) ImageUploadService.MAX_BYTES + 1]);

        assertThrows(BizException.class, () -> service.upload(fake));
        assertThrows(BizException.class, () -> service.upload(tooLarge));
        verifyNoInteractions(minio);
    }

    @Test
    void countAndByteQuotasAreCheckedBeforeObjectWrite() {
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 0};
        var file = new MockMultipartFile("file", "image.png", "image/png", png);
        for (var usage : new ImageAssetRepository.Usage[] {
                new ImageAssetRepository.Usage(3, 100), new ImageAssetRepository.Usage(2, 1020)}) {
            when(assets.lockOwnerAndReadUsage(9L)).thenReturn(usage);
            assertTrue(assertThrows(BizException.class, () -> service.upload(file)).getMessage().contains("上限"));
        }
        verifyNoInteractions(minio);
    }
}
