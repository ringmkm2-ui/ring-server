// ===== Bro Chat i18n module =====
// Supported languages: ja, en, zh-CN, ko
// Usage: add data-i18n="key" to any element (replaces textContent)
//        add data-i18n-placeholder="key" for placeholder attribute
//        add data-i18n-title="key" for title attribute
// Call window.applyI18n() after DOM ready and whenever language changes.

(function () {
  const DICT = {
    // ---------- Common / nav ----------
    about: { ja: "情報", en: "About", "zh-CN": "关于", ko: "정보" },
    basic_settings: { ja: "基本設定", en: "General", "zh-CN": "常规", ko: "일반" },
    blocked: { ja: "ブロック中", en: "Blocked", "zh-CN": "已阻止", ko: "차단됨" },
    call_note: { ja: "通話メモ", en: "Call notes", "zh-CN": "通话笔记", ko: "통화 메모" },
    clear_cache: { ja: "キャッシュを削除", en: "Clear cache", "zh-CN": "清除缓存", ko: "캐시 삭제" },
    enter_auto: { ja: "自動(PCのみ)", en: "Auto (PC only)", "zh-CN": "自动(仅电脑)", ko: "자동(PC만)" },
    enter_to_send: { ja: "Enterで送信", en: "Enter to send", "zh-CN": "回车发送", ko: "Enter로 전송" },
    font_size: { ja: "文字サイズ", en: "Text size", "zh-CN": "字体大小", ko: "글자 크기" },
    theme: { ja: "テーマ", en: "Theme", "zh-CN": "主题", ko: "테마" },
    haptics: { ja: "触覚フィードバック", en: "Haptics", "zh-CN": "触感反馈", ko: "햅틱" },
    live_translate: { ja: "ライブ翻訳", en: "Live translate", "zh-CN": "实时翻译", ko: "실시간 번역" },
    managed_by_app: { ja: "アプリで管理", en: "Managed by app", "zh-CN": "由应用管理", ko: "앱에서 관리" },
    my_id: { ja: "自分のID", en: "My ID", "zh-CN": "我的ID", ko: "내 ID" },
    notifications: { ja: "通知", en: "Notifications", "zh-CN": "通知", ko: "알림" },
    off: { ja: "オフ", en: "Off", "zh-CN": "关", ko: "끔" },
    on: { ja: "オン", en: "On", "zh-CN": "开", ko: "켬" },
    photo_label: { ja: "[画像]", en: "[Photo]", "zh-CN": "[图片]", ko: "[사진]" },
    reply_original_unavailable: { ja: "元のメッセージ", en: "Original message", "zh-CN": "原消息", ko: "원본 메시지" },
    settings: { ja: "設定", en: "Settings", "zh-CN": "设置", ko: "설정" },
    size_large: { ja: "大", en: "Large", "zh-CN": "大", ko: "크게" },
    size_normal: { ja: "標準", en: "Default", "zh-CN": "标准", ko: "기본" },
    size_small: { ja: "小", en: "Small", "zh-CN": "小", ko: "작게" },
    size_xlarge: { ja: "特大", en: "Extra large", "zh-CN": "特大", ko: "아주 크게" },
    storage: { ja: "ストレージ", en: "Storage", "zh-CN": "存储", ko: "저장공간" },
    tap_to_enable: { ja: "タップで許可", en: "Tap to enable", "zh-CN": "点按以允许", ko: "탭하여 허용" },
    version: { ja: "バージョン", en: "Version", "zh-CN": "版本", ko: "버전" },
    video_label: { ja: "[動画]", en: "[Video]", "zh-CN": "[视频]", ko: "[동영상]" },
    you: { ja: "あなた", en: "You", "zh-CN": "你", ko: "나" },
    home: { ja: "ホーム", en: "Home", "zh-CN": "主页", ko: "홈" },
    talk_list: { ja: "トーク一覧", en: "Chats", "zh-CN": "聊天列表", ko: "채팅 목록" },
    talk: { ja: "トーク", en: "Chat", "zh-CN": "聊天", ko: "채팅" },
    search: { ja: "検索", en: "Search", "zh-CN": "搜索", ko: "검색" },
    cancel: { ja: "キャンセル", en: "Cancel", "zh-CN": "取消", ko: "취소" },
    close: { ja: "閉じる", en: "Close", "zh-CN": "关闭", ko: "닫기" },
    confirm: { ja: "確認", en: "Confirm", "zh-CN": "确认", ko: "확인" },
    save: { ja: "保存する", en: "Save", "zh-CN": "保存", ko: "저장" },
    delete: { ja: "削除", en: "Delete", "zh-CN": "删除", ko: "삭제" },
    edit: { ja: "編集する", en: "Edit", "zh-CN": "编辑", ko: "편집" },
    loading: { ja: "読み込み中...", en: "Loading...", "zh-CN": "加载中...", ko: "로딩 중..." },
    logout: { ja: "ログアウト", en: "Log Out", "zh-CN": "退出登录", ko: "로그아웃" },
    login: { ja: "ログイン", en: "Log In", "zh-CN": "登录", ko: "로그인" },
    signup: { ja: "新規登録", en: "Sign Up", "zh-CN": "注册", ko: "회원가입" },
    register: { ja: "登録", en: "Register", "zh-CN": "注册", ko: "등록" },
    or: { ja: "または", en: "or", "zh-CN": "或", ko: "또는" },
    invite: { ja: "招待", en: "Invite", "zh-CN": "邀请", ko: "초대" },

    // ---------- talklist.html ----------
    friends: { ja: "友達", en: "Friends", "zh-CN": "好友", ko: "친구" },
    no_friends: { ja: "友達がいません", en: "No friends yet", "zh-CN": "还没有好友", ko: "친구가 없습니다" },
    add_friend: { ja: "友達を追加", en: "Add Friend", "zh-CN": "添加好友", ko: "친구 추가" },
    friend_requests: { ja: "友達リクエスト", en: "Friend Requests", "zh-CN": "好友请求", ko: "친구 요청" },
    group: { ja: "グループ", en: "Group", "zh-CN": "群组", ko: "그룹" },
    new_group: { ja: "新しいグループ", en: "New Group", "zh-CN": "新建群组", ko: "새 그룹" },
    create_new_group: { ja: "新しいグループを作成", en: "Create New Group", "zh-CN": "创建新群组", ko: "새 그룹 만들기" },
    community: { ja: "コミュニティ", en: "Community", "zh-CN": "社区", ko: "커뮤니티" },
    create_new_community: { ja: "コミュニティを作成", en: "Create Community", "zh-CN": "创建社区", ko: "커뮤니티 만들기" },
    group_name: { ja: "グループ名", en: "Group Name", "zh-CN": "群组名称", ko: "그룹 이름" },
    group_name_placeholder: { ja: "グループ名を入力", en: "Enter group name", "zh-CN": "输入群组名称", ko: "그룹 이름 입력" },
    member_select: { ja: "メンバー選択", en: "Select Members", "zh-CN": "选择成员", ko: "멤버 선택" },
    create_btn: { ja: "作成する", en: "Create", "zh-CN": "创建", ko: "만들기" },
    dark_mode: { ja: "ダークモード", en: "Dark Mode", "zh-CN": "深色模式", ko: "다크 모드" },
    mobile_data_saver: { ja: "モバイルデータ節約", en: "Mobile Data Saver", "zh-CN": "移动数据节省", ko: "모바일 데이터 절약" },
    chat_bg_blur: { ja: "チャット背景をぼかす", en: "Blur chat background", "zh-CN": "模糊聊天背景", ko: "채팅 배경 흐리게" },
    edit_profile: { ja: "プロフィールの編集", en: "Edit Profile", "zh-CN": "编辑资料", ko: "프로필 편집" },
    profile_image: { ja: "プロフィール画像", en: "Profile Picture", "zh-CN": "头像", ko: "프로필 사진" },
    display_name: { ja: "表示名", en: "Display Name", "zh-CN": "显示名称", ko: "표시 이름" },
    my_name: { ja: "マイネーム", en: "My Name", "zh-CN": "我的昵称", ko: "내 이름" },
    global_bg_image: { ja: "全体の背景画像", en: "Global Background", "zh-CN": "全局背景图片", ko: "전체 배경 이미지" },
    select_bg_image: { ja: "背景画像を選択する", en: "Choose Background Image", "zh-CN": "选择背景图片", ko: "배경 이미지 선택" },
    select_image: { ja: "画像を選択する", en: "Choose Image", "zh-CN": "选择图片", ko: "이미지 선택" },
    apply_and_close: { ja: "変更を適用して閉じる", en: "Apply & Close", "zh-CN": "应用并关闭", ko: "적용하고 닫기" },
    post: { ja: "投稿", en: "Post", "zh-CN": "动态", ko: "게시물" },
    post_btn: { ja: "投稿する", en: "Post", "zh-CN": "发布", ko: "게시하기" },
    post_placeholder: { ja: "今なにしてる？", en: "What's on your mind?", "zh-CN": "在想什么呢？", ko: "무슨 생각을 하고 있나요?" },
    search_talk_placeholder: { ja: "トークを検索...", en: "Search chats...", "zh-CN": "搜索聊天...", ko: "채팅 검색..." },
    other_id_placeholder: { ja: "相手のID（例: U3K7F9）", en: "Their ID (e.g. U3K7F9)", "zh-CN": "对方ID（例：U3K7F9）", ko: "상대방 ID (예: U3K7F9)" },
    id_input_placeholder: { ja: "IDを入力...", en: "Enter ID...", "zh-CN": "输入ID...", ko: "ID 입력..." },
    language_settings: { ja: "言語設定", en: "Language", "zh-CN": "语言设置", ko: "언어 설정" },

    // ---------- admin.html (1-on-1 chat) ----------
    online: { ja: "オンライン", en: "Online", "zh-CN": "在线", ko: "온라인" },
    offline: { ja: "オフライン", en: "Offline", "zh-CN": "离线", ko: "오프라인" },
    pin: { ja: "ピン留め", en: "Pin", "zh-CN": "置顶", ko: "고정" },
    send_file: { ja: "ファイルを送信", en: "Send File", "zh-CN": "发送文件", ko: "파일 전송" },
    send_photo: { ja: "写真を送る", en: "Send Photo", "zh-CN": "发送照片", ko: "사진 보내기" },
    send_video: { ja: "動画を送る", en: "Send Video", "zh-CN": "发送视频", ko: "동영상 보내기" },
    reaction: { ja: "リアクション", en: "React", "zh-CN": "回应", ko: "반응" },
    reply: { ja: "リプライ", en: "Reply", "zh-CN": "回复", ko: "답장" },
    copy: { ja: "コピー", en: "Copy", "zh-CN": "复制", ko: "복사" },
    replying_to: { ja: "リプライ中:", en: "Replying to:", "zh-CN": "正在回复：", ko: "답장 중:" },
    calling: { ja: "呼び出し中...", en: "Calling...", "zh-CN": "呼叫中...", ko: "발신 중..." },
    unsend: { ja: "送信取り消し", en: "Unsend", "zh-CN": "撤回", ko: "전송 취소" },
    username_label: { ja: "ユーザー名", en: "Username", "zh-CN": "用户名", ko: "사용자 이름" },

    // ---------- groupchat.html ----------
    group_icon: { ja: "グループアイコン", en: "Group Icon", "zh-CN": "群组图标", ko: "그룹 아이콘" },
    group_chat: { ja: "グループチャット", en: "Group Chat", "zh-CN": "群聊", ko: "그룹 채팅" },
    group_settings: { ja: "グループ設定", en: "Group Settings", "zh-CN": "群组设置", ko: "그룹 설정" },
    members: { ja: "メンバー", en: "Members", "zh-CN": "成员", ko: "멤버" },
    members_count: { ja: "メンバー 0人", en: "0 Members", "zh-CN": "0名成员", ko: "멤버 0명" },
    reset_zoom: { ja: "位置とズームをリセット", en: "Reset Position & Zoom", "zh-CN": "重置位置和缩放", ko: "위치 및 확대/축소 재설정" },
    read_by: { ja: "既読メンバー", en: "Read by", "zh-CN": "已读成员", ko: "읽은 멤버" },

    // ---------- auth.html (login/signup) ----------
    secure_chat_app: { ja: "安全なチャットアプリ", en: "A secure chat app", "zh-CN": "安全的聊天应用", ko: "안전한 채팅 앱" },
    verify_title: { ja: "メールアドレスの確認", en: "Verify your email", "zh-CN": "验证邮箱", ko: "이메일 확인" },
    verify_desc: { ja: "届いた6桁のコードを入力してください(10分間有効)", en: "Enter the 6-digit code we emailed you (valid for 10 minutes)", "zh-CN": "请输入邮件中的6位验证码（10分钟内有效）", ko: "메일로 받은 6자리 코드를 입력하세요 (10분간 유효)" },
    verify_code_placeholder: { ja: "6桁のコード", en: "6-digit code", "zh-CN": "6位验证码", ko: "6자리 코드" },
    verify_btn: { ja: "確認する", en: "Verify", "zh-CN": "验证", ko: "확인" },
    resend_code: { ja: "コードを再送する", en: "Resend code", "zh-CN": "重新发送验证码", ko: "코드 다시 보내기" },
    code_resent: { ja: "コードを再送しました", en: "Code sent again", "zh-CN": "验证码已重新发送", ko: "코드를 다시 보냈습니다" },
    twofa_title: { ja: "2段階認証", en: "Two-step verification", "zh-CN": "两步验证", ko: "2단계 인증" },
    twofa_desc: { ja: "認証アプリの6桁のコード、または予備コードを入力してください", en: "Enter the 6-digit code from your authenticator app, or a backup code", "zh-CN": "请输入验证器应用中的6位验证码或备用码", ko: "인증 앱의 6자리 코드 또는 백업 코드를 입력하세요" },
    twofa_code_placeholder: { ja: "コード", en: "Code", "zh-CN": "验证码", ko: "코드" },
    twofa_btn: { ja: "ログイン", en: "Sign in", "zh-CN": "登录", ko: "로그인" },
    buy_coffee: { ja: "コーヒーをおごる", en: "Buy me a coffee", "zh-CN": "请我喝杯咖啡", ko: "커피 한 잔 사주기" },
    support: { ja: "サポート", en: "Support", "zh-CN": "支持", ko: "지원" },
    bug_report: { ja: "バグを報告", en: "Report a bug", "zh-CN": "报告问题", ko: "버그 신고" },
    user_report: { ja: "ユーザーを通報", en: "Report a user", "zh-CN": "举报用户", ko: "사용자 신고" },
    report_target: { ja: "通報する相手", en: "User to report", "zh-CN": "举报对象", ko: "신고할 사용자" },
    report_reason: { ja: "理由", en: "Reason", "zh-CN": "原因", ko: "사유" },
    report_spam: { ja: "スパム・迷惑行為", en: "Spam or abuse", "zh-CN": "垃圾信息/骚扰", ko: "스팸/불쾌한 행위" },
    report_harassment: { ja: "嫌がらせ・脅し", en: "Harassment or threats", "zh-CN": "骚扰/威胁", ko: "괴롭힘/협박" },
    report_impersonation: { ja: "なりすまし", en: "Impersonation", "zh-CN": "冒充他人", ko: "사칭" },
    report_inappropriate: { ja: "不適切な内容", en: "Inappropriate content", "zh-CN": "不当内容", ko: "부적절한 내용" },
    report_other: { ja: "その他", en: "Other", "zh-CN": "其他", ko: "기타" },
    report_send: { ja: "送信", en: "Send", "zh-CN": "发送", ko: "보내기" },
    report_pick_friend: { ja: "友だちから選ぶ", en: "Choose from friends", "zh-CN": "从好友中选择", ko: "친구에서 선택" },
    report_enter_id: { ja: "IDを直接入力", en: "Enter an ID", "zh-CN": "直接输入ID", ko: "ID 직접 입력" },
    report_bug_desc: { ja: "どんな不具合ですか?(何をしたら、どうなったか)", en: "What went wrong? (what you did, what happened)", "zh-CN": "出了什么问题？（做了什么，结果如何）", ko: "어떤 문제인가요? (무엇을 했고 어떻게 됐는지)" },
    report_user_desc: { ja: "状況を教えてください", en: "Please describe what happened", "zh-CN": "请描述情况", ko: "상황을 알려주세요" },
    report_need_target: { ja: "通報する相手を選んでください", en: "Please choose who to report", "zh-CN": "请选择举报对象", ko: "신고할 사용자를 선택하세요" },
    report_need_msg: { ja: "内容を5文字以上で書いてください", en: "Please write at least 5 characters", "zh-CN": "请至少输入5个字", ko: "5자 이상 입력하세요" },
    report_failed: { ja: "送信できませんでした", en: "Could not send", "zh-CN": "发送失败", ko: "보내지 못했습니다" },
    report_thanks_bug: { ja: "報告を送りました。ありがとうございます", en: "Report sent. Thank you", "zh-CN": "已发送报告，谢谢", ko: "신고를 보냈습니다. 감사합니다" },
    report_thanks_user: { ja: "通報を送りました。確認します", en: "Report sent. We will review it", "zh-CN": "已发送举报，我们会审核", ko: "신고를 보냈습니다. 확인하겠습니다" },
    busy: { ja: "処理中…", en: "Working…", "zh-CN": "处理中…", ko: "처리 중…" },
    slow_server: { ja: "サーバーが混み合っているか、起動中です。1分ほどかかることがあります", en: "The server is busy or starting up. This can take up to a minute", "zh-CN": "服务器繁忙或正在启动，可能需要1分钟左右", ko: "서버가 혼잡하거나 시작 중입니다. 1분 정도 걸릴 수 있습니다" },
    forgot_link: { ja: "パスワードを忘れましたか?", en: "Forgot your password?", "zh-CN": "忘记密码？", ko: "비밀번호를 잊으셨나요?" },
    forgot_title: { ja: "パスワードの再設定", en: "Reset your password", "zh-CN": "重置密码", ko: "비밀번호 재설정" },
    forgot_desc: { ja: "登録したメールアドレスに6桁のコードを送ります", en: "We'll email a 6-digit code to your registered address", "zh-CN": "我们会向注册邮箱发送6位验证码", ko: "등록한 이메일로 6자리 코드를 보내드립니다" },
    forgot_send: { ja: "コードを送る", en: "Send code", "zh-CN": "发送验证码", ko: "코드 보내기" },
    forgot_sent: { ja: "登録のあるアドレスならコードを送りました。届かない時は1分後に再送できます", en: "If that address is registered, a code is on its way. You can resend after 1 minute", "zh-CN": "如果该邮箱已注册，验证码已发送。1分钟后可重新发送", ko: "등록된 주소라면 코드를 보냈습니다. 1분 후 다시 보낼 수 있습니다" },
    forgot_no_mail: { ja: "このサーバーはメール送信が未設定のため、再設定できません。管理者に連絡してください", en: "Email sending isn't set up on this server. Please contact the administrator", "zh-CN": "此服务器未配置邮件发送，无法重置。请联系管理员", ko: "이 서버는 메일 발송이 설정되지 않아 재설정할 수 없습니다. 관리자에게 문의하세요" },
    reset_title: { ja: "新しいパスワード", en: "New password", "zh-CN": "新密码", ko: "새 비밀번호" },
    reset_desc: { ja: "届いたコードと、新しいパスワードを入力してください(10分間有効)", en: "Enter the code from the email and your new password (valid for 10 minutes)", "zh-CN": "请输入邮件中的验证码和新密码（10分钟内有效）", ko: "메일로 받은 코드와 새 비밀번호를 입력하세요 (10분간 유효)" },
    reset_pw_placeholder: { ja: "新しいパスワード(8文字以上)", en: "New password (8+ characters)", "zh-CN": "新密码（至少8位）", ko: "새 비밀번호 (8자 이상)" },
    reset_totp_placeholder: { ja: "認証アプリのコード(2段階認証)", en: "Authenticator code (2-step)", "zh-CN": "验证器代码（两步验证）", ko: "인증 앱 코드 (2단계 인증)" },
    reset_btn: { ja: "パスワードを変更", en: "Change password", "zh-CN": "修改密码", ko: "비밀번호 변경" },
    reset_done: { ja: "パスワードを変更しました。新しいパスワードでログインしてください", en: "Password changed. Please sign in with your new password", "zh-CN": "密码已修改，请使用新密码登录", ko: "비밀번호를 변경했습니다. 새 비밀번호로 로그인하세요" },
    back_to_login: { ja: "ログイン画面に戻る", en: "Back to sign in", "zh-CN": "返回登录", ko: "로그인 화면으로" },
    security: { ja: "アカウントのセキュリティ", en: "Account security", "zh-CN": "账号安全", ko: "계정 보안" },
    twofa_row: { ja: "2段階認証", en: "Two-step verification", "zh-CN": "两步验证", ko: "2단계 인증" },
    twofa_intro: { ja: "ログイン時にパスワードに加えて認証アプリのコードを求めます。パスワードが漏れても他人にログインされにくくなります。", en: "Asks for a code from your authenticator app in addition to your password, so a leaked password alone is not enough to sign in.", "zh-CN": "登录时除密码外还需要验证器应用中的验证码，即使密码泄露也更难被他人登录。", ko: "로그인할 때 비밀번호와 함께 인증 앱의 코드를 요구합니다. 비밀번호가 유출돼도 다른 사람이 로그인하기 어려워집니다." },
    just_now: { ja: "たった今", en: "Just now", "zh-CN": "刚刚", ko: "방금" },
    min_ago: { ja: "分前", en: " min ago", "zh-CN": "分钟前", ko: "분 전" },
    hour_ago: { ja: "時間前", en: " h ago", "zh-CN": "小时前", ko: "시간 전" },
    day_ago: { ja: "日前", en: " d ago", "zh-CN": "天前", ko: "일 전" },
    audio_output: { ja: "音声の出力", en: "Audio output", "zh-CN": "音频输出", ko: "오디오 출력" },
    audio_earpiece: { ja: "受話口", en: "Earpiece", "zh-CN": "听筒", ko: "수화기" },
    audio_speaker: { ja: "スピーカー", en: "Speaker", "zh-CN": "扬声器", ko: "스피커" },
    audio_bluetooth: { ja: "Bluetooth", en: "Bluetooth", "zh-CN": "蓝牙", ko: "블루투스" },
    audio_headset: { ja: "ヘッドセット", en: "Headset", "zh-CN": "耳机", ko: "헤드셋" },
    gk_unreadable: { ja: "このグループの暗号鍵が、この端末では読めません。バックアップから復元するか、鍵を作り直してください。", en: "This device cannot read this group's encryption key. Restore from backup, or create a new key.", "zh-CN": "此设备无法读取该群的加密密钥。请从备份恢复,或重新创建密钥。", ko: "이 기기에서는 이 그룹의 암호화 키를 읽을 수 없습니다. 백업에서 복원하거나 키를 다시 만드세요." },
    gk_btn_restore: { ja: "バックアップから復元", en: "Restore from backup", "zh-CN": "从备份恢复", ko: "백업에서 복원" },
    gk_btn_rekey: { ja: "鍵を作り直す", en: "Create a new key", "zh-CN": "重新创建密钥", ko: "키 다시 만들기" },
    gk_rekey_confirm: { ja: "鍵を作り直すと、これ以降のメッセージはメンバー全員が読めるようになります。ただし、これまでのメッセージは元の鍵を持つ端末でしか読めません。続けますか？", en: "After creating a new key, all members can read new messages. Past messages stay readable only on devices that still have the old key. Continue?", "zh-CN": "重新创建密钥后,所有成员都能阅读之后的消息。但以前的消息只能在仍持有旧密钥的设备上阅读。要继续吗?", ko: "키를 다시 만들면 앞으로의 메시지는 모든 멤버가 읽을 수 있습니다. 다만 지난 메시지는 이전 키를 가진 기기에서만 읽을 수 있습니다. 계속할까요?" },
    gk_rekey_done: { ja: "鍵を作り直しました", en: "A new key has been created", "zh-CN": "已重新创建密钥", ko: "키를 다시 만들었습니다" },
    gk_rekey_fail: { ja: "鍵を作り直せませんでした。少し待ってからもう一度試してください", en: "Could not create a new key. Please try again shortly", "zh-CN": "无法重新创建密钥,请稍后重试", ko: "키를 다시 만들 수 없습니다. 잠시 후 다시 시도하세요" },
    kb_setup_title: { ja: "暗号鍵をバックアップ", en: "Back up your encryption key", "zh-CN": "备份加密密钥", ko: "암호화 키 백업" },
    kb_restore_title: { ja: "暗号鍵を復元", en: "Restore your encryption key", "zh-CN": "恢复加密密钥", ko: "암호화 키 복원" },
    kb_setup_body: { ja: "別の端末でも過去のメッセージを読めるように、鍵をパスフレーズで暗号化して預けます。パスフレーズはサーバーにも分かりません。忘れると復元できないので、控えておいてください。", en: "To read past messages on other devices, your key is encrypted with a passphrase and stored. The server cannot see the passphrase. If you forget it, it cannot be recovered, so keep a note of it.", "zh-CN": "为了能在其他设备上阅读以前的消息,密钥会用口令加密后保存。服务器无法得知口令。忘记后无法恢复,请记好。", ko: "다른 기기에서도 지난 메시지를 읽을 수 있도록 키를 암호문으로 보관합니다. 서버는 암호를 알 수 없고, 잊어버리면 복구할 수 없으니 꼭 기록해 두세요." },
    kb_restore_body: { ja: "この端末にはまだ暗号鍵がありません。バックアップのパスフレーズを入力すると、過去のメッセージが読めるようになります。", en: "This device has no encryption key yet. Enter your backup passphrase to read past messages.", "zh-CN": "此设备还没有加密密钥。输入备份口令即可阅读以前的消息。", ko: "이 기기에는 아직 암호화 키가 없습니다. 백업 암호를 입력하면 지난 메시지를 읽을 수 있습니다." },
    kb_mismatch_body: { ja: "この端末の鍵が、バックアップの鍵と違っています。このままだと一部のメッセージが読めません。バックアップのパスフレーズを入力すると、鍵が揃います。", en: "This device's key differs from the backed-up key, so some messages cannot be read. Enter your backup passphrase to fix this.", "zh-CN": "此设备的密钥与备份的密钥不一致,部分消息无法阅读。输入备份口令即可修复。", ko: "이 기기의 키가 백업 키와 달라 일부 메시지를 읽을 수 없습니다. 백업 암호를 입력하면 해결됩니다." },
    kb_pass: { ja: "パスフレーズ(8文字以上)", en: "Passphrase (8+ characters)", "zh-CN": "口令(至少8个字符)", ko: "암호(8자 이상)" },
    kb_pass2: { ja: "もう一度入力", en: "Enter it again", "zh-CN": "再次输入", ko: "다시 입력" },
    kb_do_setup: { ja: "預ける", en: "Save backup", "zh-CN": "保存备份", ko: "백업 저장" },
    kb_do_restore: { ja: "復元する", en: "Restore", "zh-CN": "恢复", ko: "복원" },
    kb_later: { ja: "あとで", en: "Later", "zh-CN": "稍后", ko: "나중에" },
    kb_make_new: { ja: "新しい鍵を作る(過去のメッセージは読めません)", en: "Create a new key (past messages stay unreadable)", "zh-CN": "创建新密钥(以前的消息将无法阅读)", ko: "새 키 만들기(지난 메시지는 읽을 수 없음)" },
    kb_confirm_new: { ja: "新しい鍵を作ると、これまでのメッセージはこの端末では読めなくなります。よろしいですか？", en: "If you create a new key, past messages can no longer be read on this device. Continue?", "zh-CN": "创建新密钥后,以前的消息将无法在此设备上阅读。要继续吗?", ko: "새 키를 만들면 지난 메시지를 이 기기에서 읽을 수 없게 됩니다. 계속할까요?" },
    kb_working: { ja: "処理中…", en: "Working…", "zh-CN": "处理中…", ko: "처리 중…" },
    kb_err_short: { ja: "パスフレーズは8文字以上にしてください", en: "Passphrase must be at least 8 characters", "zh-CN": "口令至少需要8个字符", ko: "암호는 8자 이상이어야 합니다" },
    kb_err_match: { ja: "2つのパスフレーズが一致しません", en: "The two passphrases do not match", "zh-CN": "两次输入的口令不一致", ko: "두 암호가 일치하지 않습니다" },
    kb_err_wrong: { ja: "パスフレーズが違います", en: "Wrong passphrase", "zh-CN": "口令错误", ko: "암호가 올바르지 않습니다" },
    kb_err_fail: { ja: "失敗しました。通信を確認してもう一度試してください", en: "Failed. Check your connection and try again", "zh-CN": "失败。请检查网络后重试", ko: "실패했습니다. 연결을 확인하고 다시 시도하세요" },
    kb_section: { ja: "暗号鍵のバックアップ", en: "Encryption key backup", "zh-CN": "加密密钥备份", ko: "암호화 키 백업" },
    kb_status_on: { ja: "バックアップ済み", en: "Backed up", "zh-CN": "已备份", ko: "백업됨" },
    kb_status_off: { ja: "未設定", en: "Not set up", "zh-CN": "未设置", ko: "미설정" },
    kb_btn_setup: { ja: "パスフレーズを設定して預ける", en: "Set a passphrase and back up", "zh-CN": "设置口令并备份", ko: "암호를 설정하고 백업" },
    kb_btn_change: { ja: "パスフレーズを変えて預け直す", en: "Change passphrase and back up again", "zh-CN": "更改口令并重新备份", ko: "암호 변경 후 다시 백업" },
    kb_btn_restore: { ja: "バックアップから鍵を復元", en: "Restore key from backup", "zh-CN": "从备份恢复密钥", ko: "백업에서 키 복원" },
    sessions_title: { ja: "ログイン中の端末", en: "Signed-in devices", "zh-CN": "已登录的设备", ko: "로그인된 기기" },
    sessions_this: { ja: "この端末", en: "This device", "zh-CN": "此设备", ko: "이 기기" },
    sessions_signout: { ja: "サインアウト", en: "Sign out", "zh-CN": "退出登录", ko: "로그아웃" },
    sessions_signout_others: { ja: "他の端末をすべてサインアウト", en: "Sign out all other devices", "zh-CN": "退出所有其他设备", ko: "다른 기기 모두 로그아웃" },
    sessions_none: { ja: "他に ログイン中の端末はありません", en: "No other signed-in devices", "zh-CN": "没有其他已登录的设备", ko: "다른 로그인된 기기가 없습니다" },
    sessions_confirm: { ja: "この端末をサインアウトしますか？", en: "Sign out this device?", "zh-CN": "要退出此设备吗？", ko: "이 기기를 로그아웃할까요?" },
    sessions_last: { ja: "最終利用", en: "Last active", "zh-CN": "最后活动", ko: "마지막 사용" },
    twofa_start: { ja: "設定を始める", en: "Set up", "zh-CN": "开始设置", ko: "설정 시작" },
    twofa_step1: { ja: "認証アプリ(Google Authenticator、Microsoft Authenticator、1Password など)にこのキーを登録してください。", en: "Add this key to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, etc.).", "zh-CN": "请在验证器应用（Google Authenticator、Microsoft Authenticator、1Password 等）中添加此密钥。", ko: "인증 앱(Google Authenticator, Microsoft Authenticator, 1Password 등)에 이 키를 등록하세요." },
    twofa_open_app: { ja: "認証アプリで開く", en: "Open in authenticator app", "zh-CN": "在验证器应用中打开", ko: "인증 앱에서 열기" },
    twofa_enter_code: { ja: "アプリに表示された6桁のコード", en: "6-digit code shown in the app", "zh-CN": "应用中显示的6位验证码", ko: "앱에 표시된 6자리 코드" },
    twofa_enable_btn: { ja: "有効にする", en: "Turn on", "zh-CN": "启用", ko: "켜기" },
    twofa_backup_title: { ja: "予備コード", en: "Backup codes", "zh-CN": "备用码", ko: "백업 코드" },
    twofa_backup_desc: { ja: "認証アプリが使えなくなった時の非常用です。1回ずつ使えます。この画面を閉じると二度と表示されないので、今のうちに保存してください。", en: "For when you cannot use your authenticator app. Each works once. They are never shown again after you close this, so save them now.", "zh-CN": "验证器应用无法使用时的应急码，每个只能用一次。关闭此页面后不会再次显示，请现在保存。", ko: "인증 앱을 쓸 수 없을 때를 위한 비상용입니다. 한 번씩만 사용할 수 있고, 이 화면을 닫으면 다시 볼 수 없으니 지금 저장하세요." },
    twofa_done: { ja: "保存した", en: "I saved them", "zh-CN": "已保存", ko: "저장했습니다" },
    twofa_on_desc: { ja: "有効です。残りの予備コード: ", en: "On. Backup codes left: ", "zh-CN": "已启用。剩余备用码：", ko: "켜져 있습니다. 남은 백업 코드: " },
    twofa_disable_title: { ja: "無効にする", en: "Turn off", "zh-CN": "停用", ko: "끄기" },
    twofa_password_placeholder: { ja: "パスワード", en: "Password", "zh-CN": "密码", ko: "비밀번호" },
    twofa_disable_btn: { ja: "2段階認証を無効にする", en: "Turn off two-step verification", "zh-CN": "停用两步验证", ko: "2단계 인증 끄기" },
    twofa_now_on: { ja: "2段階認証を有効にしました", en: "Two-step verification is on", "zh-CN": "已启用两步验证", ko: "2단계 인증이 켜졌습니다" },
    copied: { ja: "コピーしました", en: "Copied", "zh-CN": "已复制", ko: "복사했습니다" },

    // ---------- Alerts / errors (used via i18n.t()) ----------
    err_self_chat: { ja: "エラー: 自分自身とのチャットは開けません", en: "Error: You can't open a chat with yourself", "zh-CN": "错误：无法与自己聊天", ko: "오류: 자기 자신과는 채팅할 수 없습니다" },
    err_group_not_found: { ja: "グループが見つかりません", en: "Group not found", "zh-CN": "未找到群组", ko: "그룹을 찾을 수 없습니다" },
    err_group_create_failed: { ja: "グループの作成に失敗しました。もう一度お試しください。", en: "Failed to create group. Please try again.", "zh-CN": "创建群组失败，请重试。", ko: "그룹 생성에 실패했습니다. 다시 시도해 주세요." },
    err_enter_group_name: { ja: "グループ名を入力してください", en: "Please enter a group name", "zh-CN": "请输入群组名称", ko: "그룹 이름을 입력해 주세요" },
    err_server_disconnected: { ja: "サーバーに接続できていません。通信環境を確認してページを再読み込みしてください。", en: "Not connected to server. Please check your connection and reload the page.", "zh-CN": "无法连接到服务器。请检查网络并重新加载页面。", ko: "서버에 연결되지 않았습니다. 네트워크를 확인하고 페이지를 새로고침 해주세요." },
    err_file_too_large: { ja: "ファイルが大きすぎます", en: "File is too large", "zh-CN": "文件过大", ko: "파일이 너무 큽니다" },
    err_file_read_failed: { ja: "ファイルの読み込みに失敗しました", en: "Failed to read file", "zh-CN": "文件读取失败", ko: "파일을 읽지 못했습니다" },
    err_file_upload_failed: { ja: "ファイルアップロードに失敗しました: ", en: "File upload failed: ", "zh-CN": "文件上传失败：", ko: "파일 업로드 실패: " },
    err_file_send_unsupported: { ja: "ファイル送信は現在未対応です。画像・動画をご利用ください。", en: "File sending isn't supported yet. Please use photos or videos.", "zh-CN": "暂不支持发送文件，请使用图片或视频。", ko: "파일 전송은 아직 지원되지 않습니다. 사진이나 동영상을 이용해 주세요." },
    err_mic_denied: { ja: "マイクアクセスが拒否されました", en: "Microphone access was denied", "zh-CN": "麦克风访问被拒绝", ko: "마이크 접근이 거부되었습니다" },
    err_media_upload_failed: { ja: "メディアのアップロードに失敗しました: ", en: "Media upload failed: ", "zh-CN": "媒体上传失败：", ko: "미디어 업로드 실패: " },
    err_video_too_large: { ja: "動画は500MB以下にしてください", en: "Videos must be under 500MB", "zh-CN": "视频请控制在500MB以内", ko: "동영상은 500MB 이하로 해주세요" },
    err_post_failed: { ja: "投稿に失敗しました", en: "Failed to post", "zh-CN": "发布失败", ko: "게시에 실패했습니다" },
    err_member_no_keys: { ja: "{name} さんはまだ暗号鍵を準備できていません。相手がBro Chatを開いてから、もう一度試してください", en: "{name} has not set up encryption keys yet. Ask them to open Bro Chat, then try again", "zh-CN": "{name} 尚未准备好加密密钥。请让对方打开 Bro Chat 后再试", ko: "{name}님은 아직 암호화 키가 준비되지 않았습니다. 상대가 Bro Chat을 연 뒤 다시 시도하세요" },
    err_encryption_init_failed: { ja: "暗号化の初期化に失敗しました", en: "Failed to initialize encryption", "zh-CN": "加密初始化失败", ko: "암호화 초기화에 실패했습니다" },
    err_encryption_not_ready: { ja: "暗号化の準備ができていません。ページをリロードしてください。", en: "Encryption isn't ready yet. Please reload the page.", "zh-CN": "加密尚未准备好，请重新加载页面。", ko: "암호화가 준비되지 않았습니다. 페이지를 새로고침 해주세요." },
    err_encryption_module_not_ready: { ja: "暗号化モジュールが準備できていません", en: "Encryption module isn't ready", "zh-CN": "加密模块尚未就绪", ko: "암호화 모듈이 준비되지 않았습니다" },
    err_encryption_module_not_loaded: { ja: "暗号化モジュールが読み込まれていません。ページをリロードしてください。", en: "Encryption module failed to load. Please reload the page.", "zh-CN": "加密模块未加载，请重新加载页面。", ko: "암호화 모듈이 로드되지 않았습니다. 페이지를 새로고침 해주세요." },
    err_group_file_unsupported: { ja: "現在グループチャットではファイル送信に対応していません(画像・動画のみ)", en: "File sending isn't supported in group chats yet (photos/videos only)", "zh-CN": "群聊目前不支持发送文件（仅支持图片和视频）", ko: "그룹 채팅에서는 아직 파일 전송을 지원하지 않습니다 (사진/동영상만 가능)" },
    err_image_too_large: { ja: "画像は100MB以下にしてください", en: "Images must be under 100MB", "zh-CN": "图片请控制在100MB以内", ko: "이미지는 100MB 이하로 해주세요" },
    err_send_failed: { ja: "送信に失敗しました: ", en: "Failed to send: ", "zh-CN": "发送失败：", ko: "전송 실패: " },
    err_send_failed_generic: { ja: "送信に失敗しました。", en: "Failed to send.", "zh-CN": "发送失败。", ko: "전송에 실패했습니다." },
    err_send_failed_size: { ja: "送信に失敗しました。ファイルサイズが大きすぎるか、通信エラーの可能性があります。", en: "Failed to send. The file may be too large, or there may be a connection issue.", "zh-CN": "发送失败。文件可能过大，或存在网络问题。", ko: "전송에 실패했습니다. 파일이 너무 크거나 네트워크 오류일 수 있습니다." },
    media_type_video: { ja: "動画", en: "The video", "zh-CN": "视频", ko: "동영상" },
    media_type_image: { ja: "画像", en: "The image", "zh-CN": "图片", ko: "이미지" },
    err_media_too_large_template: { ja: "が大きすぎます（上限: {limit}MB）。もう少し短い動画や軽い画像でお試しください。", en: " is too large (limit: {limit}MB). Please try a shorter video or a smaller image.", "zh-CN": "过大（上限：{limit}MB）。请尝试更短的视频或更小的图片。", ko: "이(가) 너무 큽니다 (제한: {limit}MB). 더 짧은 동영상이나 가벼운 이미지로 시도해 주세요." },
  };

  const SUPPORTED = ["ja", "en", "zh-CN", "ko"];

  function getLang() {
    const stored = localStorage.getItem("ring_language");
    if (stored) {
      if (SUPPORTED.includes(stored)) return stored;
      // welcome.html offers 30 languages; i18n.js only ships 4.
      // If the stored choice isn't one we translate, fall back to English
      // (closer to most non-CJK languages) rather than ignoring their choice.
      if (stored.startsWith("zh")) return "zh-CN";
      if (stored.startsWith("ko")) return "ko";
      if (stored.startsWith("ja")) return "ja";
      return "en";
    }
    // nothing stored yet: fall back to browser language matching, then ja
    const nav = (navigator.language || "ja");
    if (nav.startsWith("zh")) return "zh-CN";
    if (nav.startsWith("ko")) return "ko";
    if (nav.startsWith("en")) return "en";
    return "ja";
  }

  function setLang(lang) {
    if (!SUPPORTED.includes(lang)) lang = "ja";
    localStorage.setItem("ring_language", lang);
    document.documentElement.lang = lang;
    applyI18n();
  }

  function t(key, fallback) {
    const lang = getLang();
    const entry = DICT[key];
    if (!entry) return fallback !== undefined ? fallback : key;
    return entry[lang] || entry.ja || fallback || key;
  }

  function applyI18n(root) {
    const scope = root || document;
    document.documentElement.lang = getLang();

    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      el.textContent = t(key);
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      el.setAttribute("placeholder", t(key));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      el.setAttribute("title", t(key));
    });
    scope.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const key = el.getAttribute("data-i18n-html");
      el.innerHTML = t(key);
    });
  }

  // ---------- 直書きの日本語の自動翻訳 ----------
  // data-i18n を付けていない(JSで直接入れている)日本語の表示文言を、日本語以外の時に置き換える。
  // 中国語・韓国語は個別訳が無い文言は英語で出す(日本語のまま残るよりは読める)。
  const AUTO_EN = {"ホーム画面に追加してね": "Add to Home Screen", "下の": "Tap", "共有 →「ホーム画面に追加」。アプリとして開くと通知と着信が届きます": "Share → \"Add to Home Screen\". Open it as an app to get notifications and calls", "通知をオンにする": "Turn on notifications", "メッセージと着信を受け取れます": "Get messages and calls", "オン": "On","設定した背景画像をチャット画面でぼかして表示します": "Blur the background image in chats", "システム設定に連動 (手動で切替も可能)": "Follows system setting (can be changed manually)", "モバイル回線を自動検出して画質を下げます": "Lowers media quality on mobile data", "バッテリーセーバー時のアニメーション軽減": "Reduce animations in battery saver", "オンにすると、装飾アニメーションを常に無効化します": "Always turn off decorative animations", "全体の背景画像": "App background image", "背景画像を選択する": "Choose background image", "画像を選択する": "Choose image", "プロフィール画像": "Profile photo", "チャット背景をぼかす": "Blur chat background", "ダークモード": "Dark mode", "モバイルデータ節約": "Mobile data saver", "言語設定": "Language","(メディアの復号に失敗しました)": "(Couldn't decrypt media)", "(復号に失敗しました)": "(Couldn't decrypt)", "(編集済)": "(edited)", "+ チャンネルを追加": "+ Add channel", "ID: 読み込み中...": "ID: Loading...", "[動画]": "[Video]", "[画像]": "[Photo]", "この投稿を削除しますか？": "Delete this post?", "そのユーザーは見つかりません": "User not found", "たった今": "Just now", "なし": "None", "に参加しました！": " joined!", "はじめる": "Start", "または": "or", "まだ投稿がありません": "No posts yet", "ようこそ": "Welcome", "オーロラ": "Aurora", "カメラ/マイクにアクセスできません": "Can't access camera/microphone", "カラー": "Color", "キャンセル": "Cancel", "グループ": "Group", "グループチャット": "Group chat", "コミュニティ": "Community", "コミュニティが見つかりません": "Community not found", "コミュニティの作成に失敗しました": "Couldn't create community", "コミュニティを作成": "Create community", "コメントの読み込みに失敗しました": "Couldn't load comments", "コメントを追加...": "Add a comment...", "ダウンロード": "Download", "トーク": "Chat", "トークがまだありません": "No chats yet", "トークを検索...": "Search chats...", "トークを選んでください": "Select a chat", "トーク一覧": "Chats", "バブル": "Bubbles", "パスワード": "Password", "パスワード（6文字以上）": "Password (8+ characters)", "ビデオ着信中...": "Incoming video call...", "ホーム": "Home", "マイクにアクセスできません": "Can't access microphone", "メッセージが取り消されました": "Message unsent", "メッセージを入力": "Message", "メッセージを入力...": "Message...", "メディア": "Media", "メンバー": "Members", "メンバー削除": "Remove member", "メールアドレス": "Email", "モノクロ": "Monochrome", "ユーザー名": "Username", "ログイン": "Log in", "ログインに失敗しました": "Login failed", "ログイン成功！": "Logged in!", "不明": "Unknown", "今なにしてる？": "What's happening?", "位置情報がサポートされていません": "Location isn't supported", "位置情報の権限が拒否されました": "Location permission denied", "位置情報エラー": "Location error", "写真": "Photo", "写真を送る": "Send photo", "写真を選び直す": "Choose another photo", "削除": "Delete", "動画": "Video", "参加に失敗しました。招待コードを確認してください": "Couldn't join. Check the invite code", "友達ではないため発信できません": "You can only call friends", "友達を追加": "Add friend", "友達リクエスト": "Friend requests", "取り消す": "Undo", "呼び出し中...": "Calling...", "夕焼け": "Sunset", "宇宙": "Cosmos", "安全なチャットアプリ": "Secure chat app", "完了": "Done", "応答がありません": "No answer", "応答がありませんでした": "No answer", "戻る": "Back", "投稿": "Post", "投稿する": "Post", "投稿に失敗しました": "Couldn't post", "投稿中...": "Posting...", "接続できませんでした": "Couldn't connect", "接続中...": "Connecting...", "新しいグループを作成": "New group", "新規登録": "Sign up", "画像": "Photo", "画像を読み込めませんでした": "Couldn't load image", "発信中...": "Calling...", "登録": "Sign up", "登録に失敗しました": "Sign up failed", "登録成功！ログイン中...": "Signed up! Logging in...", "相手": "Them", "相手はオフラインです": "They're offline", "着信中...": "Incoming call...", "管理者": "Admin", "背景": "Background", "背景画像が大きすぎて保存できませんでした": "Background image is too large to save", "自分": "Me", "表示名": "Display name", "読み込みに失敗しました": "Couldn't load", "読み込み中...": "Loading...", "送信": "Send", "送信先": "Send to", "送信取り消し": "Unsend", "通話中です": "On a call", "通話終了": "Call ended", "（自分）": "(You)", "リプライ中:": "Replying to:", "リアクション": "React", "リプライ": "Reply", "コピー": "Copy", "編集する": "Edit", "ピン留め": "Pin", "通話": "Call", "ビデオ通話": "Video call", "音声通話": "Voice call", "メッセージが届きました": "New message", "トークリストが空です": "No chats yet", "友達を追加してメッセージしよう！": "Add a friend to start chatting!", "見つかりませんでした": "No results", "まだメッセージがありません": "No messages yet", "（送信取り消し済み）": "(Unsent)", "オンライン": "Online", "オフライン": "Offline", "既読": "Read", "画像読み込み中...": "Loading photo...", "動画読み込み中...": "Loading video...", "今日": "Today", "昨日": "Yesterday", "キャッシュを削除": "Clear cache", "設定": "Settings", "変更を適用して閉じる": "Apply and close", "ログアウト": "Log out", "プロフィールの編集": "Edit profile", "位置とズームをリセット": "Reset position and zoom", "作成する": "Create", "参加する": "Join", "招待コード": "Invite code", "説明 (任意)": "Description (optional)", "コミュニティ名": "Community name", "ファイルを送信": "Send file", "動画を送る": "Send video", "位置情報を送信": "Send location", "ここに未読メッセージがあります": "Unread messages"};
  const JP = /[\u3040-\u30ff\u4e00-\u9fff]/;
  function autoTr(str) {
    if (!str || getLang() === "ja" || !JP.test(str)) return null;
    const k = str.trim();
    if (AUTO_EN[k] !== undefined) return str.replace(k, AUTO_EN[k]);
    let m;
    if ((m = /^メンバー\s*(\d+)\s*人$/.exec(k))) return m[1] + " members";
    if ((m = /^(\d+)分前$/.exec(k))) return m[1] + "m ago";
    if ((m = /^(\d+)時間前$/.exec(k))) return m[1] + "h ago";
    if ((m = /^(\d+)日前$/.exec(k))) return m[1] + "d ago";
    return null;
  }
  function autoTranslate(root) {
    if (getLang() === "ja" || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentNode && /^(SCRIPT|STYLE|TEXTAREA)$/.test(n.parentNode.nodeName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(n => { const r = autoTr(n.nodeValue); if (r !== null) n.nodeValue = r; });
    const els = root.querySelectorAll ? root.querySelectorAll("[placeholder],[title],[aria-label]") : [];
    els.forEach(el => ["placeholder", "title", "aria-label"].forEach(a => {
      const v = el.getAttribute(a); const r = autoTr(v); if (r !== null) el.setAttribute(a, r);
    }));
  }
  function startAutoTranslate() {
    if (getLang() === "ja") return;
    autoTranslate(document.body);
    let queued = new Set(), scheduled = false;
    new MutationObserver(ms => {
      ms.forEach(m => {
        if (m.type === "characterData") queued.add(m.target.parentNode);
        m.addedNodes.forEach(n => queued.add(n.nodeType === 3 ? n.parentNode : n));
      });
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          const list = queued; queued = new Set();
          list.forEach(n => n && n.isConnected && autoTranslate(n));
        });
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    const _alert = window.alert.bind(window), _confirm = window.confirm.bind(window);
    window.alert = msg => _alert(autoTr(String(msg)) || msg);
    window.confirm = msg => _confirm(autoTr(String(msg)) || msg);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startAutoTranslate);
  else startAutoTranslate();

  window.i18n = { t, getLang, setLang, applyI18n, SUPPORTED, DICT, autoTranslate };
  window.applyI18n = applyI18n;

  // Auto-apply on load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => applyI18n());
  } else {
    applyI18n();
  }
})();
