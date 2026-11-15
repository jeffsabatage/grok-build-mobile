package com.sabatage.grokremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

public class KeepAliveService extends Service {
  public static final String CHANNEL = "grok-remote-lock";
  public static final String ACTION_GLANCE = "com.sabatage.grokremote.GLANCE";
  public static final String ACTION_STOP = "com.sabatage.grokremote.STOP";
  public static final String ACTION_QUEUE = "com.sabatage.grokremote.QUEUE";
  public static final String EXTRA_TEXT = "text";
  private static final int NOTE_ID = 42;
  private String glance = "Listening for Grok on this Wi‑Fi";
  private final LinkedHashMap<String, Integer> noteIds = new LinkedHashMap<>();
  private final HashSet<Integer> posted = new HashSet<>();
  private int foregroundId = NOTE_ID;
  private Bitmap largeIcon;

  @Override
  public void onCreate() {
    super.onCreate();
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (Build.VERSION.SDK_INT >= 26 && nm != null) {
      NotificationChannel ch = new NotificationChannel(
        CHANNEL,
        "Lock screen",
        NotificationManager.IMPORTANCE_LOW
      );
      ch.setShowBadge(false);
      ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
      ch.setSound(null, null);
      ch.enableVibration(false);
      ch.setDescription("One card per running session, with the latest line from that chat.");
      nm.createNotificationChannel(ch);
    }
    startForeground(NOTE_ID, buildNote(glance));
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && ACTION_STOP.equals(intent.getAction())) {
      String sid = intent.getStringExtra("sessionId");
      stopOnGateway(sid);
      renderFromPrefs();
      return START_STICKY;
    }
    if (intent != null && ACTION_QUEUE.equals(intent.getAction())) {
      queueOnGateway(intent.getStringExtra("sessionId"), intent.getStringExtra("queueId"), intent.getStringExtra("queueOp"));
      renderFromPrefs();
      return START_STICKY;
    }
    if (intent != null && ACTION_GLANCE.equals(intent.getAction())) {
      String text = intent.getStringExtra(EXTRA_TEXT);
      if (text != null && !text.trim().isEmpty()) glance = text.trim();
      renderFromPrefs();
    }
    return START_STICKY;
  }

  private void stopOnGateway(String sid) {
    postGateway(sid, "/cancel", "");
  }

  private void queueOnGateway(String sid, String queueId, String op) {
    String action = "cancel".equals(op) ? "cancel" : "start";
    String id = queueId == null ? "" : queueId.replace("\\", "\\\\").replace("\"", "\\\"");
    postGateway(sid, "/queue", "{\"action\":\"" + action + "\",\"id\":\"" + id + "\"}");
  }

  private void postGateway(String sid, String path, String json) {
    final String sessionId = sid == null ? "" : sid;
    final String body = json == null ? "" : json;
    new Thread(() -> {
      HttpURLConnection conn = null;
      try {
        SharedPreferences p = getSharedPreferences(GlancePlugin.PREFS, MODE_PRIVATE);
        String base = p.getString("gateway", "");
        String secret = p.getString("secret", "");
        String session = sessionId.isEmpty() ? p.getString("sessionId", "") : sessionId;
        if (base == null || secret == null || session == null) return;
        if (base.isEmpty() || secret.isEmpty() || session.isEmpty()) return;
        String url = base.replaceAll("/$", "")
          + "/api/sessions/" + URLEncoder.encode(session, "UTF-8")
          + path + "?secret=" + URLEncoder.encode(secret, "UTF-8");
        conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(4000);
        conn.setReadTimeout(4000);
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        OutputStream out = conn.getOutputStream();
        out.write(body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        out.close();
        conn.getResponseCode();
      } catch (Exception ignored) {
        /* the in-app buttons still work */
      } finally {
        if (conn != null) conn.disconnect();
      }
    }, "grok-lock").start();
  }

  private void renderFromPrefs() {
    SharedPreferences p = getSharedPreferences(GlancePlugin.PREFS, MODE_PRIVATE);
    String raw = p.getString("cards", "");
    JSONArray arr = null;
    if (raw != null && !raw.trim().isEmpty()) {
      try {
        arr = new JSONArray(raw);
      } catch (Exception ignored) {
        arr = null;
      }
    }
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (arr == null || arr.length() == 0) {
      cancelPostedExcept(nm, NOTE_ID);
      startForeground(NOTE_ID, buildNote(glance));
      foregroundId = NOTE_ID;
      posted.clear();
      posted.add(NOTE_ID);
      return;
    }
    int count = Math.min(arr.length(), 8);
    HashSet<Integer> keep = new HashSet<>();
    HashSet<String> live = new HashSet<>();
    boolean started = false;
    for (int i = 0; i < count; i++) {
      JSONObject card = arr.optJSONObject(i);
      if (card == null) continue;
      String sid = card.optString("sessionId", "");
      live.add(sid);
      int id = noteIdFor(sid);
      keep.add(id);
      Notification note = buildCard(card, id);
      if (!started) {
        startForeground(id, note);
        foregroundId = id;
        started = true;
      } else if (nm != null) {
        nm.notify(id, note);
      }
    }
    if (keep.isEmpty()) {
      startForeground(NOTE_ID, buildNote(glance));
      foregroundId = NOTE_ID;
      keep.add(NOTE_ID);
    }
    for (Integer old : new HashSet<>(posted)) {
      if (!keep.contains(old) && nm != null) nm.cancel(old);
    }
    if (foregroundId != NOTE_ID && nm != null) nm.cancel(NOTE_ID);
    posted.clear();
    posted.addAll(keep);
    Iterator<Map.Entry<String, Integer>> it = noteIds.entrySet().iterator();
    while (it.hasNext()) {
      if (!live.contains(it.next().getKey())) it.remove();
    }
  }

  private void cancelPostedExcept(NotificationManager nm, int keepId) {
    if (nm == null) return;
    for (Integer old : new HashSet<>(posted)) {
      if (old != keepId) nm.cancel(old);
    }
  }

  private int noteIdFor(String sid) {
    String key = sid == null || sid.isEmpty() ? "_" : sid;
    Integer have = noteIds.get(key);
    if (have != null) return have;
    int hash = 0;
    for (int i = 0; i < key.length(); i++) hash = (hash * 33 + key.charAt(i)) & 0x7fffffff;
    int id = 4200 + (hash % 40);
    HashSet<Integer> used = new HashSet<>(noteIds.values());
    while (used.contains(id) || id == NOTE_ID) id++;
    noteIds.put(key, id);
    return id;
  }

  private Bitmap icon() {
    if (largeIcon == null) {
      largeIcon = BitmapFactory.decodeResource(getResources(), R.drawable.ic_grok_remote);
    }
    return largeIcon;
  }

  private Notification buildCard(JSONObject card, int id) {
    String title = card.optString("title", "Grok Remote");
    String status = card.optString("status", "");
    String last = card.optString("lastLine", "");
    String sessionId = card.optString("sessionId", "");
    boolean working = card.optBoolean("working", false);
    String queueId = card.optString("queueId", "");
    String queueText = card.optString("queueText", "");
    String note = card.optString("note", "");
    if (title == null || title.trim().isEmpty()) title = "Grok Remote";
    if (status == null) status = "";
    if (last == null) last = "";
    String line = last.trim();
    if (line.isEmpty()) line = status.trim();
    if (line.isEmpty()) line = glance;
    String big = line;
    if (queueText != null && !queueText.trim().isEmpty()) big = big + "\nQueued: " + queueText.trim();
    if (note != null && !note.trim().isEmpty()) big = big + "\nNote: " + note.trim();
    NotificationCompat.Builder builder = baseBuilder(title, line, big, sessionId, id);
    if (!status.trim().isEmpty() && !last.trim().isEmpty()) builder.setSubText(status.trim());
    if (working && sessionId != null && !sessionId.isEmpty()) {
      builder.addAction(android.R.drawable.ic_media_pause, "Stop", serviceAction(ACTION_STOP, sessionId, "", "", id + 1000));
    }
    if (queueId != null && !queueId.isEmpty() && sessionId != null && !sessionId.isEmpty()) {
      builder.addAction(0, "Send now", serviceAction(ACTION_QUEUE, sessionId, queueId, "start", id + 2000));
      builder.addAction(0, "Cancel", serviceAction(ACTION_QUEUE, sessionId, queueId, "cancel", id + 3000));
    }
    return builder.build();
  }

  private NotificationCompat.Builder baseBuilder(String title, String line, String big, String sessionId, int request) {
    Intent launch = new Intent(this, MainActivity.class);
    launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    launch.putExtra("sessionId", sessionId == null ? "" : sessionId);
    launch.setData(Uri.parse("grokremote://note/" + request));
    PendingIntent pi = PendingIntent.getActivity(
      this,
      request,
      launch,
      PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
    );
    return new NotificationCompat.Builder(this, CHANNEL)
      .setContentTitle(title)
      .setContentText(line)
      .setStyle(new NotificationCompat.BigTextStyle().setBigContentTitle(title).bigText(big))
      .setSmallIcon(R.drawable.ic_stat_grok_remote)
      .setColor(0xFF7AA2FF)
      .setLargeIcon(icon())
      .setContentIntent(pi)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setSilent(true)
      .setOnlyAlertOnce(true);
  }

  private PendingIntent serviceAction(String action, String sessionId, String queueId, String op, int request) {
    Intent q = new Intent(this, KeepAliveService.class);
    q.setAction(action);
    q.putExtra("sessionId", sessionId);
    q.putExtra("queueId", queueId == null ? "" : queueId);
    q.putExtra("queueOp", op == null ? "" : op);
    q.setData(Uri.parse("grokremote://act/" + request));
    return PendingIntent.getService(
      this,
      request,
      q,
      PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
    );
  }

  private Notification buildNote(String fallback) {
    SharedPreferences p = getSharedPreferences(GlancePlugin.PREFS, MODE_PRIVATE);
    String title = p.getString("title", "Grok Remote");
    String status = p.getString("status", "");
    String last = p.getString("lastLine", "");
    String sessionId = p.getString("sessionId", "");
    boolean working = p.getBoolean("working", false);
    String queueId = p.getString("queueId", "");
    String queueText = p.getString("queueText", "");
    String note = p.getString("note", "");
    if (title == null || title.trim().isEmpty()) title = "Grok Remote";
    if (status == null) status = "";
    if (last == null) last = "";
    String line = last.trim();
    if (line.isEmpty()) line = status.trim();
    if (line.isEmpty()) line = fallback == null ? "" : fallback;
    String big = line;
    if (queueText != null && !queueText.trim().isEmpty()) big = big + "\nQueued: " + queueText.trim();
    if (note != null && !note.trim().isEmpty()) big = big + "\nNote: " + note.trim();
    NotificationCompat.Builder builder = baseBuilder(title, line, big, sessionId, NOTE_ID);
    if (!status.trim().isEmpty() && !last.trim().isEmpty()) builder.setSubText(status.trim());
    if (working && sessionId != null && !sessionId.isEmpty()) {
      builder.addAction(android.R.drawable.ic_media_pause, "Stop", serviceAction(ACTION_STOP, sessionId, "", "", NOTE_ID + 1000));
    }
    if (queueId != null && !queueId.isEmpty() && sessionId != null && !sessionId.isEmpty()) {
      builder.addAction(0, "Send now", serviceAction(ACTION_QUEUE, sessionId, queueId, "start", NOTE_ID + 2000));
      builder.addAction(0, "Cancel", serviceAction(ACTION_QUEUE, sessionId, queueId, "cancel", NOTE_ID + 3000));
    }
    return builder.build();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
