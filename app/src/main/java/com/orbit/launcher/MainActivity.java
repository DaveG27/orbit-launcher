package com.orbit.launcher;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Bundle;
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

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Orbit: a thin native shell. The whole experience lives in assets/ (HTML/CSS/JS);
 * this class serves those files from a private origin, renders app icons on demand,
 * and exposes a tiny bridge (list apps, launch, store state, open settings).
 */
public class MainActivity extends Activity {

    private static final String HOST = "orbit.local";
    private static final String BASE = "https://" + HOST + "/";

    private WebView web;
    private boolean pageReady = false;
    private SharedPreferences prefs;
    private final Map<String, byte[]> iconCache = new ConcurrentHashMap<>();

    private final BroadcastReceiver packageReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            Uri data = intent.getData();
            if (data != null) iconCache.remove(data.getSchemeSpecificPart());
            js("window.Orbit&&Orbit.appsChanged()");
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        prefs = getSharedPreferences("orbit", MODE_PRIVATE);

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
                return !HOST.equals(request.getUrl().getHost()); // never navigate away
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
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
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            registerReceiver(packageReceiver, f, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(packageReceiver, f);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.requestFocus();
        if (pageReady) js("window.Orbit&&Orbit.resume()");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // HOME pressed while Orbit is already in front: return to the front of the Now ring.
        if (intent != null && intent.hasCategory(Intent.CATEGORY_HOME) && pageReady && hasWindowFocus()) {
            js("window.Orbit&&Orbit.home()");
        }
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(packageReceiver); } catch (Exception ignored) { }
        if (web != null) { web.removeJavascriptInterface("OrbitNative"); web.destroy(); web = null; }
        super.onDestroy();
    }

    /**
     * Remote keys the WebView doesn't reliably deliver to JavaScript are forwarded by name.
     * D-pad and OK go to the WebView as normal key events.
     */
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
            return true; // a launcher never lets BACK close it
        }
        return super.dispatchKeyEvent(e);
    }

    private void js(final String code) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != null) web.evaluateJavascript(code, null);
            }
        });
    }

    // ------------------------------------------------------------------ local origin

    private WebResourceResponse serve(Uri uri) {
        if (uri == null || !HOST.equals(uri.getHost())) return null;
        String path = uri.getPath();
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        try {
            if (path.startsWith("/icon/")) {
                byte[] png = iconPng(Uri.decode(path.substring(6)));
                if (png == null) return notFound();
                return withHeaders(new WebResourceResponse("image/png", null, new ByteArrayInputStream(png)));
            }
            String name = path.substring(1);
            InputStream in = getAssets().open(name);
            return withHeaders(new WebResourceResponse(mime(name), "utf-8", in));
        } catch (IOException e) {
            return notFound();
        }
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

    private byte[] iconPng(String pkg) {
        byte[] cached = iconCache.get(pkg);
        if (cached != null) return cached;
        PackageManager pm = getPackageManager();
        Drawable d = null;
        try {
            Intent launch = pm.getLeanbackLaunchIntentForPackage(pkg);
            if (launch == null) launch = pm.getLaunchIntentForPackage(pkg);
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
            JSONArray arr = new JSONArray();
            try {
                for (Map.Entry<String, String> e : found.entrySet()) {
                    JSONObject o = new JSONObject();
                    o.put("pkg", e.getKey());
                    o.put("label", e.getValue());
                    o.put("icon", BASE + "icon/" + Uri.encode(e.getKey()));
                    arr.put(o);
                }
            } catch (Exception ignored) { }
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
        public boolean launch(String pkg) {
            PackageManager pm = getPackageManager();
            Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
            if (i == null) i = pm.getLaunchIntentForPackage(pkg);
            if (i == null) return false;
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
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
        public String load(String key) {
            return prefs.getString(key, null);
        }

        @JavascriptInterface
        public void save(String key, String value) {
            prefs.edit().putString(key, value).apply();
        }

        private void start(final Intent i) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try { startActivity(i); } catch (Exception ignored) { }
                }
            });
        }
    }
}
