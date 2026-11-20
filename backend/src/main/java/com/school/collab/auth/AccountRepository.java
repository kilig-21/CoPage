package com.school.collab.auth;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import java.util.List;
import java.util.Optional;

@Repository
public class AccountRepository {
    private final JdbcTemplate jdbc;
    public AccountRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public Optional<Profile> profile(long id) {
        return profiles("SELECT id,username,nickname,avatar,credential_version FROM `user` WHERE id=?", id)
                .stream().findFirst();
    }
    private List<Profile> profiles(String sql, long id) {
        return jdbc.query(sql, (rs, row) -> new Profile(rs.getLong("id"), rs.getString("username"),
                rs.getString("nickname"), rs.getString("avatar"), rs.getLong("credential_version")), id);
    }
    public Optional<Credentials> lockCredentials(long id) {
        return jdbc.query("SELECT id,username,nickname,avatar,credential_version,password FROM `user` WHERE id=? FOR UPDATE",
                (rs, row) -> new Credentials(new Profile(rs.getLong("id"), rs.getString("username"),
                        rs.getString("nickname"), rs.getString("avatar"), rs.getLong("credential_version")),
                        rs.getString("password")), id).stream().findFirst();
    }
    public boolean isCurrent(long id, long version) {
        if (id <= 0 || version < 0) return false;
        List<Long> versions = jdbc.query("SELECT credential_version FROM `user` WHERE id=?",
                (rs, row) -> rs.getLong(1), id);
        return versions.size() == 1 && versions.getFirst() == version;
    }
    public void nickname(long id, String nickname) { jdbc.update("UPDATE `user` SET nickname=? WHERE id=?", nickname, id); }
    public void password(long id, String hash, long version) {
        jdbc.update("UPDATE `user` SET password=?,credential_version=? WHERE id=?", hash, version, id);
    }
    public record Profile(long id, String username, String nickname, String avatar, long credentialVersion) { }
    public record Credentials(Profile profile, String passwordHash) { }
}
