# cyclosa 專屬：私人清單守門的共用函式（pre-commit 與 commit-msg 都 source 這一份）。
#
# 這個 repo 是公開的，而且分支一推上去就公開 —— 推之前沒擋住，之後刪分支、強推都拿不掉
# （GitHub 上的舊 commit 照樣查得到）。所以在 commit 的當下擋。
#
# 清單在 .git/info/private-terms.txt（`git rev-parse --git-path info/private-terms.txt`）：
# 那個位置不在工作樹裡，永遠不會被 git add。內容是不該出現在公開 repo 的詞（真實姓名、學校、
# 信箱網域這類），向維護者拿，一行一個，# 開頭是註解；檔頭的 UTF-8 BOM 與行尾的 CR 都不影響。
#
# **兩種詞，兩種比法**（2026-10-09 改，原本一律「刪掉 ASCII 標點與空白再比子字串」）：
#   - 含中文（或任何非 ASCII 字元）的詞：兩邊都轉小寫、刪掉 ASCII 的空白與標點，再比子字串 ——
#     中文沒有字的邊界，「王 小明」「王小明」要算同一個
#   - 純英數的詞：照**字的邊界**比，詞裡的各段之間可以夾任何非英數（大小寫不分）——
#     "Mary-Ann Doe" 擋得到 "maryann doe"、"MARY_ANN_DOE"，"abc.edu.tw" 擋得到 "x@abc.edu.tw"，
#     但三個字母的縮寫不會在 "contrusting" 這種字裡湊出來。舊的比法把整段文字黏成一串，
#     短的英文詞在程式碼裡一定湊得出來（第一次用正式清單掃 vendor 的 tarball 就湊出一個）
#
# 命中時只印位置，**不印詞本身** —— 這幾支的輸出可能被貼進 issue 或對話。
# 沒有清單就只提示、放行：CI 與還沒拿到清單的 clone 不該連 commit 都不能做。
#
# 改寫自 sandbox-spectrum 的姓名守門（同一作者），清單位置改到 .git/info/。

PRIVATE_TERMS_FILE=$(git rev-parse --git-path info/private-terms.txt)

# 轉小寫，刪掉 ASCII 的控制字元、空白與標點；英數與非 ASCII 的位元組（中文）保留。
private_normalize() { tr 'A-Z' 'a-z' | tr -d '\000-\057\072-\100\133-\140\173-\177'; }

# 純英數的詞 → 一個 ERE：各段之間允許任何非英數，前後要是字的邊界（或行首行尾）
private_ascii_regex() {
	printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' ' ' |
		awk '{ r = ""; for (i = 1; i <= NF; i++) r = r (i > 1 ? "[^a-z0-9]*" : "") $i; if (r != "") print "(^|[^a-z0-9])" r "([^a-z0-9]|$)" }'
}

# 讀清單，分成兩份：PRIVATE_CJK（正規化之後的字串，一行一個，不含 ASCII 空白）與
# PRIVATE_ASCII_ALT（所有純英數詞的 ERE 用 | 接成一條，比一次就好）。沒有清單時回傳 1。
private_load_terms() {
	[ -f "$PRIVATE_TERMS_FILE" ] || return 1
	PRIVATE_CJK=""
	PRIVATE_ASCII_ALT=""
	nl='
'
	while IFS= read -r line || [ -n "$line" ]; do
		line=$(printf '%s' "$line" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
		[ -n "$line" ] || continue
		case "$line" in '#'*) continue ;; esac
		if [ -n "$(printf '%s' "$line" | LC_ALL=C tr -d '\001-\177')" ]; then
			t=$(printf '%s' "$line" | private_normalize)
			[ -n "$t" ] && PRIVATE_CJK="$PRIVATE_CJK$t$nl"
		else
			re=$(private_ascii_regex "$line")
			if [ -n "$re" ]; then
				if [ -n "$PRIVATE_ASCII_ALT" ]; then PRIVATE_ASCII_ALT="$PRIVATE_ASCII_ALT|$re"; else PRIVATE_ASCII_ALT="$re"; fi
			fi
		fi
	done <<EOF
$(sed '1s/^\xEF\xBB\xBF//' "$PRIVATE_TERMS_FILE")
EOF
	return 0
}

# $1 是原始的文字（不要先正規化）；含清單裡任何一個詞就回傳 0
private_contains() {
	norm=$(printf '%s' "$1" | private_normalize)
	for t in $PRIVATE_CJK; do
		case "$norm" in *"$t"*) return 0 ;; esac
	done
	if [ -n "$PRIVATE_ASCII_ALT" ]; then
		printf '%s\n' "$1" | tr 'A-Z' 'a-z' | grep -Eq -- "$PRIVATE_ASCII_ALT" && return 0
	fi
	return 1
}
