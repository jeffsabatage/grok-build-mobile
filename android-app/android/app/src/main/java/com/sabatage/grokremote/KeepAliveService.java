package com.sabatage.grokremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

public class KeepAliveService extends Service {
  public static final String CHANNEL = "grok-remote-fg";
  private static final int NOTE_ID = 42;

  @Override
  public void onCreate() {
    super.onCreate();
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (Build.VERSION.SDK_INT >= 26 && nm != null) {
      NotificationChannel ch = new NotificationChannel(
        CHANNEL,
        "Connection",
        NotificationManager.IMPORTANCE_MIN
      );
      ch.setShowBadge(false);
      ch.setDescription("Keeps the LAN socket alive. Not an alert.");
      nm.createNotificationChannel(ch);
    }
    Intent launch = new Intent(this, MainActivity.class);
    launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent pi = PendingIntent.getActivity(
      this,
      0,
      launch,
      PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
    );
    Notification n = new NotificationCompat.Builder(this, CHANNEL)
      .setContentTitle("Grok Remote")
      .setContentText("Listening for Grok on this Wi‑Fi")
      .setSmallIcon(R.drawable.ic_stat_grok_remote)
      .setColor(0xFF7AA2FF)
      .setLargeIcon(BitmapFactory.decodeResource(getResources(), R.drawable.ic_grok_remote))
      .setContentIntent(pi)
      .setOngoing(true)
      .setSilent(true)
      .build();
    startForeground(NOTE_ID, n);
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    return START_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
