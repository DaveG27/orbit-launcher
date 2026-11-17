package com.orbit.launcher;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Installs apps sent from the phone: a plain .apk, or a split bundle
 * (.apkm from APKMirror, .xapk from APKPure, .apks from SAI). For bundles it
 * picks the base APK plus the splits that fit this box (CPU, screen density)
 * and installs them together in one session.
 */
final class Installer {
    private static volatile boolean busy = false;

    private Installer() { }

    static boolean isAppLink(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        return p.endsWith(".apk") || p.endsWith(".apkm") || p.endsWith(".xapk") || p.endsWith(".apks")
                || p.contains("/releases/download/");
    }

    /** True when Orbit may install; otherwise opens the setting and returns false. */
    static boolean allowed(final MainActivity act) {
        if (Build.VERSION.SDK_INT < 26 || act.getPackageManager().canRequestPackageInstalls()) return true;
        act.toastJs("Allow Orbit to install apps, then send it again");
        act.runOnUiThread(() -> {
            try {
                act.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + act.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception e) {
                act.toastJs("Turn on “Install unknown apps” for Orbit in Settings");
            }
        });
        return false;
    }

    /** Download a link and install it. */
    static void install(final MainActivity act, final String url) {
        if (busy) { act.toastJs("Already installing something — one moment"); return; }
        if (!allowed(act)) return;
        busy = true;
        new Thread(() -> {
            File f = new File(act.getCacheDir(), "beam.bin");
            try {
                act.progressJs("Downloading", 0);
                final int[] last = {-1};
                Net.download(url, f, (done, total) -> {
                    int pct = total > 0 ? (int) (done * 100 / total) : -1;
                    if (pct != last[0] && (pct < 0 || pct % 2 == 0)) { last[0] = pct; act.progressJs("Downloading", pct); }
                });
                installFile(act, f);
            } catch (Exception e) {
                fail(act, e);
            }
        }, "orbit-install").start();
    }

    /** A file the phone uploaded through Beam is ready in the cache: install it. */
    static boolean claim(MainActivity act) {
        if (busy) { act.toastJs("Already installing something — one moment"); return false; }
        if (!allowed(act)) return false;
        busy = true;
        return true;
    }

    static void installUploaded(final MainActivity act, final File f) {
        new Thread(() -> {
            try { installFile(act, f); } catch (Exception e) { fail(act, e); }
        }, "orbit-install").start();
    }

    private static void fail(MainActivity act, Exception e) {
        act.progressJs(null, -1);
        act.toastJs("Install failed: " + (e.getMessage() == null ? "unknown error" : e.getMessage()));
        busy = false;
    }

    // ------------------------------------------------------------------ install

    private static void installFile(MainActivity act, File f) throws Exception {
        byte[] head = new byte[2];
        try (InputStream in = new FileInputStream(f)) {
            if (in.read(head) != 2 || head[0] != 'P' || head[1] != 'K') {
                throw new Exception("That isn't an app file (or the bundle is locked — older APKMirror bundles only open in their own installer)");
            }
        }
        act.progressJs("Installing", 100);
        PackageInstaller pi = act.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        int id = pi.createSession(params);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (ZipFile zip = new ZipFile(f)) {
                if (zip.getEntry("AndroidManifest.xml") != null) {
                    // a plain APK
                    write(s, "base.apk", new FileInputStream(f), f.length());
                } else {
                    Map<String, ZipEntry> picked = pickSplits(act, zip);
                    if (picked.isEmpty()) throw new Exception("No app found inside that file");
                    int i = 0;
                    for (Map.Entry<String, ZipEntry> e : picked.entrySet()) {
                        act.progressJs("Installing " + (++i) + "/" + picked.size(), 100);
                        write(s, e.getKey(), zip.getInputStream(e.getValue()), e.getValue().getSize());
                    }
                }
            }
            Intent cb = new Intent(act, InstallReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent p = PendingIntent.getBroadcast(act, id, cb, flags);
            s.commit(p.getIntentSender());
        } catch (Exception e) {
            try { pi.abandonSession(id); } catch (Exception ignored) { }
            throw e;
        }
    }

    private static void write(PackageInstaller.Session s, String name, InputStream src, long size) throws Exception {
        try (InputStream in = src; OutputStream out = s.openWrite(name, 0, size > 0 ? size : -1)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            s.fsync(out);
        }
    }

