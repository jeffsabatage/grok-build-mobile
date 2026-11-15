package com.sabatage.grokremote;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.widget.RemoteViews;

public class GrokWidgetProvider extends AppWidgetProvider {
  @Override
  public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
    for (int id : ids) updateOne(context, mgr, id);
  }

  public static void updateAll(Context context) {
    AppWidgetManager mgr = AppWidgetManager.getInstance(context);
    int[] ids = mgr.getAppWidgetIds(new ComponentName(context, GrokWidgetProvider.class));
    if (ids == null) return;
    for (int id : ids) updateOne(context, mgr, id);
  }

  static void updateOne(Context context, AppWidgetManager mgr, int appWidgetId) {
    SharedPreferences p = context.getSharedPreferences(GlancePlugin.PREFS, Context.MODE_PRIVATE);
    String title = p.getString("title", "Grok Remote");
    String status = p.getString("status", "Idle");
    String last = p.getString("lastLine", "");
    String text = p.getString("text", "Listening for Grok on this Wi‑Fi");
    String sessionId = p.getString("sessionId", "");
    if (last == null || last.trim().isEmpty()) last = text;

    RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.grok_widget);
    views.setTextViewText(R.id.widget_title, title == null || title.isEmpty() ? "Grok Remote" : title);
    views.setTextViewText(R.id.widget_status, status == null || status.isEmpty() ? "Idle" : status);
    views.setTextViewText(R.id.widget_last, last);

    int statusColor = 0xFF7AA2FF;
    String st = status == null ? "" : status.toLowerCase();
    if (st.contains("need")) statusColor = 0xFFF5C14A;
    else if (st.contains("work")) statusColor = 0xFF3DD68C;
    views.setTextColor(R.id.widget_status, statusColor);

    Intent launch = new Intent(context, MainActivity.class);
    launch.setAction(Intent.ACTION_MAIN);
    launch.addCategory(Intent.CATEGORY_LAUNCHER);
    launch.putExtra("sessionId", sessionId == null ? "" : sessionId);
    launch.setData(Uri.parse("grokremote://widget/" + appWidgetId));
    launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent pi = PendingIntent.getActivity(context, appWidgetId, launch, flags);
    views.setOnClickPendingIntent(R.id.widget_root, pi);
    mgr.updateAppWidget(appWidgetId, views);
  }
}
