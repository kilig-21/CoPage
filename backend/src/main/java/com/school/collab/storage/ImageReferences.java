package com.school.collab.storage;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Pattern;

public final class ImageReferences {
    private static final String KEY = "images/[0-9]{4}/(0[1-9]|1[0-2])/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|gif|webp)";
    private static final Pattern KEY_PATTERN = Pattern.compile(KEY);
    private static final Pattern PATH = Pattern.compile("(/[^/?#]+)+/(" + KEY + ")");

    private ImageReferences() { }

    public static String objectKey(String reference) {
        if (reference == null || reference.length() > 2048 || !reference.contains("/images/")) return null;
        try {
            URI uri = URI.create(reference);
            if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) return null;
            var match = PATH.matcher(uri.getRawPath());
            return match.matches() ? match.group(2) : null;
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }

    public static boolean validObjectKey(String key) {
        return key != null && KEY_PATTERN.matcher(key).matches();
    }

    public static Set<String> keys(String json, ObjectMapper mapper) {
        if (json == null || !json.contains("/images/")) return Set.of();
        var result = new LinkedHashSet<String>();
        try {
            for (var op : mapper.readTree(json).path("ops")) {
                var image = op.path("insert").path("image");
                if (image.isTextual()) {
                    String key = objectKey(image.asText());
                    if (key != null) result.add(key);
                }
            }
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("无法读取文档图片引用", exception);
        }
        return result;
    }
}
