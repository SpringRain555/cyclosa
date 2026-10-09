# cyclosa 專屬：私人清單守門的共用函式（pre-commit 與 commit-msg 都 source 這一份）。
#
# 這個 repo 是公開的，而且分支一推上去就公開 —— 推之前沒擋住，之後刪分支、強推都拿不掉
# （GitHub 上的舊 commit 照樣查得到）。所以在 commit 的當下擋。
#
# 清單在 .git/info/private-terms.txt（`git rev-parse --git-path info/private-terms.txt`）：
# 那個位置不在工作樹裡，永遠不會被 git add。內容是不該出現在公開 repo 的詞（真實姓名、學校、
# 信箱網域這類），向維護者拿，一行一個，# 開頭是註解。
#
# 比對前兩邊都轉小寫、刪掉 ASCII 的空白、標點與控制字元（含 CR），中文字不刪，所以
# "Mary-Ann Doe"、"maryann doe"、"MARY_ANN_DOE" 算同一個；檔頭的 UTF-8 BOM 也去掉（記事本存的檔可能有）。
# 命中時只印位置，**不印詞本身** —— 這幾支的輸出可能被貼進 issue 或對話。
# 沒有清單就只提示、放行：CI 與還沒拿到清單的 clone 不該連 commit 都不能做。
#
# 改寫自 sandbox-spectrum 的姓名守門（同一作者），清單位置改到 .git/info/。

PRIVATE_TERMS_FILE=$(git rev-parse --git-path info/private-terms.txt)

# 轉小寫，刪掉 ASCII 的控制字元、空白與標點；英數與非 ASCII 的位元組（中文）保留。
private_normalize() { tr 'A-Z' 'a-z' | tr -d '\000-\057\072-\100\133-\140\173-\177'; }

# 讀清單：去掉 BOM、註解與空行，逐行正規化。正規化之後不含空白，呼叫端可以直接 for 展開。
# 沒有清單時回傳 1。
private_load_terms() {
	[ -f "$PRIVATE_TERMS_FILE" ] || return 1
	PRIVATE_TERMS=$(sed '1s/^\xEF\xBB\xBF//' "$PRIVATE_TERMS_FILE" |
		grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' |
		while IFS= read -r line || [ -n "$line" ]; do
			printf '%s' "$line" | private_normalize
			echo
		done)
	return 0
}

# $1 是已正規化的內容；含任何一個詞就回傳 0
private_contains() {
	for t in $PRIVATE_TERMS; do
		[ -n "$t" ] || continue
		case "$1" in *"$t"*) return 0 ;; esac
	done
	return 1
}
