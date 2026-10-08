package com.school.collab.auth;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.JwtUtil;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class AccountSessions {
    private final AccountRepository accounts;
    private final String secret;
    public AccountSessions(AccountRepository accounts, @Value("${collab.jwt.secret}") String secret) {
        this.accounts=accounts; this.secret=secret;
    }
    public AccountRepository.Profile authenticate(String token) {
        var claims = JwtUtil.parse(token, secret);
        long id = Long.parseLong(claims.getSubject());
        Object raw = claims.get("credentialVersion");
        // 兼容部署前的JWT：仅账号尚未改密(version=0)时接受缺省版本。
        if (raw != null && !(raw instanceof Integer || raw instanceof Long)) throw unauthorized();
        long version = raw == null ? 0 : ((Number) raw).longValue();
        if (id <= 0 || version < 0) throw unauthorized();
        var profile = accounts.profile(id).orElseThrow(this::unauthorized);
        if (profile.credentialVersion() != version) throw unauthorized();
        return profile;
    }
    public boolean isCurrent(long id, long version) { return accounts.isCurrent(id,version); }
    private BizException unauthorized() { return new BizException(ErrorCode.UNAUTHORIZED); }
}
