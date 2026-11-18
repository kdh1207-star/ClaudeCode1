package com.kdh1207.budget;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Scanner;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 가계부 화면(docs/index.html)을 앱 안에 넣어 주소창 없이 보여준다.
 * https://appassets.androidplatform.net/assets/ 주소로 열어서 저장(localStorage)과 서버 통신이 웹과 똑같이 된다.
 */
public class MainActivity extends Activity {
    private static final String HOME = "https://appassets.androidplatform.net/assets/index.html";
    private static final String RELEASE_API = "https://api.github.com/repos/kdh1207-star/ClaudeCode1/releases/tags/budget-app";
    private static final String APK_URL = "https://github.com/kdh1207-star/ClaudeCode1/releases/download/budget-app/budget-app.apk";
    private static final int PICK_FILE = 1;

    private WebView web;
    private ValueCallback<Uri[]> pending;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        WebView.setWebContentsDebuggingEnabled(false);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return assets.shouldInterceptRequest(req.getUrl());
            }

            // 앱 화면 밖으로 가는 링크(도움말, 다운로드 등)는 브라우저로
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                openOutside(u);
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // 거래내역 파일 가져오기
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (pending != null) pending.onReceiveValue(null);
                pending = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "거래내역 파일 선택"), PICK_FILE);
                } catch (Exception e) {
                    pending = null;
                    return false;
                }
                return true;
            }

        });
        // target=_blank 링크도 같은 창에서 열려고 하므로 위의 shouldOverrideUrlLoading 이 브라우저로 넘긴다
        s.setSupportMultipleWindows(false);

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(startUrl(getIntent()));
        checkUpdate();
    }

    // budgetapp://connect#<값> 으로 열리면 화면의 #connect= 로 넘겨 서버 주소·접속 키를 저장하게 한다
    private String startUrl(Intent intent) {
        Uri u = intent == null ? null : intent.getData();
        if (u != null && "budgetapp".equals(u.getScheme())) {
            String v = u.getFragment();
            if (v == null) v = u.getQueryParameter("d");
            if (v != null && v.matches("[A-Za-z0-9_-]+")) return HOME + "#connect=" + v;
        }
        return HOME;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) web.loadUrl(startUrl(intent));
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == PICK_FILE && pending != null) {
            Uri u = res == RESULT_OK && data != null ? data.getData() : null;
            pending.onReceiveValue(u == null ? null : new Uri[]{u});
            pending = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private void openOutside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception ignored) {
        }
    }

    // 새 버전이 올라왔으면 받을지 묻는다 (릴리스 제목의 "빌드 N" 과 이 앱의 버전 번호 비교)
    private void checkUpdate() {
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(RELEASE_API).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestProperty("Accept", "application/vnd.github+json");
                if (c.getResponseCode() != 200) return;
                String body;
                try (InputStream in = c.getInputStream(); Scanner sc = new Scanner(in, "UTF-8").useDelimiter("\\A")) {
                    body = sc.hasNext() ? sc.next() : "";
                }
                Matcher m = Pattern.compile("\"name\"\\s*:\\s*\"[^\"]*빌드 (\\d+)").matcher(body);
                if (!m.find()) return;
                int latest = Integer.parseInt(m.group(1));
                int mine = getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
                if (latest <= mine) return;
                runOnUiThread(() -> new AlertDialog.Builder(this)
                        .setTitle("새 버전이 있어요")
                        .setMessage("가계부 앱 새 버전(빌드 " + latest + ")을 받을까요? 받은 파일을 열어 설치하면 데이터는 그대로 남아요.")
                        .setPositiveButton("받기", (d, w) -> openOutside(Uri.parse(APK_URL)))
                        .setNegativeButton("나중에", null)
                        .show());
            } catch (Exception ignored) {
            }
        }).start();
    }
}
