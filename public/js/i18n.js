// ===== Bro Chat i18n module =====
// Supported languages: ja, en, zh-CN, ko
// Usage: add data-i18n="key" to any element (replaces textContent)
//        add data-i18n-placeholder="key" for placeholder attribute
//        add data-i18n-title="key" for title attribute
// Call window.applyI18n() after DOM ready and whenever language changes.

(function () {
  const DICT = {
    // ---------- Common / nav ----------
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
    group_name: { ja: "グループ名", en: "Group Name", "zh-CN": "群组名称", ko: "그룹 이름" },
    group_name_placeholder: { ja: "グループ名を入力", en: "Enter group name", "zh-CN": "输入群组名称", ko: "그룹 이름 입력" },
    member_select: { ja: "メンバー選択", en: "Select Members", "zh-CN": "选择成员", ko: "멤버 선택" },
    create_btn: { ja: "作成する", en: "Create", "zh-CN": "创建", ko: "만들기" },
    dark_mode: { ja: "ダークモード", en: "Dark Mode", "zh-CN": "深色模式", ko: "다크 모드" },
    mobile_data_saver: { ja: "モバイルデータ節約", en: "Mobile Data Saver", "zh-CN": "移动数据节省", ko: "모바일 데이터 절약" },
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
    pin: { ja: "ピン留め", en: "Pin", "zh-CN": "置顶", ko: "고정" },
    send_file: { ja: "ファイルを送信", en: "Send File", "zh-CN": "发送文件", ko: "파일 전송" },
    send_photo: { ja: "写真を送る", en: "Send Photo", "zh-CN": "发送照片", ko: "사진 보내기" },
    send_video: { ja: "動画を送る", en: "Send Video", "zh-CN": "发送视频", ko: "동영상 보내기" },
    reaction: { ja: "リアクション", en: "React", "zh-CN": "回应", ko: "반응" },
    reply: { ja: "リプライ", en: "Reply", "zh-CN": "回复", ko: "답장" },
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

  window.i18n = { t, getLang, setLang, applyI18n, SUPPORTED, DICT };
  window.applyI18n = applyI18n;

  // Auto-apply on load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => applyI18n());
  } else {
    applyI18n();
  }
})();
