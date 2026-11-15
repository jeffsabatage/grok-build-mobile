package com.sabatage.grokremote;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.WindowManager;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "GrokGlance")
public class GlancePlugin extends Plugin {
  public static final String PREFS = "grok_glance";
  public static volatile String pendingSessionId = "";
  public static volatile boolean pendingStop = false;
  public static volatile String pendingImage = "";
  public static volatile String pendingShareError = "";

  @PluginMethod
  public void setText(PluginCall call) {
    String text = call.getString("text", "Listening for Grok on this Wi‑Fi");
    if (text == null || text.trim().isEmpty()) {
      text = "Listening for Grok on this Wi‑Fi";
    }
    String title = call.getString("title", "Grok Remote");
    String status = call.getString("status", "");
    String lastLine = call.getString("lastLine", "");
    String sessionId = call.getString("sessionId", "");
    Boolean working = call.getBoolean("working");
    String gateway = call.getString("gateway", "");
    String secret = call.getString("secret", "");
    String queueId = call.getString("queueId", "");
    String queueText = call.getString("queueText", "");
    String note = call.getString("note", "");
    String cards = call.getString("cards", "");
    SharedPreferences p = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    SharedPreferences.Editor ed = p.edit()
      .putString("text", text)
      .putString("title", title == null || title.isEmpty() ? "Grok Remote" : title)
      .putString("status", status == null ? "" : status)
      .putString("lastLine", lastLine == null ? "" : lastLine)
      .putString("sessionId", sessionId == null ? "" : sessionId)
      .putBoolean("working", working != null && working)
      .putString("queueId", queueId == null ? "" : queueId)
      .putString("queueText", queueText == null ? "" : queueText)
      .putString("note", note == null ? "" : note)
      .putString("cards", cards == null ? "" : cards);
    if (gateway != null && !gateway.isEmpty()) ed.putString("gateway", gateway);
    if (secret != null && !secret.isEmpty()) ed.putString("secret", secret);
    ed.apply();
    Intent i = new Intent(getContext(), KeepAliveService.class);
    i.setAction(KeepAliveService.ACTION_GLANCE);
    i.putExtra(KeepAliveService.EXTRA_TEXT, text);
    try {
      if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
      else getContext().startService(i);
    } catch (Exception e) {
      call.reject(e.getMessage());
      return;
    }
    try {
      GrokWidgetProvider.updateAll(getContext());
    } catch (Exception ignored) {
      /* no widget placed yet */
    }
    call.resolve();
  }

  @Override
  public void load() {
    HeadsetBridge.onPress = () -> {
      JSObject data = new JSObject();
      data.put("at", System.currentTimeMillis());
      notifyListeners("headset", data);
    };
  }

  @PluginMethod
  public void setAwake(PluginCall call) {
    Boolean awake = call.getBoolean("awake");
    boolean on = awake != null && awake;
    android.app.Activity activity = getActivity();
    if (activity == null) {
      call.resolve();
      return;
    }
    activity.runOnUiThread(() -> {
      if (on) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
      else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
      call.resolve();
    });
  }

  @PluginMethod
  public void setHeadset(PluginCall call) {
    Boolean enabled = call.getBoolean("enabled");
    boolean on = enabled == null || enabled;
    HeadsetBridge.enabled = on;
    if (!on) HeadsetBridge.stop();
    else if (getActivity() != null) HeadsetBridge.start(getActivity());
    call.resolve();
  }

  @PluginMethod
  public void getPendingOpen(PluginCall call) {
    JSObject r = new JSObject();
    String id = pendingSessionId == null ? "" : pendingSessionId;
    pendingSessionId = "";
    r.put("sessionId", id);
    r.put("stop", pendingStop);
    pendingStop = false;
    call.resolve(r);
  }

