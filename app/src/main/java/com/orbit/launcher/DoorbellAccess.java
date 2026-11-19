package com.orbit.launcher;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.List;
import java.util.Locale;

/**
 * Doorbell pop-up. Runs as an accessibility service so it keeps going whatever app is
 * on screen. It:
 *  1. listens for the Tapo doorbell's UDP broadcast (port 20005) — a packet = a ring;
 *  2. remembers which app you were in, opens Tapo and taps the tile named like your
 *     doorbell (default "Doorbell") so the live view comes up;
 *  3. after the chosen time, backs out of the live view (so the battery doorbell stops
 *     streaming) and brings back the app you were watching.
 */
public class DoorbellAccess extends AccessibilityService {
    static final String TAPO = "com.tplink.iot";
    static volatile DoorbellAccess instance;

    private final Handler h = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private Doorbell bell;

    private volatile String fgPkg;      // app on screen right now (never Tapo)
    private String backTo;              // app to return to after the pop-up
    private boolean showing, tapped;
    private long ringAt, lastTry;

    static boolean running() { return instance != null; }

    /** Any crash in here makes Android switch the service off, so nothing is allowed to escape. */
    private void note(String where, Throwable t) {
        try {
            if (prefs == null) prefs = getSharedPreferences("orbit", MODE_PRIVATE);
            prefs.edit().putString("bell_err", where + ": " + t.getClass().getSimpleName()
                    + (t.getMessage() == null ? "" : " — " + t.getMessage())).apply();
        } catch (Throwable ignored) { }
    }

    @Override
    protected void onServiceConnected() {
        try { connect(); } catch (Throwable t) { note("start", t); }
    }

    private void connect() {
        instance = this;
        prefs = getSharedPreferences("orbit", MODE_PRIVATE);
        prefs.edit().remove("bell_err").putLong("bell_on_at", System.currentTimeMillis()).apply();
        if (prefs.getString("bell_ip", "").isEmpty()) {   // use the address the Doorbell test already heard
            try {
                org.json.JSONArray log = new org.json.JSONArray(prefs.getString("doorbell_log", "[]"));
                if (log.length() > 0) prefs.edit().putString("bell_ip", log.getJSONObject(0).optString("ip", "")).apply();
            } catch (Exception ignored) { }
        }
        bell = new Doorbell(this, new Doorbell.Listener() {
            @Override public void heard(String ip, int length, String hex) {
                try { Doorbell.record(prefs, ip, length, hex, true); } catch (Throwable t) { note("log", t); }
                h.post(() -> { try { ring(ip, false); } catch (Throwable t) { note("ring", t); } });
            }
            @Override public void status(String s) {
                try {
                    prefs.edit().putString("doorbell_status", s).apply();
                    MainActivity a = MainActivity.current();
                    if (a != null) a.bellStatusJs(s);
                } catch (Throwable t) { note("status", t); }
            }
        });
        bell.start();
    }

    @Override
    public boolean onUnbind(Intent intent) { shutdown(); return super.onUnbind(intent); }

    @Override
    public void onDestroy() { shutdown(); super.onDestroy(); }

    private void shutdown() {
        try { if (bell != null) bell.stop(); } catch (Throwable ignored) { }
        bell = null;
        instance = null;
        h.removeCallbacksAndMessages(null);
    }

    @Override public void onInterrupt() { }

    // ------------------------------------------------------------------ what's on screen

    @Override
    public void onAccessibilityEvent(AccessibilityEvent e) {
        try { event(e); } catch (Throwable t) { note("event", t); }
    }

    private void event(AccessibilityEvent e) {
        if (e == null) return;
        CharSequence cs = e.getPackageName();
        if (cs == null) return;
        String pkg = cs.toString();
        if (e.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && !TAPO.equals(pkg) && isApp(pkg)) {
            fgPkg = pkg;
        }
        if (showing && !tapped && TAPO.equals(pkg)) {
            long now = System.currentTimeMillis();
            if (now - lastTry > 350) { lastTry = now; tryTap(); }
        }
    }

    /** Ignore keyboards, the system bar and similar overlays when tracking the app you're in. */
    private boolean isApp(String pkg) {
        String p = pkg.toLowerCase(Locale.ROOT);
        if (p.equals("android") || p.startsWith("com.android.systemui") || p.contains("inputmethod")
                || p.contains("keyboard") || p.endsWith(".ime") || p.contains("leanbackime")) return false;
        try {
            PackageManager pm = getPackageManager();
            return pm.getLeanbackLaunchIntentForPackage(pkg) != null || pm.getLaunchIntentForPackage(pkg) != null;
        } catch (Exception x) {
            return false;
        }
    }

