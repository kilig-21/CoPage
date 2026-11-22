package com.school.collab.collab.presence;

public final class PresenceColor {
    private static final String[] COLORS = {"#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed"};

    private PresenceColor() { }

    public static String forUser(long userId) {
        return COLORS[Math.floorMod(userId, COLORS.length)];
    }
}
