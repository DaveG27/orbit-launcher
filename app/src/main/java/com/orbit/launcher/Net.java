package com.orbit.launcher;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Tiny HTTP client: follows redirects across http/https (HttpURLConnection won't on its own). */
final class Net {
    static final String UA = "okhttp/4.9.3";

    interface Progress { void update(long done, long total); }

    private Net() { }

    static String get(String url, int timeoutMs) throws IOException {
        return new String(bytes(url, timeoutMs, 64 * 1024 * 1024), StandardCharsets.UTF_8);
    }

    static byte[] bytes(String url, int timeoutMs, int max) throws IOException {
        HttpURLConnection c = open(url, timeoutMs);
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n, total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > max) throw new IOException("Response too large");
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } finally {
            c.disconnect();
        }
    }

    static void download(String url, File dest, Progress p) throws IOException {
        HttpURLConnection c = open(url, 30000);
        long total = c.getContentLength();
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[65536];
            long done = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                if (p != null) p.update(done, total);
            }
        } finally {
            c.disconnect();
        }
    }

    private static HttpURLConnection open(String url, int timeoutMs) throws IOException {
        String current = url;
        for (int hop = 0; hop < 8; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(current).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(Math.min(timeoutMs, 15000));
            c.setReadTimeout(timeoutMs);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept", "*/*");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) throw new IOException("Redirect without a location");
                current = new URL(new URL(current), loc).toString();
                continue;
            }
            if (code >= 400) {
                c.disconnect();
                throw new IOException("Server said " + code);
            }
            return c;
        }
        throw new IOException("Too many redirects");
    }
}
