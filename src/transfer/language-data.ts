// Micme-original, MIT-licensed word/phrase lists. No upstream data or runtime
// transliterator is used. Keep this deliberately small: unknown phrases pass
// through, and ambiguous single-character conversions are not attempted.
export const BUILTIN_FILLERS: Readonly<Record<string, readonly string[]>> = {
	en: ["um", "uh"],
	fr: ["euh"],
};

// Columns: simplified, Taiwan traditional, Hong Kong traditional.
// Match the same meaning before offering a regional form; never translate.
export const CHINESE_FORMS = [
	["这个", "這個", "這個"],
	["这些", "這些", "這些"],
	["那个", "那個", "那個"],
	["软件", "軟體", "軟件"],
	["硬件", "硬體", "硬件"],
	["支持打印机", "支援印表機", "支援打印機"],
	["打印机", "印表機", "打印機"],
	["鼠标", "滑鼠", "滑鼠"],
	["服务器", "伺服器", "伺服器"],
	["数据库", "資料庫", "數據庫"],
	["互联网", "網際網路", "互聯網"],
	["网络", "網路", "網絡"],
	["操作系统", "作業系統", "作業系統"],
	["键盘", "鍵盤", "鍵盤"],
	["屏幕", "螢幕", "屏幕"],
	["文件夹", "資料夾", "資料夾"],
	["图书馆", "圖書館", "圖書館"],
	["电脑", "電腦", "電腦"],
] as const;