    // ------------------------------------------------------------------ choosing splits

    private static final String[] ABIS = {"arm64_v8a", "armeabi_v7a", "armeabi", "x86_64", "x86", "mips", "mips64"};
    private static final String[] DPI_NAMES = {"ldpi", "mdpi", "tvdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"};
    private static final int[] DPI_VALUES = {120, 160, 213, 240, 320, 480, 640};

    /**
     * base APK + every feature split + language splits, and only the one CPU split and
     * one density split that best fit this box.
     */
    static Map<String, ZipEntry> pickSplits(Context ctx, ZipFile zip) {
        LinkedHashMap<String, ZipEntry> keep = new LinkedHashMap<>();
        Map<String, ZipEntry> abi = new LinkedHashMap<>();
        Map<String, ZipEntry> dpi = new LinkedHashMap<>();
        List<ZipEntry> apks = new ArrayList<>();
        Enumeration<? extends ZipEntry> en = zip.entries();
        while (en.hasMoreElements()) {
            ZipEntry e = en.nextElement();
            String n = e.getName();
            if (!e.isDirectory() && n.toLowerCase(Locale.ROOT).endsWith(".apk") && !n.contains("/")) apks.add(e);
        }
        if (apks.isEmpty()) {  // some bundles keep the APKs in a folder
            en = zip.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (!e.isDirectory() && e.getName().toLowerCase(Locale.ROOT).endsWith(".apk")) apks.add(e);
            }
        }
        for (ZipEntry e : apks) {
            String file = e.getName().substring(e.getName().lastIndexOf('/') + 1);
            String lower = file.toLowerCase(Locale.ROOT);
            String q = qualifier(lower);
            if (q == null) { keep.put(safeName(file), e); continue; }     // base or a feature split
            if (indexOf(ABIS, q) >= 0) { abi.put(q, e); continue; }
            if (indexOf(DPI_NAMES, q) >= 0) { dpi.put(q, e); continue; }
            keep.put(safeName(file), e);                                  // language and anything else
        }
        // CPU: the first ABI this box supports that the bundle has
        for (String a : Build.SUPPORTED_ABIS) {
            String key = a.toLowerCase(Locale.ROOT).replace('-', '_');
            if (abi.containsKey(key)) { ZipEntry e = abi.get(key); keep.put(safeName(entryFile(e)), e); break; }
        }
        // Density: the smallest bucket at or above the screen's, else the biggest there is
        if (!dpi.isEmpty()) {
            int screen = ctx.getResources().getDisplayMetrics().densityDpi;
            String best = null;
            int bestVal = Integer.MAX_VALUE, maxVal = -1;
            String max = null;
            for (String d : dpi.keySet()) {
                int v = DPI_VALUES[indexOf(DPI_NAMES, d)];
                if (v >= screen && v < bestVal) { bestVal = v; best = d; }
                if (v > maxVal) { maxVal = v; max = d; }
            }
            String pick = best != null ? best : max;
            ZipEntry e = dpi.get(pick);
            keep.put(safeName(entryFile(e)), e);
        }
        return keep;
    }

    /** "split_config.arm64_v8a.apk" / "config.xhdpi.apk" → "arm64_v8a" / "xhdpi"; null for base or feature splits. */
    private static String qualifier(String lower) {
        String n = lower.startsWith("split_") ? lower.substring(6) : lower;
        if (!n.startsWith("config.")) return null;
        return n.substring(7, n.length() - 4);
    }

    private static String entryFile(ZipEntry e) { return e.getName().substring(e.getName().lastIndexOf('/') + 1); }

    private static String safeName(String file) { return file.replaceAll("[^A-Za-z0-9._-]", "_"); }

    private static int indexOf(String[] a, String s) {
        for (int i = 0; i < a.length; i++) if (a[i].equals(s)) return i;
        return -1;
    }

    static void done() { busy = false; }

    /** Receives the system installer's answer. */
    public static class InstallReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
            MainActivity act = MainActivity.current();
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try { context.startActivity(confirm); } catch (Exception ignored) { }
                }
                return;
            }
            done();
            if (act == null) return;
            act.progressJs(null, -1);
            if (status == PackageInstaller.STATUS_SUCCESS) {
                act.toastJs("Installed — a new world has entered orbit");
            } else {
                String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                act.toastJs("Install didn’t finish" + (msg != null ? ": " + msg : ""));
            }
        }
    }
}
