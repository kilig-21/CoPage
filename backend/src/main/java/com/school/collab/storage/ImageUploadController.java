package com.school.collab.storage;

import com.school.collab.common.Result;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/upload")
public class ImageUploadController {
    private final ImageUploadService images;

    public ImageUploadController(ImageUploadService images) {
        this.images = images;
    }

    @PostMapping(value = "/image", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<ImageUploadService.ImageView> upload(@RequestParam("file") MultipartFile file) {
        return Result.ok(images.upload(file));
    }
}
