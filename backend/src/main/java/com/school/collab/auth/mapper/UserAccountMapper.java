package com.school.collab.auth.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.school.collab.auth.UserAccount;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface UserAccountMapper extends BaseMapper<UserAccount> {
}
