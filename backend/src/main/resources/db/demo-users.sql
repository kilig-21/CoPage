-- 仅供本地开发；生产部署不挂载此文件。
SET NAMES utf8mb4;
USE collab_doc;
-- testA / testB 的初始密码均为 123456（BCrypt，cost=10）。
-- 昵称用 UTF-8 十六进制写入，避免 Windows shell 导入 SQL 时错误解码。
INSERT IGNORE INTO `user` (`username`, `password`, `nickname`) VALUES
  ('testA', '$2a$10$gGfvADvFVCzg8LCHc2Zmm.7Vdd1C5asti6mnE2RPIwdxNKMIUsQ7m', CONVERT(0xE6B58BE8AF95E794A8E688B72041 USING utf8mb4)),
  ('testB', '$2a$10$gGfvADvFVCzg8LCHc2Zmm.7Vdd1C5asti6mnE2RPIwdxNKMIUsQ7m', CONVERT(0xE6B58BE8AF95E794A8E688B72042 USING utf8mb4));
