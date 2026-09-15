package com.sabatage.grokremote;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(SpeechPlugin.class);
    super.onCreate(savedInstanceState);
    startKeepAlive();
  }

  @Override
  public void onStart() {
    super.onStart();
    startKeepAlive();
  }

  private void startKeepAlive() {
    Intent i = new Intent(this, KeepAliveService.class);
    if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
    else startService(i);
  }
}
