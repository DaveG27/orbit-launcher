package com.orbit.launcher;

import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

/**
 * Live worlds: an Xtream login plus a short list of favourite channels.
 * Everything is stored on the box only.
 */
final class Live {
    private final SharedPreferences prefs;
    private JSONArray streams;
    private long streamsAt;

    Live(SharedPreferences prefs) { this.prefs = prefs; }

    synchronized JSONObject login() {
        try {
            String s = prefs.getString("live_login", null);
            return s == null ? null : new JSONObject(s);
        } catch (Exception e) {
            return null;
        }
    }

    synchronized boolean signedIn() { return login() != null; }

    private static String normalise(String server) {
        String s = server.trim();
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (s.endsWith("/player_api.php")) s = s.substring(0, s.length() - "/player_api.php".length());
        return s;
    }

    private static String api(JSONObject l) {
        return l.optString("server") + "/player_api.php?username=" + Uri.encode(l.optString("user"))
                + "&password=" + Uri.encode(l.optString("pass"));
    }

    /** Checks the login with the provider before saving it. */
    void signIn(String server, String user, String pass) throws Exception {
        JSONObject l = new JSONObject();
        l.put("server", normalise(server));
        l.put("user", user.trim());
        l.put("pass", pass.trim());
        String body = Net.get(api(l), 20000);
        JSONObject o;
        try {
            o = new JSONObject(body);
        } catch (Exception e) {
            throw new Exception("The server didn't answer like an Xtream server");
        }
        JSONObject ui = o.optJSONObject("user_info");
        if (ui == null || !"1".equals(String.valueOf(ui.opt("auth")))) throw new Exception("Login refused");
        synchronized (this) {
            prefs.edit().putString("live_login", l.toString()).apply();
            streams = null;
        }
    }

    synchronized void signOut() {
        prefs.edit().remove("live_login").remove("live_channels").apply();
        streams = null;
    }

    synchronized JSONArray channels() {
        try {
            return new JSONArray(prefs.getString("live_channels", "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private void saveChannels(JSONArray a) { prefs.edit().putString("live_channels", a.toString()).apply(); }

    synchronized void add(String id, String name, String icon) throws Exception {
        JSONArray a = channels();
        for (int i = 0; i < a.length(); i++) if (id.equals(a.getJSONObject(i).optString("id"))) return;
        JSONObject c = new JSONObject();
        c.put("id", id);
        c.put("name", name);
        c.put("icon", icon == null ? "" : icon);
        a.put(c);
        saveChannels(a);
    }

    synchronized void remove(String id) throws Exception {
        JSONArray a = channels(), out = new JSONArray();
        for (int i = 0; i < a.length(); i++) if (!id.equals(a.getJSONObject(i).optString("id"))) out.put(a.get(i));
        saveChannels(out);
    }

    synchronized void move(String id, int dir) throws Exception {
        JSONArray a = channels();
        int ix = -1;
        for (int i = 0; i < a.length(); i++) if (id.equals(a.getJSONObject(i).optString("id"))) ix = i;
        int to = ix + dir;
        if (ix < 0 || to < 0 || to >= a.length()) return;
        Object t = a.get(ix);
        a.put(ix, a.get(to));
        a.put(to, t);
        saveChannels(a);
    }

    private JSONArray streams() throws Exception {
        JSONObject l;
        synchronized (this) {
            if (streams != null && System.currentTimeMillis() - streamsAt < 6 * 3600_000L) return streams;
            l = login();
        }
        if (l == null) throw new Exception("Not signed in");
        JSONArray a = new JSONArray(Net.get(api(l) + "&action=get_live_streams", 90000));
        synchronized (this) {
            streams = a;
            streamsAt = System.currentTimeMillis();
        }
        return a;
    }

    JSONArray search(String q) throws Exception {
        String[] words = q.toLowerCase(Locale.ROOT).trim().split("\\s+");
        JSONArray all = streams(), out = new JSONArray();
        for (int i = 0; i < all.length() && out.length() < 60; i++) {
            JSONObject s = all.optJSONObject(i);
            if (s == null) continue;
            String name = s.optString("name", "");
            String low = name.toLowerCase(Locale.ROOT);
            boolean ok = true;
            for (String w : words) if (!w.isEmpty() && !low.contains(w)) { ok = false; break; }
            if (!ok) continue;
            JSONObject r = new JSONObject();
            r.put("id", String.valueOf(s.opt("stream_id")));
            r.put("name", name);
            r.put("icon", s.optString("stream_icon", ""));
            out.put(r);
        }
        return out;
    }

    /** Raw get_short_epg answer for one channel (titles are base64). */
    String epg(String id) throws Exception {
        JSONObject l = login();
        if (l == null) return "{}";
        return Net.get(api(l) + "&action=get_short_epg&stream_id=" + Uri.encode(id) + "&limit=3", 15000);
    }

    String playUrl(String id) {
        JSONObject l = login();
        if (l == null) return null;
        return l.optString("server") + "/live/" + l.optString("user") + "/" + l.optString("pass") + "/" + id + ".ts";
    }

    /** Host only, never the full login, for showing on screen. */
    String host() {
        JSONObject l = login();
        if (l == null) return "";
        try {
            return Uri.parse(l.optString("server")).getHost();
        } catch (Exception e) {
            return "";
        }
    }
}
