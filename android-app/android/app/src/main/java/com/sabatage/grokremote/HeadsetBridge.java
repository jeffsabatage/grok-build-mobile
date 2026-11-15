package com.sabatage.grokremote;

import android.content.Context;
import android.content.Intent;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.view.KeyEvent;

/** Headset play button dictates while Grok Remote is on screen. */
public final class HeadsetBridge {
  public static volatile boolean enabled = true;
  public static volatile Runnable onPress;
  private static MediaSession session;

  private HeadsetBridge() {}

  public static void start(Context context) {
    if (!enabled || context == null) return;
    stop();
    MediaSession s = new MediaSession(context.getApplicationContext(), "GrokRemote");
    s.setCallback(new MediaSession.Callback() {
      @Override
      public boolean onMediaButtonEvent(Intent intent) {
        if (intent == null) return false;
        KeyEvent ev = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
        if (ev == null || ev.getAction() != KeyEvent.ACTION_DOWN || ev.getRepeatCount() != 0) {
          return true;
        }
        int key = ev.getKeyCode();
        if (key == KeyEvent.KEYCODE_HEADSETHOOK
            || key == KeyEvent.KEYCODE_MEDIA_PLAY
            || key == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
          Runnable run = onPress;
          if (run != null) run.run();
          return true;
        }
        return false;
      }
    });
    s.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
    PlaybackState state = new PlaybackState.Builder()
        .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_PAUSE)
        .setState(PlaybackState.STATE_PAUSED, 0, 0)
        .build();
    s.setPlaybackState(state);
    s.setMetadata(new MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, "Grok Remote")
        .putString(MediaMetadata.METADATA_KEY_ARTIST, "Dictate")
        .build());
    s.setActive(true);
    session = s;
  }

  public static void stop() {
    MediaSession s = session;
    session = null;
    if (s == null) return;
    try {
      s.setActive(false);
      s.release();
    } catch (Exception ignored) {
      /* already released */
    }
  }
}
