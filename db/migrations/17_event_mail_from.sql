-- イベントごとの送信元メールアドレス（確認メール・パスワード再設定メールの From / Reply-To）。
-- オーガナイザーのログイン用メールとは別に、イベント単位で持つ。
-- 新規作成 API では必須。既存イベントは NULL のまま残り、送信時は MAIL_FROM（環境変数）に戻す。
--
-- 依存: 01（events）
-- 再実行: 不可（列が既にあると ALTER がエラーになる）。適用済みか確認してから流す。

ALTER TABLE events ADD COLUMN mail_from VARCHAR(255) NULL AFTER survey_url;
