package com.kdh1207.budgetnoti;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/** 알림 내용을 가계부 서버(구글 Apps Script)로 보낸다. 실패하면 대기열에 남겨 두고 나중에 다시 보낸다. */
final class Sender {
    /** 금액이 들어 있는 알림만 보낸다 (광고·인증번호 등은 휴대폰에서 바로 거른다). */
    private static final Pattern MONEY = Pattern.compile("[0-9][0-9,]*\\s*원");

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private Sender() {}

    static boolean looksLikeMoney(String body) {
        return body != null && MONEY.matcher(body).find();
    }

    /** 새 알림: 대기열에 넣고 대기열 전체를 보낸다. */
    static void enqueue(Context context, String body) {
        Prefs prefs = new Prefs(context);
        prefs.addPending(body);
        flush(context);
    }

    /** 대기열에 남은 알림을 모두 보낸다. */
    static void flush(Context context) {
        final Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            Prefs prefs = new Prefs(app);
            String url = prefs.url();
            if (url.isEmpty()) return;
            for (String body : prefs.pending()) {
                Result r = post(url, body);
                if (r.retry) break; // 인터넷이 안 되면 다음 기회에
                prefs.removePending(body);
                prefs.log(preview(body), r.message);
            }
        });
    }

    /** 결과 */
    static final class Result {
        final boolean retry;
        final String message;

        Result(boolean retry, String message) {
            this.retry = retry;
            this.message = message;
        }
    }

    /** 서버로 한 건 보낸다. 화면의 "연결 테스트"에서도 쓴다. (메인 스레드에서 부르지 말 것) */
    static Result post(String url, String body) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            conn.setInstanceFollowRedirects(true);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "text/plain; charset=utf-8");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }
            int code = conn.getResponseCode();
            // 구글 Apps Script 는 처리 후 결과 주소로 넘겨준다(302). 이미 처리되었으므로 성공으로 본다.
            if (code == 301 || code == 302 || code == 303) return new Result(false, "보냄");
            if (code >= 500 || code == 429) return new Result(true, "서버 오류 " + code);
            String text = read(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
            if (code >= 400) return new Result(false, "실패 (HTTP " + code + ")");
            return new Result(false, describe(text));
        } catch (Exception e) {
            return new Result(true, "연결 실패: " + e.getClass().getSimpleName());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String describe(String json) {
        try {
            JSONObject o = new JSONObject(json);
            if (!o.optBoolean("ok")) {
                String err = o.optString("error");
                return "unauthorized".equals(err) ? "접속 키가 맞지 않아요 (주소를 다시 연결하세요)" : "실패: " + err;
            }
            if (o.optBoolean("saved")) return "기록됨";
            String reason = o.optString("reason");
            if ("duplicate".equals(reason)) return "이미 있는 내역";
            if ("not_transaction".equals(reason)) return "거래 아님 (무시)";
            return "받음";
        } catch (Exception e) {
            return "보냄 (응답 확인 불가)";
        }
    }

    private static String read(InputStream in) throws java.io.IOException {
        if (in == null) return "";
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    static String preview(String body) {
        String one = body.replace('\n', ' ').trim();
        return one.length() > 60 ? one.substring(0, 60) + "…" : one;
    }
}
