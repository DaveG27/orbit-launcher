package com.orbit.launcher;

import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Beam: a tiny web server on the local network so a phone can act as Orbit's keyboard.
 * The phone page and every API call need the per-install token from the QR code.
 */
final class BeamServer extends Thread {

    private final MainActivity act;
    private final String token;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private ServerSocket server;
    private volatile int port = 0;
    private volatile boolean closed = false;

    BeamServer(MainActivity act, String token) {
        super("orbit-beam");
        setDaemon(true);
        this.act = act;
        this.token = token;
    }

    int port() { return port; }

    /** http://<lan-ip>:<port>/?t=<token>, or null when the box has no network. */
    String url() {
        String ip = lanIp();
        if (ip == null || port == 0) return null;
        return "http://" + ip + ":" + port + "/?t=" + token;
    }

    static String lanIp() {
        try {
            String fallback = null;
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
                    if (a.isSiteLocalAddress()) return a.getHostAddress();
                    if (fallback == null) fallback = a.getHostAddress();
                }
            }
            return fallback;
        } catch (Exception e) {
            return null;
        }
    }

    void shutdown() {
        closed = true;
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        pool.shutdownNow();
    }

    @Override
    public void run() {
        for (int p = 8790; p < 8800 && server == null; p++) {
            try {
                server = new ServerSocket(p);
                port = p;
            } catch (IOException ignored) { }
        }
        if (server == null) return;
        while (!closed) {
            try {
                final Socket s = server.accept();
                pool.execute(() -> handle(s));
            } catch (IOException e) {
                if (closed) return;
            }
        }
    }

    // ------------------------------------------------------------------ HTTP

    private static final class Req {
        String method, path;
        Map<String, String> query = new HashMap<>();
        Map<String, String> headers = new HashMap<>();
        byte[] body = new byte[0];

        JSONObject json() {
            try {
                return new JSONObject(new String(body, StandardCharsets.UTF_8));
            } catch (Exception e) {
                return new JSONObject();
            }
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 8192) throw new IOException("Line too long");
        }
        if (c == -1 && b.size() == 0) return null;
        return new String(b.toByteArray(), StandardCharsets.UTF_8);
    }

    private void handle(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(15000);
            InputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = sock.getOutputStream();
            String line = readLine(in);
            if (line == null) return;
            String[] parts = line.split(" ");
            if (parts.length < 2) return;
            Req r = new Req();
            r.method = parts[0].toUpperCase(Locale.ROOT);
            Uri u = Uri.parse("http://x" + parts[1]);
            r.path = u.getPath() == null ? "/" : u.getPath();
            for (String k : u.getQueryParameterNames()) r.query.put(k, u.getQueryParameter(k));
            String h;
            while ((h = readLine(in)) != null && !h.isEmpty()) {
                int i = h.indexOf(':');
                if (i > 0) r.headers.put(h.substring(0, i).trim().toLowerCase(Locale.ROOT), h.substring(i + 1).trim());
            }
            int len = 0;
            try { len = Integer.parseInt(r.headers.containsKey("content-length") ? r.headers.get("content-length") : "0"); } catch (NumberFormatException ignored) { }
            if (len > 256 * 1024) { send(out, 413, "text/plain", "Too large".getBytes(StandardCharsets.UTF_8)); return; }
            if (len > 0) {
                byte[] b = new byte[len];
                int off = 0;
                while (off < len) {
                    int n = in.read(b, off, len - off);
                    if (n < 0) break;
                    off += n;
                }
                r.body = b;
            }
            route(r, out);
        } catch (Exception ignored) { }
    }

    private static void send(OutputStream out, int code, String type, byte[] body) throws IOException {
        String status = code == 200 ? "OK" : code == 404 ? "Not Found" : code == 403 ? "Forbidden" : "Error";
        String head = "HTTP/1.1 " + code + " " + status + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static void json(OutputStream out, int code, Object o) throws IOException {
        send(out, code, "application/json; charset=utf-8", o.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static JSONObject err(String msg) {
        JSONObject o = new JSONObject();
        try { o.put("error", msg); } catch (Exception ignored) { }
        return o;
    }

    private static JSONObject ok() {
        JSONObject o = new JSONObject();
        try { o.put("ok", true); } catch (Exception ignored) { }
        return o;
    }

    private void route(Req r, OutputStream out) throws Exception {
        if (!token.equals(r.query.get("t"))) {
            send(out, 403, "text/html; charset=utf-8",
                    "<h2 style='font-family:sans-serif'>Scan the QR code on your TV (Orbit &rarr; Tools &rarr; Beam).</h2>"
                            .getBytes(StandardCharsets.UTF_8));
            return;
        }
        String p = r.path;
        if (p.equals("/") || p.equals("/index.html")) {
            try (InputStream a = act.getAssets().open("beam.html")) {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = a.read(buf)) > 0) b.write(buf, 0, n);
                send(out, 200, "text/html; charset=utf-8", b.toByteArray());
            }
            return;
        }
        Live live = act.live();
        try {
            switch (p) {
                case "/api/state": {
                    JSONObject o = new JSONObject();
                    o.put("eclipseAt", act.eclipseAt());
                    o.put("signedIn", live.signedIn());
                    o.put("channels", live.channels());
                    json(out, 200, o);
                    return;
                }
                case "/api/send": {
                    String text = r.json().optString("text", "").trim();
                    if (text.isEmpty()) { json(out, 400, err("Nothing to send")); return; }
                    if (text.length() > 4000) text = text.substring(0, 4000);
                    JSONObject o = new JSONObject();
                    o.put("did", act.onBeam(text));
                    json(out, 200, o);
                    return;
                }
                case "/api/eclipse": {
                    int min = r.json().optInt("minutes", 0);
                    JSONObject o = new JSONObject();
                    o.put("eclipseAt", act.setEclipseFromPhone(min));
                    json(out, 200, o);
                    return;
                }
                case "/api/live/login": {
                    JSONObject b = r.json();
                    live.signIn(b.optString("server"), b.optString("user"), b.optString("pass"));
                    act.liveChanged();
                    json(out, 200, ok());
                    return;
                }
                case "/api/live/logout":
                    live.signOut();
                    act.liveChanged();
                    json(out, 200, ok());
                    return;
                case "/api/live/search": {
                    String q = r.query.get("q");
                    JSONArray a = live.search(q == null ? "" : q);
                    json(out, 200, a);
                    return;
                }
                case "/api/live/add": {
                    JSONObject b = r.json();
                    live.add(b.optString("id"), b.optString("name"), b.optString("icon"));
                    act.liveChanged();
                    json(out, 200, live.channels());
                    return;
                }
                case "/api/live/remove":
                    live.remove(r.json().optString("id"));
                    act.liveChanged();
                    json(out, 200, live.channels());
                    return;
                case "/api/live/move": {
                    JSONObject b = r.json();
                    live.move(b.optString("id"), b.optInt("dir", 0));
                    act.liveChanged();
                    json(out, 200, live.channels());
                    return;
                }
                default:
                    json(out, 404, err("Unknown"));
            }
        } catch (Exception e) {
            json(out, 500, err(e.getMessage() == null ? "Something went wrong" : e.getMessage()));
        }
    }
}