  @PluginMethod
  public void downloadApk(PluginCall call) {
    String raw = call.getString("url", "");
    HttpURLConnection conn = null;
    File part = null;
    try {
      URL url = localApkUrl(raw);
      File dir = new File(getContext().getCacheDir(), "updates");
      if (!dir.exists() && !dir.mkdirs()) throw new Exception("Could not save the update.");
      part = new File(dir, "Grok-Remote.apk.part");
      File dest = new File(dir, "Grok-Remote.apk");
      conn = openLocal(url, 0);
      int code = conn.getResponseCode();
      if (code != 200) throw new Exception("Could not download the update.");
      InputStream in = conn.getInputStream();
      FileOutputStream out = new FileOutputStream(part);
      byte[] buf = new byte[16384];
      long total = 0;
      int n = readSome(in, buf, 4);
      if (n < 4 || buf[0] != 'P' || buf[1] != 'K') {
        out.close();
        in.close();
        throw new Exception("The file from this PC is not an app package.");
      }
      while (n > 0) {
        total += n;
        if (total > 80L * 1024L * 1024L) {
          out.close();
          in.close();
          throw new Exception("Could not download the update.");
        }
        out.write(buf, 0, n);
        n = in.read(buf);
      }
      out.close();
      in.close();
      conn.disconnect();
      conn = null;
      if (dest.exists() && !dest.delete()) throw new Exception("Could not save the update.");
      if (!part.renameTo(dest)) throw new Exception("Could not save the update.");
      part = null;
      boolean needs = needsInstallPermission();
      boolean opened = false;
      if (needs) openInstallSettings();
      else opened = openInstaller(dest);
      JSObject res = new JSObject();
      res.put("ok", true);
      res.put("bytes", total);
      res.put("opened", opened);
      res.put("needsPermission", needs);
      call.resolve(res);
    } catch (Exception e) {
      String msg = e.getMessage();
      if (msg == null || msg.isEmpty()) msg = "Could not download the update.";
      call.reject(msg);
    } finally {
      if (conn != null) conn.disconnect();
      if (part != null && part.exists()) part.delete();
    }
  }

  private int readSome(InputStream in, byte[] buf, int need) throws Exception {
    int filled = 0;
    while (filled < need) {
      int n = in.read(buf, filled, buf.length - filled);
      if (n < 0) break;
      filled += n;
    }
    return filled;
  }

  private boolean needsInstallPermission() {
    if (Build.VERSION.SDK_INT < 26) return false;
    return !getContext().getPackageManager().canRequestPackageInstalls();
  }

  private void openInstallSettings() {
    Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
    intent.setData(Uri.parse("package:" + getContext().getPackageName()));
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    getContext().startActivity(intent);
  }

  private boolean openInstaller(File file) {
    Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
    Intent intent = new Intent(Intent.ACTION_VIEW);
    intent.setDataAndType(uri, "application/vnd.android.package-archive");
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    getContext().startActivity(intent);
    return true;
  }

  private URL localApkUrl(String raw) throws Exception {
    if (raw == null || raw.contains("..")) throw new Exception("Updates download only from this PC.");
    URL url = new URL(raw.trim());
    String protocol = url.getProtocol();
    if (!"http".equals(protocol) && !"https".equals(protocol)) {
      throw new Exception("Updates download only from this PC.");
    }
    if (url.getUserInfo() != null) throw new Exception("Updates download only from this PC.");
    if (!isPrivateHost(url.getHost())) throw new Exception("Updates download only from this PC.");
    String path = url.getPath() == null ? "" : url.getPath();
    if (path.contains("..") || !path.toLowerCase().endsWith(".apk")) {
      throw new Exception("Updates download only from this PC.");
    }
    return url;
  }

  private HttpURLConnection openLocal(URL url, int hops) throws Exception {
    if (hops > 3) throw new Exception("Could not download the update.");
    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
    conn.setInstanceFollowRedirects(false);
    conn.setConnectTimeout(15000);
    conn.setReadTimeout(120000);
    conn.setRequestProperty("Accept", "application/vnd.android.package-archive");
    int code = conn.getResponseCode();
    if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
      String loc = conn.getHeaderField("Location");
      conn.disconnect();
      if (loc == null || loc.isEmpty()) throw new Exception("Could not download the update.");
      return openLocal(localApkUrl(new URL(url, loc).toString()), hops + 1);
    }
    return conn;
  }

  private boolean isPrivateHost(String host) {
    if (host == null) return false;
    String name = host.toLowerCase();
    if (name.equals("localhost")) return true;
    String[] parts = name.split("\\.");
    if (parts.length != 4) return false;
    int[] n = new int[4];
    for (int i = 0; i < 4; i++) {
      try {
        n[i] = Integer.parseInt(parts[i]);
      } catch (NumberFormatException e) {
        return false;
      }
      if (n[i] < 0 || n[i] > 255) return false;
    }
    if (n[0] == 10 || n[0] == 127) return true;
    if (n[0] == 192 && n[1] == 168) return true;
    if (n[0] == 172 && n[1] >= 16 && n[1] <= 31) return true;
    return false;
  }

  @PluginMethod
  public void getPendingShare(PluginCall call) {
    JSObject r = new JSObject();
    String data = pendingImage == null ? "" : pendingImage;
    String err = pendingShareError == null ? "" : pendingShareError;
    pendingImage = "";
    pendingShareError = "";
    r.put("dataUrl", data);
    r.put("error", err);
    call.resolve(r);
  }
}
