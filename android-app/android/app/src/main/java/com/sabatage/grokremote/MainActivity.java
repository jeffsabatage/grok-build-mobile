package com.sabatage.grokremote;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;

import com.getcapacitor.BridgeActivity;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(SpeechPlugin.class);
    registerPlugin(GlancePlugin.class);
    super.onCreate(savedInstanceState);
    startKeepAlive();
    handleOpenIntent(getIntent());
  }

  @Override
  public void onStart() {
    super.onStart();
    startKeepAlive();
  }

  @Override
  public void onResume() {
    super.onResume();
    if (HeadsetBridge.enabled) HeadsetBridge.start(this);
  }

  @Override
  public void onPause() {
    HeadsetBridge.stop();
    super.onPause();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    handleOpenIntent(intent);
  }

  private void handleOpenIntent(Intent intent) {
    if (intent == null) return;
    if (Intent.ACTION_SEND.equals(intent.getAction())) {
      handleShare(intent);
      return;
    }
    if (intent.getBooleanExtra("stop", false) || KeepAliveService.ACTION_STOP.equals(intent.getAction())) {
      GlancePlugin.pendingStop = true;
    }
    String sid = intent.getStringExtra("sessionId");
    if (sid != null && !sid.trim().isEmpty()) {
      GlancePlugin.pendingSessionId = sid.trim();
    }
  }

  private void handleShare(Intent intent) {
    Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
    if (uri == null) return;
    try {
      String mime = getContentResolver().getType(uri);
      if (mime == null || !mime.startsWith("image/")) mime = "image/jpeg";
      InputStream in = getContentResolver().openInputStream(uri);
      if (in == null) return;
      ByteArrayOutputStream bos = new ByteArrayOutputStream();
      byte[] buf = new byte[8192];
      int n;
      int total = 0;
      while ((n = in.read(buf)) > 0) {
        total += n;
        if (total > 1500000) {
          in.close();
          GlancePlugin.pendingShareError = "too big";
          GlancePlugin.pendingImage = "";
          return;
        }
        bos.write(buf, 0, n);
      }
      in.close();
      String b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
      GlancePlugin.pendingImage = "data:" + mime + ";base64," + b64;
      GlancePlugin.pendingShareError = "";
    } catch (Exception e) {
      GlancePlugin.pendingShareError = "unreadable";
      GlancePlugin.pendingImage = "";
    }
  }

  private void startKeepAlive() {
    Intent i = new Intent(this, KeepAliveService.class);
    if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
    else startService(i);
  }
}
