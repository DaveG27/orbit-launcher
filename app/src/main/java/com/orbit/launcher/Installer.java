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

/** Downloads an APK link beamed from the phone and installs it with the system installer. */
final class Installer {
    private static volatile boolean busy = false;

    private Installer() { }

    static void install(final MainActivity act, final String url) {
        if (busy) { act.toastJs("Already installing something — one moment"); return; }
        if (Build.VERSION.SDK_INT >= 26 && !act.getPackageManager().canRequestPackageInstalls()) {
            act.toastJs("Allow Orbit to install apps, then beam the link again");
            act.runOnUiThread(() -> {
                try {
                    act.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + act.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception e) {
                    act.toastJs("Turn on “Install unknown apps” for Orbit in Settings");
                }
            });
            return;
        }
        busy = true;
        new Thread(() -> {
            File f = new File(act.getCacheDir(), "beam.apk");
            try {
                act.progressJs("Downloading", 0);
                final int[] last = {-1};
                Net.download(url, f, (done, total) -> {
                    int pct = total > 0 ? (int) (done * 100 / total) : -1;
                    if (pct != last[0] && (pct < 0 || pct % 2 == 0)) { last[0] = pct; act.progressJs("Downloading", pct); }
                });
                byte[] head = new byte[2];
                try (InputStream in = new FileInputStream(f)) {
                    if (in.read(head) != 2 || head[0] != 'P' || head[1] != 'K') throw new Exception("That link isn't an APK file");
                }
                act.progressJs("Installing", 100);
                PackageInstaller pi = act.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                int id = pi.createSession(params);
                try (PackageInstaller.Session s = pi.openSession(id)) {
                    try (OutputStream out = s.openWrite("base.apk", 0, f.length()); InputStream in = new FileInputStream(f)) {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                        s.fsync(out);
                    }
                    Intent cb = new Intent(act, InstallReceiver.class);
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                    if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
                    PendingIntent p = PendingIntent.getBroadcast(act, id, cb, flags);
                    s.commit(p.getIntentSender());
                }
            } catch (Exception e) {
                act.progressJs(null, -1);
                act.toastJs("Install failed: " + (e.getMessage() == null ? "unknown error" : e.getMessage()));
                busy = false;
            }
        }, "orbit-install").start();
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
