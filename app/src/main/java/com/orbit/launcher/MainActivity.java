package com.orbit.launcher;

import android.app.Activity;
import android.app.ActivityOptions;
import android.app.AlarmManager;
import android.app.AppOpsManager;
import android.app.PendingIntent;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Orbit: a thin native shell. The experience lives in assets/ (HTML/CSS/JS);
 * this class serves those files from a private origin, renders icons, runs the
 * Beam phone server, the Eclipse timer, live channels and the APK installer.
 */
public class MainActivity extends Activity {

    private static final String HOST = "orbit.local";
    private static final String BASE = "https://" + HOST + "/";
    private static final String ACTION_ECLIPSE = "com.orbit.launcher.ECLIPSE";
    private static final String DOWNLOADER = "com.esaba.downloader";
    private static final String REBORN = "app.reborn.iptv";
    private static final Pattern CODE = Pattern.compile("^\\d{3,8}$");

    private static volatile WeakReference<MainActivity> current = new WeakReference<>(null);

    static MainActivity current() { return current.get(); }

    private WebView web;
    private volatile boolean pageReady = false;
    private boolean eclipsePending = false;
    private SharedPreferences prefs;
    private Live live;
    private BeamServer beam;
    private Doorbell doorbell;
    private final Map<String, byte[]> iconCache = new ConcurrentHashMap<>();
    private final Map<String, byte[]> imgCache = java.util.Collections.synchronizedMap(
            new LinkedHashMap<String, byte[]>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, byte[]> e) { return size() > 80; }
            });

    private final BroadcastReceiver packageReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            Uri data = intent.getData();
            if (data != null) iconCache.remove(data.getSchemeSpecificPart());
            js("window.Orbit&&Orbit.appsChanged()");
        }
    };

    Live live() { return live; }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = new WeakReference<>(this);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        prefs = getSharedPreferences("orbit", MODE_PRIVATE);
        live = new Live(prefs);

        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        web = new WebView(this);
        web.setBackgroundColor(0xFF03040D);
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.addJavascriptInterface(new Bridge(), "OrbitNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serve(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                if (eclipsePending) { eclipsePending = false; js("window.Orbit&&Orbit.eclipseArrived()"); }
            }
        });

        setContentView(web);
        web.requestFocus();
        web.loadUrl(BASE + "index.html");

        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_PACKAGE_ADDED);
        f.addAction(Intent.ACTION_PACKAGE_REMOVED);
        f.addAction(Intent.ACTION_PACKAGE_CHANGED);
        f.addDataScheme("package");
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(packageReceiver, f, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(packageReceiver, f);
        }

        String token = prefs.getString("beam_token", null);
        if (token == null) {
            token = randomToken();
            prefs.edit().putString("beam_token", token).apply();
        }
        beam = new BeamServer(this, token);
        beam.start();

        doorbell = new Doorbell(this, new Doorbell.Listener() {
            @Override
            public void heard(String ip, int length, String hex) { doorbellHeard(ip, length, hex); }

            @Override
            public void status(String status) {
                prefs.edit().putString("doorbell_status", status).apply();
                js("window.Orbit&&Orbit.doorbellStatus&&Orbit.doorbellStatus(" + JSONObject.quote(status) + ")");
            }
        });
        if (prefs.getBoolean("doorbell_test", false)) doorbell.start();

        handleIntent(getIntent());
    }

    private static String randomToken() {
        String abc = "abcdefghjkmnpqrstuvwxyz23456789";
        SecureRandom r = new SecureRandom();
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < 8; i++) b.append(abc.charAt(r.nextInt(abc.length())));
        return b.toString();
    }

    @Override
    protected void onResume() {
        super.onResume();
        current = new WeakReference<>(this);
        if (web != null) web.requestFocus();
        if (pageReady) js("window.Orbit&&Orbit.resume()");
    }

    @Override
    protected void onPause() {
        if (pageReady) js("window.Orbit&&Orbit.pause&&Orbit.pause()");
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (handleIntent(intent)) return;
        if (intent != null && intent.hasCategory(Intent.CATEGORY_HOME) && pageReady && hasWindowFocus()) {
            js("window.Orbit&&Orbit.home()");
        }
    }

    private boolean handleIntent(Intent intent) {
        if (intent == null || !ACTION_ECLIPSE.equals(intent.getAction())) return false;
        prefs.edit().remove("eclipse_at").apply();
        if (pageReady) js("window.Orbit&&Orbit.eclipseArrived()");
        else eclipsePending = true;
        return true;
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(packageReceiver); } catch (Exception ignored) { }
        if (beam != null) beam.shutdown();
        if (doorbell != null) doorbell.stop();
        if (web != null) { web.removeJavascriptInterface("OrbitNative"); web.destroy(); web = null; }
        super.onDestroy();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        String name = null;
        switch (e.getKeyCode()) {
            case KeyEvent.KEYCODE_BACK:
            case KeyEvent.KEYCODE_ESCAPE:
                name = "back"; break;
            case KeyEvent.KEYCODE_MENU:
            case KeyEvent.KEYCODE_SETTINGS:
                name = "menu"; break;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                name = "playpause"; break;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                name = "options"; break;
            default:
                break;
        }
        if (name != null) {
            if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) {
                js("window.Orbit&&Orbit.key('" + name + "')");
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    void js(final String code) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }

    // ------------------------------------------------------------------ Doorbell test
    // Keeps the last 20 packets heard on UDP 20005, so a ring is recorded even while
    // another app is on screen.
    private synchronized void doorbellHeard(String ip, int length, String hex) {
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
        js("window.Orbit&&Orbit.doorbellHeard&&Orbit.doorbellHeard(" + e.toString() + ")");
    }

    String doorbellState() {
        JSONObject o = new JSONObject();
        try {
            o.put("on", doorbell != null && doorbell.running());
            o.put("status", prefs.getString("doorbell_status", "off"));
            o.put("count", prefs.getInt("doorbell_count", 0));
            JSONArray log;
            try { log = new JSONArray(prefs.getString("doorbell_log", "[]")); } catch (Exception x) { log = new JSONArray(); }
            o.put("log", log);
            String ip = BeamServer.lanIp(); o.put("ip", ip == null ? "" : ip);
        } catch (Exception ignored) { }
        return o.toString();
    }

    void toastJs(String msg) { js("window.Orbit&&Orbit.toast(" + JSONObject.quote(msg) + ")"); }

    void progressJs(String label, int pct) {
        js("window.Orbit&&Orbit.progress(" + (label == null ? "null" : JSONObject.quote(label)) + "," + pct + ")");
    }

    void liveChanged() { js("window.Orbit&&Orbit.liveChanged()"); }

    // ------------------------------------------------------------------ Beam: something arrived from the phone

    /** Decides what a beamed piece of text is and acts on it. Returns a short description for the phone. */
    String onBeam(final String text) {
        String t = text.trim();
        if (CODE.matcher(t).matches()) {
            final String code = t;
            runOnUiThread(() -> openDownloaderCode(code));
            return "Opening code " + code + " in Downloader";
        }
        String url = null;
        if (t.startsWith("http://") || t.startsWith("https://")) url = t;
        else if (!t.contains(" ") && t.matches("^[\\w.-]+\\.[a-zA-Z]{2,}(/.*)?$")) url = "https://" + t;
        if (url != null) {
            String path = Uri.parse(url).getPath();
            path = path == null ? "" : path.toLowerCase(Locale.ROOT);
            if (path.endsWith(".apk") || path.contains("/releases/download/")) {
                Installer.install(this, url);
                return "Installing on the TV";
            }
            final String open = url;
            runOnUiThread(() -> openUrl(open));
            return "Opening on the TV";
        }
        js("window.Orbit&&Orbit.beamNote(" + JSONObject.quote(text) + ")");
        return "Shown on the TV";
    }

    private void openDownloaderCode(String code) {
        Intent d = new Intent(Intent.ACTION_VIEW, Uri.parse("https://aftv.news/" + code))
                .setPackage(DOWNLOADER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(d);
            return;
        } catch (ActivityNotFoundException ignored) { }
        Intent l = launchIntent(DOWNLOADER);
        if (l == null) { toastJs("Downloader isn’t installed on this box"); return; }
        startActivity(l);
        Toast.makeText(this, "Type " + code + " into Downloader", Toast.LENGTH_LONG).show();
    }

    private void openUrl(String url) {
        Intent v = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(v);
        } catch (ActivityNotFoundException e) {
            try {
                startActivity(new Intent(v).setPackage(DOWNLOADER));
            } catch (ActivityNotFoundException e2) {
                toastJs("No browser on this box to open that link");
            }
        }
    }

    // ------------------------------------------------------------------ Eclipse (sleep timer for any app)

    long eclipseAt() {
        long at = prefs.getLong("eclipse_at", 0);
        return at > System.currentTimeMillis() ? at : 0;
    }

    private PendingIntent eclipseIntent() {
        Intent i = new Intent(this, MainActivity.class).setAction(ACTION_ECLIPSE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT >= 34) {
            Bundle opts = ActivityOptions.makeBasic()
                    .setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                    .toBundle();
            return PendingIntent.getActivity(this, 77, i, flags, opts);
        }
        return PendingIntent.getActivity(this, 77, i, flags);
    }

    long setEclipse(int minutes) {
        AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
        PendingIntent pi = eclipseIntent();
        am.cancel(pi);
        if (minutes <= 0) {
            prefs.edit().remove("eclipse_at").apply();
            return 0;
        }
        long at = System.currentTimeMillis() + minutes * 60_000L;
        try {
            if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else if (Build.VERSION.SDK_INT >= 23) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (SecurityException e) {
            am.set(AlarmManager.RTC_WAKEUP, at, pi);
        }
        prefs.edit().putLong("eclipse_at", at).apply();
        return at;
    }

    long setEclipseFromPhone(int minutes) {
        long at = setEclipse(minutes);
        js("window.Orbit&&Orbit.eclipseChanged(" + at + ")");
        return at;
    }

    // ------------------------------------------------------------------ apps

    private Intent launchIntent(String pkg) {
        PackageManager pm = getPackageManager();
        Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
        if (i == null) i = pm.getLaunchIntentForPackage(pkg);
        if (i != null) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        return i;
    }

    private boolean usageAccess() {
        try {
            AppOpsManager ao = (AppOpsManager) getSystemService(Context.APP_OPS_SERVICE);
            @SuppressWarnings("deprecation")
            int mode = ao.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), getPackageName());
            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    private Map<String, Long> lastUsedMap() {
        Map<String, Long> out = new HashMap<>();
        if (!usageAccess()) return out;
        try {
            UsageStatsManager um = (UsageStatsManager) getSystemService(Context.USAGE_STATS_SERVICE);
            long now = System.currentTimeMillis();
            Map<String, UsageStats> m = um.queryAndAggregateUsageStats(now - 400L * 86_400_000L, now);
            for (Map.Entry<String, UsageStats> e : m.entrySet()) out.put(e.getKey(), e.getValue().getLastTimeUsed());
        } catch (Exception ignored) { }
        return out;
    }

    private static long apkSize(ApplicationInfo ai) {
        long size = 0;
        try {
            if (ai.sourceDir != null) size += new File(ai.sourceDir).length();
            if (ai.splitSourceDirs != null) for (String s : ai.splitSourceDirs) size += new File(s).length();
        } catch (Exception ignored) { }
        return size;
    }

    // ------------------------------------------------------------------ local origin

    private WebResourceResponse serve(Uri uri) {
        if (uri == null || !HOST.equals(uri.getHost())) return null;
        String path = uri.getPath();
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        try {
            if (path.startsWith("/icon/")) {
                byte[] png = iconPng(Uri.decode(path.substring(6)));
                return png == null ? notFound() : ok("image/png", png);
            }
            if (path.equals("/img")) { // remote image (channel logos) through the box, so it's same-origin
                String u = uri.getQueryParameter("u");
                if (u == null || !(u.startsWith("http://") || u.startsWith("https://"))) return notFound();
                byte[] b = imgCache.get(u);
                if (b == null) {
                    b = Net.bytes(u, 10000, 3 * 1024 * 1024);
                    imgCache.put(u, b);
                }
                return ok("image/png", b);
            }
            if (path.equals("/beam-qr.png")) {
                String url = beam == null ? null : beam.url();
                return url == null ? notFound() : ok("image/png", qrPng(url));
            }
            String name = path.substring(1);
            InputStream in = getAssets().open(name);
            return withHeaders(new WebResourceResponse(mime(name), "utf-8", in));
        } catch (Exception e) {
            return notFound();
        }
    }

    private static WebResourceResponse ok(String mime, byte[] b) {
        return withHeaders(new WebResourceResponse(mime, null, new ByteArrayInputStream(b)));
    }

    private static WebResourceResponse withHeaders(WebResourceResponse r) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        h.put("Access-Control-Allow-Origin", BASE.substring(0, BASE.length() - 1));
        r.setResponseHeaders(h);
        return r;
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mime(String name) {
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".js")) return "application/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private static byte[] qrPng(String text) throws Exception {
        Map<EncodeHintType, Object> hints = new HashMap<>();
        hints.put(EncodeHintType.MARGIN, 2);
        BitMatrix m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints);
        int scale = 10, w = m.getWidth() * scale, h = m.getHeight() * scale;
        int[] px = new int[w * h];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                px[y * w + x] = m.get(x / scale, y / scale) ? Color.rgb(8, 10, 30) : Color.WHITE;
            }
        }
        Bitmap bmp = Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
        bmp.recycle();
        return out.toByteArray();
    }

    private byte[] iconPng(String pkg) {
        byte[] cached = iconCache.get(pkg);
        if (cached != null) return cached;
        PackageManager pm = getPackageManager();
        Drawable d = null;
        try {
            Intent launch = launchIntent(pkg);
            if (launch != null) {
                try { d = pm.getActivityIcon(launch); } catch (Exception ignored) { }
            }
            if (d == null) d = pm.getApplicationIcon(pkg);
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
        if (d == null) return null;
        try {
            int size = 256;
            Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(bmp);
            Drawable copy = d.getConstantState() != null ? d.getConstantState().newDrawable(getResources()).mutate() : d;
            copy.setBounds(0, 0, size, size);
            copy.draw(c);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
            bmp.recycle();
            byte[] bytes = out.toByteArray();
            iconCache.put(pkg, bytes);
            return bytes;
        } catch (Exception e) {
            return null;
        }
    }

    // ------------------------------------------------------------------ JS bridge

    private class Bridge {

        @JavascriptInterface
        public String getApps() {
            PackageManager pm = getPackageManager();
            LinkedHashMap<String, String> found = new LinkedHashMap<>();
            collect(pm, Intent.CATEGORY_LEANBACK_LAUNCHER, found);
            collect(pm, Intent.CATEGORY_LAUNCHER, found);
            Map<String, Long> used = lastUsedMap();
            JSONArray arr = new JSONArray();
            for (Map.Entry<String, String> e : found.entrySet()) {
                try {
                    String pkg = e.getKey();
                    JSONObject o = new JSONObject();
                    o.put("pkg", pkg);
                    o.put("label", e.getValue());
                    o.put("icon", BASE + "icon/" + Uri.encode(pkg));
                    try {
                        ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                        PackageInfo pi = pm.getPackageInfo(pkg, 0);
                        o.put("system", (ai.flags & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0);
                        o.put("size", apkSize(ai));
                        o.put("installed", pi.firstInstallTime);
                    } catch (Exception ignored) { }
                    Long lu = used.get(pkg);
                    o.put("lastUsed", lu == null ? -1 : lu);
                    arr.put(o);
                } catch (Exception ignored) { }
            }
            return arr.toString();
        }

        private void collect(PackageManager pm, String category, Map<String, String> into) {
            Intent i = new Intent(Intent.ACTION_MAIN).addCategory(category);
            List<ResolveInfo> list = pm.queryIntentActivities(i, 0);
            for (ResolveInfo ri : list) {
                String pkg = ri.activityInfo.packageName;
                if (pkg.equals(getPackageName()) || into.containsKey(pkg)) continue;
                CharSequence label = ri.loadLabel(pm);
                into.put(pkg, label != null ? label.toString() : pkg);
            }
        }

        @JavascriptInterface
        public boolean hasUsageAccess() { return usageAccess(); }

        @JavascriptInterface
        public boolean launch(String pkg) {
            Intent i = launchIntent(pkg);
            if (i == null) return false;
            start(i);
            return true;
        }

        @JavascriptInterface
        public void openSettings() {
            start(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }

        @JavascriptInterface
        public void appInfo(String pkg) {
            start(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }

        @JavascriptInterface
        public void uninstall(String pkg) {
            start(new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + pkg)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }

        @JavascriptInterface
        public String load(String key) { return prefs.getString(key, null); }

        @JavascriptInterface
        public void save(String key, String value) { prefs.edit().putString(key, value).apply(); }

        // --- Beam
        @JavascriptInterface
        public String beamInfo() {
            JSONObject o = new JSONObject();
            try {
                String url = beam == null ? null : beam.url();
                o.put("url", url == null ? JSONObject.NULL : url);
                o.put("short", url == null ? JSONObject.NULL : url.replaceFirst("/\\?t=.*$", ""));
            } catch (Exception ignored) { }
            return o.toString();
        }

        // --- Doorbell test
        @JavascriptInterface
        public String doorbellState() { return MainActivity.this.doorbellState(); }

        @JavascriptInterface
        public void doorbellTest(boolean on) {
            prefs.edit().putBoolean("doorbell_test", on).apply();
            if (on) {
                prefs.edit().remove("doorbell_log").remove("doorbell_count").apply();
                doorbell.start();
            } else {
                doorbell.stop();
            }
        }

        // --- Eclipse
        @JavascriptInterface
        public double setEclipse(int minutes) { return MainActivity.this.setEclipse(minutes); }

        @JavascriptInterface
        public double getEclipse() { return eclipseAt(); }

        // --- Live
        @JavascriptInterface
        public String liveState() {
            JSONObject o = new JSONObject();
            try {
                o.put("signedIn", live.signedIn());
                o.put("channels", live.channels());
                o.put("reborn", launchIntent(REBORN) != null);
            } catch (Exception ignored) { }
            return o.toString();
        }

        @JavascriptInterface
        public void liveEpg(final String idsCsv) {
            new Thread(() -> {
                JSONObject res = new JSONObject();
                for (String id : idsCsv.split(",")) {
                    if (id.isEmpty()) continue;
                    try { res.put(id, new JSONObject(live.epg(id))); } catch (Exception ignored) { }
                }
                js("window.Orbit&&Orbit.liveEpg(" + res.toString() + ")");
            }, "orbit-epg").start();
        }

        @JavascriptInterface
        public void liveRemove(String id) {
            try { live.remove(id); } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public boolean playLive(String id) {
            String url = live.playUrl(id);
            if (url == null) return false;
            // the favourites list, so channel up/down in Reborn moves through them
            JSONArray list = new JSONArray();
            int index = -1;
            JSONArray chans = live.channels();
            for (int i = 0; i < chans.length(); i++) {
                JSONObject c = chans.optJSONObject(i);
                if (c == null) continue;
                try {
                    JSONObject e = new JSONObject();
                    e.put("name", c.optString("name"));
                    e.put("url", live.playUrl(c.optString("id")));
                    e.put("num", i + 1);
                    list.put(e);
                    if (id.equals(c.optString("id"))) index = i;
                } catch (Exception ignored) { }
            }
            Intent reborn = getPackageManager().getLaunchIntentForPackage(REBORN);
            if (reborn == null) reborn = getPackageManager().getLeanbackLaunchIntentForPackage(REBORN);
            if (reborn != null) {
                reborn.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                reborn.putExtra("orbit.play_url", url);
                reborn.putExtra("orbit.channels", list.toString());
                reborn.putExtra("orbit.index", index);
                start(reborn);
                return true;
            }
            Intent any = new Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(url), "video/*")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            start(any);
            return true;
        }

        private void start(final Intent i) {
            runOnUiThread(() -> {
                try { startActivity(i); } catch (Exception e) { toastJs("Couldn’t open that"); }
            });
        }
    }
}
