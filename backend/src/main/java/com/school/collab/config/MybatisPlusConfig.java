package com.school.collab.config;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Configuration;

@Configuration
@MapperScan("com.school.collab.**.mapper")
public class MybatisPlusConfig {
}