    // ------------------------------------------------------------------ the pop-up

    static void test() {
        DoorbellAccess a = instance;
        if (a != null) a.h.post(() -> { try { a.ring(null, true); } catch (Throwable t) { a.note("test", t); } });
    }

    private void ring(String ip, boolean test) {
        if (!test && !prefs.getBoolean("bell_popup", true)) return;
        if (!test && ip != null) {
            String want = prefs.getString("bell_ip", "");
            if (want.isEmpty()) prefs.edit().putString("bell_ip", ip).apply();   // learn the doorbell's address
            else if (!want.equals(ip)) return;                                   // some other device
        }
        long now = System.currentTimeMillis();
        if (showing) {                       // rang again while showing: just keep it up longer
            ringAt = now;
            if (tapped) scheduleFinish(secs() * 1000L);
            return;
        }
        Intent launch = getPackageManager().getLaunchIntentForPackage(TAPO);
        if (launch == null) launch = getPackageManager().getLeanbackLaunchIntentForPackage(TAPO);
        if (launch == null) {
            MainActivity a = MainActivity.current();
            if (a != null) a.toastJs("🔔 Someone's at the door — install Tapo on this box to see them");
            return;
        }
        backTo = fgPkg;
        showing = true;
        tapped = false;
        ringAt = now;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        try { startActivity(launch); } catch (Exception x) { showing = false; return; }
        // keep trying to tap the doorbell tile while Tapo loads
        for (int i = 1; i <= 24; i++) h.postDelayed(() -> { try { if (showing && !tapped) tryTap(); } catch (Throwable t) { note("tap", t); } }, i * 500L);
        // if the tile never appears, still give up and go back in good time
        scheduleFinish(12000L + secs() * 1000L);
    }

    private int secs() { return Math.max(5, Math.min(180, prefs.getInt("bell_secs", 20))); }

    private void tryTap() {
        AccessibilityNodeInfo root;
        try { root = getRootInActiveWindow(); } catch (Exception x) { return; }
        if (root == null || root.getPackageName() == null || !TAPO.equals(root.getPackageName().toString())) return;
        String name = prefs.getString("bell_name", "Doorbell").trim();
        if (name.isEmpty()) name = "Doorbell";
        List<AccessibilityNodeInfo> hits = root.findAccessibilityNodeInfosByText(name);
        AccessibilityNodeInfo best = null;
        for (AccessibilityNodeInfo n : hits) {
            if (!n.isVisibleToUser()) continue;
            CharSequence t = n.getText() != null ? n.getText() : n.getContentDescription();
            if (t != null && t.toString().trim().equalsIgnoreCase(name)) { best = n; break; }
            if (best == null) best = n;
        }
        if (best == null) return;
        AccessibilityNodeInfo n = best;
        for (int up = 0; n != null && up < 8; up++) {
            if (n.isClickable() && n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                tapped = true;
                scheduleFinish(secs() * 1000L);
                return;
            }
            n = n.getParent();
        }
    }

    private final Runnable finish = () -> { try { finish(); } catch (Throwable t) { note("finish", t); } };

    private void scheduleFinish(long ms) {
        h.removeCallbacks(finish);
        h.postDelayed(finish, ms);
    }

    private void finish() {
        if (!showing) return;
        showing = false;
        tapped = false;
        // back out of the live view so the doorbell stops streaming
        performGlobalAction(GLOBAL_ACTION_BACK);
        h.postDelayed(() -> performGlobalAction(GLOBAL_ACTION_BACK), 350);
        h.postDelayed(() -> { try { returnToApp(); } catch (Throwable t) { note("return", t); } }, 800);
    }

    private void returnToApp() {
        String pkg = backTo;
        backTo = null;
        Intent i = null;
        if (pkg != null) {
            PackageManager pm = getPackageManager();
            i = pm.getLeanbackLaunchIntentForPackage(pkg);
            if (i == null) i = pm.getLaunchIntentForPackage(pkg);
        }
        if (i == null) { performGlobalAction(GLOBAL_ACTION_HOME); return; }
        // bring the existing task to the front as it was, rather than restarting the app
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        try { startActivity(i); } catch (Exception x) { performGlobalAction(GLOBAL_ACTION_HOME); }
    }
}
