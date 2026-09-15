package com.sabatage.grokremote;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.speech.RecognizerIntent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.Locale;

@CapacitorPlugin(
    name = "GrokSpeech",
    permissions = { @Permission(alias = "speech", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class SpeechPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("speech") != PermissionState.GRANTED) {
            requestPermissionForAlias("speech", call, "permDone");
            return;
        }
        launch(call);
    }

    @PermissionCallback
    private void permDone(PluginCall call) {
        if (getPermissionState("speech") != PermissionState.GRANTED) {
            call.reject("Microphone permission denied");
            return;
        }
        launch(call);
    }

    private void launch(PluginCall call) {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault());
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak to Grok Remote");
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        try {
            startActivityForResult(call, intent, "speechResult");
        } catch (Exception e) {
            call.reject("No speech recognizer on this phone");
        }
    }

    @ActivityCallback
    private void speechResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("cancelled");
            return;
        }
        ArrayList<String> matches = result.getData().getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        JSObject ret = new JSObject();
        ret.put("text", (matches != null && !matches.isEmpty()) ? matches.get(0) : "");
        call.resolve(ret);
    }
}
