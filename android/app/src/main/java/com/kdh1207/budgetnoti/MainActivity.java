package com.kdh1207.budgetnoti;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** 설정 화면: 알림 접근 허용 → 서버 주소 → 보낼 앱 → 배터리 → 연결 테스트 → 기록 */
public class MainActivity extends Activity {
    private static final int ACCENT = Color.rgb(42, 120, 214);
    private static final int TEXT2 = Color.rgb(82, 81, 78);
    private static final int OK = Color.rgb(0, 99, 0);
    private static final int BAD = Color.rgb(180, 47, 47);

    private Prefs prefs;
    private LinearLayout root;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = new Prefs(this);
        handleLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleLink(intent);
        render();
    }

    @Override
    protected void onResume() {
        super.onResume();
        Sender.flush(this);
        render();
    }

    /** 가계부 웹 앱의 "알림 앱 연결" 버튼: budgetnoti://setup?url=... */
    private void handleLink(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"budgetnoti".equals(data.getScheme())) return;
        String url = data.getQueryParameter("url");
        if (url != null && url.startsWith("http")) {
            prefs.setUrl(url);
            Toast.makeText(this, "가계부 서버 주소를 받았어요.", Toast.LENGTH_SHORT).show();
        }
    }

    // ---------- 화면 ----------

    private void render() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(244, 244, 241));
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int p = dp(16);
        root.setPadding(p, dp(24), p, dp(32));
        scroll.addView(root);
        setContentView(scroll);

        TextView title = text("가계부 알림 연결", 22, Color.BLACK);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);
        root.addView(text("카카오뱅크 같은 앱의 결제·입출금 알림을 내 가계부(구글 시트)로 보냅니다. 금액(원)이 들어 있는 알림만 보내요.", 14, TEXT2));

        boolean listening = isListenerEnabled();
        boolean hasUrl = !prefs.url().isEmpty();
        boolean battery = isIgnoringBattery();

        // 1. 알림 접근
        LinearLayout c1 = card("① 알림 읽기 허용", listening ? "허용됨" : "아직 허용 안 됨", listening);
        c1.addView(text("목록에서 '가계부 알림 연결'을 켜 주세요. 이 앱은 고른 앱의 알림만 서버로 보냅니다.", 13, TEXT2));
        c1.addView(button(listening ? "설정 다시 열기" : "알림 접근 허용하러 가기", v ->
                startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))));

        // 2. 서버 주소
        LinearLayout c2 = card("② 가계부 서버 주소", hasUrl ? "연결됨" : "주소 필요", hasUrl);
        c2.addView(text("가계부 앱의 설정 → 자동 입력에서 '알림 앱 연결'을 누르면 자동으로 들어와요. 직접 붙여넣어도 돼요.", 13, TEXT2));
        EditText url = new EditText(this);
        url.setText(prefs.url());
        url.setHint("https://script.google.com/macros/s/…/exec?action=sms&key=…");
        url.setTextSize(13);
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        c2.addView(url);
        c2.addView(button("주소 저장", v -> {
            String u = url.getText().toString().trim();
            if (!u.isEmpty() && !u.startsWith("https://")) {
                Toast.makeText(this, "https:// 로 시작하는 주소를 넣어 주세요.", Toast.LENGTH_LONG).show();
                return;
            }
            if (!u.isEmpty() && !u.contains("source=")) u = u + (u.contains("?") ? "&" : "?") + "source=bank";
            prefs.setUrl(u);
            Toast.makeText(this, "저장했어요.", Toast.LENGTH_SHORT).show();
            render();
        }));

        // 3. 보낼 앱
        LinearLayout c3 = card("③ 알림을 보낼 앱", null, true);
        c3.addView(text("기본은 카카오뱅크예요. 다른 은행·카드 앱에서 알림이 한 번 오면 이 목록에 나타나요. 문자 앱을 고르면 '원'이 들어간 모든 문자가 서버로 가니 필요할 때만 켜세요.", 13, TEXT2));
        Set<String> selected = prefs.selected();
        List<String> apps = new ArrayList<>();
        apps.add(Prefs.KAKAOBANK);
        for (String s : selected) if (!apps.contains(s)) apps.add(s);
        for (String s : prefs.seen()) if (!apps.contains(s)) apps.add(s);
        for (String pkg : apps) {
            CheckBox cb = new CheckBox(this);
            cb.setText(appLabel(pkg));
            cb.setTextSize(15);
            cb.setChecked(selected.contains(pkg));
            cb.setOnCheckedChangeListener((b, on) -> prefs.setSelected(pkg, on));
            c3.addView(cb);
        }

        // 4. 배터리
        LinearLayout c4 = card("④ 배터리 제한 해제", battery ? "해제됨" : "권장", battery);
        c4.addView(text("휴대폰이 이 앱을 잠재우면 알림을 놓칠 수 있어요.", 13, TEXT2));
        if (!battery) {
            c4.addView(button("배터리 제한 해제하기", v -> {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
                try {
                    startActivity(i);
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                }
            }));
        }

        // 5. 연결 테스트
        LinearLayout c5 = card("⑤ 연결 테스트", null, true);
        TextView testResult = text("", 13, TEXT2);
        c5.addView(button("테스트 보내기", v -> {
            String u = prefs.url();
            if (u.isEmpty()) {
                testResult.setText("먼저 서버 주소를 넣어 주세요.");
                return;
            }
            testResult.setText("보내는 중…");
            new Thread(() -> {
                Sender.Result r = Sender.post(u, "[가계부 알림 연결] 연결 테스트입니다. 거래가 아니므로 기록되지 않아요.");
                String msg = r.retry ? "연결 실패: " + r.message
                        : r.message.startsWith("실패") || r.message.startsWith("접속 키") ? r.message
                        : "연결 성공! 서버가 응답했어요. (" + r.message + ")";
                runOnUiThread(() -> testResult.setText(msg));
            }).start();
        }));
        c5.addView(testResult);

        // 6. 기록
        int pending = prefs.pending().size();
        LinearLayout c6 = card("최근 보낸 알림", pending > 0 ? "못 보낸 알림 " + pending + "건" : null, pending == 0);
        if (pending > 0) {
            c6.addView(button("지금 다시 보내기", v -> {
                Sender.flush(this);
                Toast.makeText(this, "다시 보내는 중이에요. 잠시 뒤 화면을 다시 열어 보세요.", Toast.LENGTH_SHORT).show();
            }));
        }
        JSONArray logs = prefs.logs();
        if (logs.length() == 0) c6.addView(text("아직 없어요. 카카오뱅크 알림이 오면 여기에 표시돼요.", 13, TEXT2));
        SimpleDateFormat fmt = new SimpleDateFormat("M/d HH:mm", Locale.KOREA);
        for (int i = 0; i < logs.length(); i++) {
            JSONObject o = logs.optJSONObject(i);
            if (o == null) continue;
            c6.addView(text(fmt.format(new Date(o.optLong("t"))) + "  " + o.optString("r") + "\n" + o.optString("p"), 13, Color.DKGRAY));
        }
    }

    // ---------- 상태 ----------

    private boolean isListenerEnabled() {
        String flat = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
        return flat != null && flat.contains(getPackageName());
    }

    private boolean isIgnoringBattery() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    private String appLabel(String pkg) {
        if (Prefs.KAKAOBANK.equals(pkg)) return "카카오뱅크";
        try {
            PackageManager pm = getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            return pm.getApplicationLabel(info) + "  (" + pkg + ")";
        } catch (Exception e) {
            return pkg;
        }
    }

    // ---------- 화면 도우미 ----------

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setPadding(0, dp(4), 0, dp(4));
        t.setLineSpacing(0, 1.15f);
        return t;
    }

    private Button button(String label, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(ACCENT);
        bg.setCornerRadius(dp(10));
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        b.setLayoutParams(lp);
        b.setPadding(dp(16), 0, dp(16), 0);
        b.setOnClickListener(onClick);
        return b;
    }

    private LinearLayout card(String title, String status, boolean good) {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setPadding(dp(16), dp(14), dp(16), dp(14));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setCornerRadius(dp(14));
        c.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(14);
        c.setLayoutParams(lp);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView t = text(title, 16, Color.BLACK);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        head.addView(t);
        if (status != null) {
            TextView s = text((good ? "✓ " : "! ") + status, 13, good ? OK : BAD);
            head.addView(s);
        }
        c.addView(head);
        root.addView(c);
        return c;
    }
}
