package com.orbit.launcher;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;
import android.net.wifi.WifiManager;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;

/**
 * Doorbell test: listens for the UDP broadcast some Tapo doorbells (or their hub)
 * send on port 20005 when the button is pressed. The packet's contents don't
 * matter; a packet arriving at all is the "ring". Every packet is reported so we
 * can see what (if anything) the doorbell sends.
 */
class Doorbell {
    static final int PORT = 20005;

    interface Listener {
        void heard(String ip, int length, String hex);
        void status(String status);
    }

    private final Context ctx;
    private final Listener listener;
    private volatile Thread thread;
    private volatile DatagramSocket socket;
    private WifiManager.MulticastLock lock;

    Doorbell(Context ctx, Listener listener) {
        this.ctx = ctx.getApplicationContext();
        this.listener = listener;
    }

    boolean running() { return thread != null; }

    synchronized void start() {
        if (thread != null) return;
        try {
            // Wi-Fi drivers drop broadcast packets to save power unless an app asks for them.
            WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                lock = wm.createMulticastLock("orbit-doorbell");
                lock.setReferenceCounted(false);
                lock.acquire();
            }
        } catch (Exception ignored) { }
        Thread t = new Thread(this::run, "orbit-doorbell");
        t.setDaemon(true);
        thread = t;
        t.start();
    }

    synchronized void stop() {
        thread = null;
        DatagramSocket s = socket;
        socket = null;
        if (s != null) s.close();
        if (lock != null) {
            try { lock.release(); } catch (Exception ignored) { }
            lock = null;
        }
        listener.status("off");
    }

    private void run() {
        DatagramSocket s = null;
        try {
            s = new DatagramSocket(null);
            s.setReuseAddress(true);
            s.setBroadcast(true);
            s.bind(new InetSocketAddress(PORT));
            socket = s;
            listener.status("listening");
            byte[] buf = new byte[4096];
            while (thread == Thread.currentThread()) {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                s.receive(p);
                String ip = p.getAddress() == null ? "?" : p.getAddress().getHostAddress();
                listener.heard(ip, p.getLength(), hex(buf, p.getLength(), 24));
            }
        } catch (Exception e) {
            if (thread == Thread.currentThread()) {
                listener.status("error: " + e.getClass().getSimpleName()
                        + (e.getMessage() == null ? "" : " — " + e.getMessage()));
                thread = null;
            }
        } finally {
            if (s != null) s.close();
        }
    }

    /** Keeps the last 20 packets for the Doorbell panel and tells Orbit's screen, if it's open. */
    static synchronized JSONObject record(SharedPreferences prefs, String ip, int length, String hex, boolean notify) {
        JSONObject e = new JSONObject();
        try {
            e.put("at", System.currentTimeMillis());
            e.put("ip", ip);
            e.put("len", length);
            e.put("hex", hex);
            JSONArray log;
            try { log = new JSONArray(prefs.getString("doorbell_log", "[]")); } catch (Exception x) { log = new JSONArray(); }
            JSONArray next = new JSONArray();
            next.put(e);
            for (int i = 0; i < log.length() && next.length() < 20; i++) next.put(log.get(i));
            prefs.edit()
                    .putString("doorbell_log", next.toString())
                    .putInt("doorbell_count", prefs.getInt("doorbell_count", 0) + 1)
                    .apply();
        } catch (Exception ignored) { }
        if (notify) {
            MainActivity a = MainActivity.current();
            if (a != null) a.bellHeardJs(e);
        }
        return e;
    }

    private static String hex(byte[] b, int len, int max) {
        StringBuilder sb = new StringBuilder();
        int n = Math.min(len, max);
        for (int i = 0; i < n; i++) {
            if (i > 0) sb.append(' ');
            sb.append(String.format("%02x", b[i] & 0xff));
        }
        if (len > max) sb.append(" …");
        return sb.toString();
    }
}
