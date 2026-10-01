package com.kdh1207.budgetnoti;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

/**
 * 휴대폰에 새로 뜨는 알림을 받아, 고른 앱(기본: 카카오뱅크)의 금액이 들어 있는 알림만 가계부 서버로 보낸다.
 * 알림 접근 권한을 허용해야 안드로이드가 이 서비스를 실행해 준다.
 */
public class ForwarderService extends NotificationListenerService {

    @Override
    public void onListenerConnected() {
        Sender.flush(this); // 꺼져 있던 동안 못 보낸 것 다시 보내기
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn == null || sbn.getPackageName() == null) return;
        String pkg = sbn.getPackageName();
        if (pkg.equals(getPackageName())) return;

        Prefs prefs = new Prefs(this);
        prefs.rememberSeen(pkg);
        if (!prefs.selected().contains(pkg)) return;

        Notification n = sbn.getNotification();
        if (n == null || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        String body = textOf(n);
        if (!Sender.looksLikeMoney(body)) return;
        // 문자 앱은 은행·결제 관련 단어가 있는 것만 (광고·개인 문자 거르기)
        if (Prefs.isSmsApp(this, pkg) && !prefs.matchesKeywords(body)) return;
        // 같은 알림이 갱신되며 여러 번 오는 경우 한 번만 보낸다
        if (prefs.seenRecently(pkg + "|" + body)) return;
        Sender.enqueue(this, body);
    }

    /** 알림 제목과 내용(펼친 내용이 있으면 그것)을 줄바꿈으로 합친다. */
    static String textOf(Notification n) {
        Bundle ex = n.extras;
        if (ex == null) return "";
        CharSequence title = ex.getCharSequence(Notification.EXTRA_TITLE);
        CharSequence big = ex.getCharSequence(Notification.EXTRA_BIG_TEXT);
        CharSequence text = ex.getCharSequence(Notification.EXTRA_TEXT);
        CharSequence[] lines = ex.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
        StringBuilder sb = new StringBuilder();
        if (title != null) sb.append(title);
        // 문자 앱의 대화형 알림은 본문이 "새 메시지 2개" 같은 요약일 수 있어, 가장 최근 메시지를 직접 꺼낸다
        CharSequence latest = latestMessage(ex);
        CharSequence main = latest != null ? latest : big != null && big.length() > 0 ? big : text;
        if (main != null && main.length() > 0) {
            if (sb.length() > 0) sb.append('\n');
            sb.append(main);
        } else if (lines != null) {
            for (CharSequence l : lines) {
                if (sb.length() > 0) sb.append('\n');
                sb.append(l);
            }
        }
        return sb.toString().trim();
    }

    private static CharSequence latestMessage(Bundle ex) {
        android.os.Parcelable[] msgs = ex.getParcelableArray(Notification.EXTRA_MESSAGES);
        if (msgs == null || msgs.length == 0) return null;
        android.os.Parcelable last = msgs[msgs.length - 1];
        if (!(last instanceof Bundle)) return null;
        CharSequence t = ((Bundle) last).getCharSequence("text");
        return t != null && t.length() > 0 ? t : null;
    }
}
