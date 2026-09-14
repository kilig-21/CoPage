package com.school.collab.config;

import io.minio.MinioClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class MinioConfig {
    @Bean
    public MinioClient minioClient(
            @Value("${collab.minio.endpoint}") String endpoint,
            @Value("${collab.minio.access-key}") String accessKey,
            @Value("${collab.minio.secret-key}") String secretKey) {
        return MinioClient.builder().endpoint(endpoint).credentials(accessKey, secretKey).build();
    }
}
