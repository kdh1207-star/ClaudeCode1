package com.kdh1207.budgetnoti;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** 앱 설정과 보낼 알림 대기열을 이 휴대폰에만 저장한다. */
final class Prefs {
    static final String KAKAOBANK = "com.kakaobank.channel";

    private static final String NAME = "budgetnoti";
    private static final String URL = "url";
    private static final String SELECTED = "selected";
    private static final String SEEN = "seen";
    private static final String RECENT = "recent";
    private static final String PENDING = "pending";
    private static final String LOG = "log";

    private static final int MAX_SEEN = 30;
    private static final int MAX_RECENT = 40;
    private static final int MAX_PENDING = 200;
    private static final int MAX_LOG = 30;

    private final SharedPreferences sp;

    Prefs(Context context) {
        sp = context.getApplicationContext().getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    // ---------- 서버 주소 ----------

    String url() {
        return sp.getString(URL, "");
    }

    void setUrl(String url) {
        sp.edit().putString(URL, url == null ? "" : url.trim()).apply();
    }

    // ---------- 보낼 앱 ----------

    Set<String> selected() {
        Set<String> def = new HashSet<>();
        def.add(KAKAOBANK);
        return new HashSet<>(sp.getStringSet(SELECTED, def));
    }

    void setSelected(String pkg, boolean on) {
        Set<String> s = selected();
        if (on) s.add(pkg);
        else s.remove(pkg);
        sp.edit().putStringSet(SELECTED, s).apply();
    }

    /** 최근에 알림을 보낸 앱 (패키지 이름만 기억한다). 새로 본 앱이면 true. */
    synchronized boolean rememberSeen(String pkg) {
        List<String> list = readStrings(SEEN);
        boolean isNew = !list.remove(pkg);
        list.add(0, pkg);
        while (list.size() > MAX_SEEN) list.remove(list.size() - 1);
        writeStrings(SEEN, list);
        return isNew;
    }

    List<String> seen() {
        return readStrings(SEEN);
    }

    // ---------- 같은 알림이 갱신되어 두 번 오는 것 막기 ----------

    synchronized boolean seenRecently(String signature) {
        List<String> list = readStrings(RECENT);
        if (list.contains(signature)) return true;
        list.add(0, signature);
        while (list.size() > MAX_RECENT) list.remove(list.size() - 1);
        writeStrings(RECENT, list);
        return false;
    }

    // ---------- 보내지 못한 알림 대기열 ----------

    synchronized void addPending(String body) {
        List<String> list = readStrings(PENDING);
        list.add(body);
        while (list.size() > MAX_PENDING) list.remove(0);
        writeStrings(PENDING, list);
    }

    synchronized List<String> pending() {
        return readStrings(PENDING);
    }

    synchronized void removePending(String body) {
        List<String> list = readStrings(PENDING);
        list.remove(body);
        writeStrings(PENDING, list);
    }

    // ---------- 최근 기록 ----------

    synchronized void log(String preview, String result) {
        JSONArray arr = readArray(LOG);
        JSONArray out = new JSONArray();
        try {
            JSONObject o = new JSONObject();
            o.put("t", System.currentTimeMillis());
            o.put("p", preview);
            o.put("r", result);
            out.put(o);
            for (int i = 0; i < arr.length() && out.length() < MAX_LOG; i++) out.put(arr.get(i));
        } catch (JSONException ignored) {
        }
        sp.edit().putString(LOG, out.toString()).apply();
    }

    JSONArray logs() {
        return readArray(LOG);
    }

    // ---------- 저장 도우미 ----------

    private JSONArray readArray(String key) {
        try {
            return new JSONArray(sp.getString(key, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private List<String> readStrings(String key) {
        JSONArray arr = readArray(key);
        List<String> out = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) out.add(arr.optString(i));
        return out;
    }

    private void writeStrings(String key, List<String> list) {
        sp.edit().putString(key, new JSONArray(list).toString()).apply();
    }
}
