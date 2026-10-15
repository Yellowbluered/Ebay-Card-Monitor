# -*- coding: utf-8 -*-
"""
card_parser.py — 模組 D：卡牌特徵「嚴格對齊」解析
=================================================
負責把 eBay 商品 / 成交標題精確拆解成 CardFeature：

    {
      "player_or_character": "球員/角色名",
      "year": "年份",
      "set_name": "系列名稱",
      "card_number": "卡號",
      "parallel_or_serial": "平行版本/編號（Base、Refractor、/10 …）",
      "grading_company": "評級機構（PSA、BGS、CGC、Raw 裸卡）",
      "grade": "分數（10、9.5）",
      "is_autograph": true/false
    }

解析策略：
  1. 預設走「正則 + 關鍵字字典」的 token 解析（零成本、離線可用）。
  2. 若 .env 有 DEEPSEEK_API_KEY，則優先嘗試 DeepSeek JSON 結構化解析，
     失敗時自動退回正則解析。

【關鍵防呆】strict_match() 只有特徵完全吻合的成交紀錄才視為同一款卡，
            嚴禁將「限 /10」與「普卡 Base」混為一談。
"""

from __future__ import annotations

import json
import re
from typing import List, Optional, Tuple

from models import CardFeature

# ---------------------------------------------------------------------------
# 字典表（皆為小寫；可依需求自行擴充）
# ---------------------------------------------------------------------------

# 評級機構別名 → 正規化名稱
GRADING_COMPANIES = {
    "psa": "PSA",
    "bgs": "BGS",
    "beckett": "BGS",
    "cgc": "CGC",
    "sgc": "SGC",
    "csg": "CSG",
    "ksa": "KSA",
}

# 裸卡 / 未評級標記
RAW_MARKERS = {"raw", "ungraded", "un-graded", "unslabbed", "裸卡"}

# 簽名標記（含 Signature / Signed / Sign / Sig 等變體，避免普卡基準價混入簽名卡）
AUTO_MARKERS = {"auto", "autograph", "autographed", "auto'd",
                "signature", "signed", "sign", "sig"}

# 「One of One / 1 of 1」極稀缺平行（等同 1/1）；正規化成「1/1」讓 token 解析視為限量。
# 這樣普卡（Base）計算歷史基準價時，才能把 1/1 這類極稀缺成交紀錄嚴格排除。
ONE_OF_ONE_RE = re.compile(
    r"\b(?:one\s*of\s*one|1\s*of\s*1|one\s*of\s*1|1\s*of\s*one)\b",
    re.IGNORECASE,
)

# 平行/編號版本關鍵字（單一 token，小寫）。
# 注意：不含 prizm/optic/mosaic 等「既是系列又是平行」的歧義詞，
#       那些留在系列字典，避免「Panini Prizm」這種系列名被誤拆。
PARALLEL_KEYWORDS = {
    "base", "refractor", "silver", "gold", "holo", "reverse", "holofoil",
    "mojo", "pulsar", "velocity", "disco", "hyper", "wave", "x-fractor",
    "fractor", "atomic", "sepia", "negative", "pink", "blue", "green",
    "red", "purple", "orange", "yellow", "teal", "cracked", "ice",
    "diamond", "rainbow", "checkerboard", "numbered", "serial", "jersey",
    "relic", "patch", "tiger", "zebra", "galactic", "nebula", "shimmer",
    "sparkle", "retro", "throwback", "logo", "variation", "sp", "ssp",
    "insert", "stained", "glass", "white",
}

# 用來判斷「N/D」是「限量編號」還是「卡號/總張數」的分母集合。
# 例：4/10 → 限量 10 張（平行/編號）；4/102 → 卡號 4、全套 102 張（卡號）。
SERIAL_PRINT_RUNS = {1, 5, 10, 25, 49, 50, 75, 99}

# 系列「多字片語」（最長優先移除），避免 "base set" 被拆成 parallel "base"。
KNOWN_SET_PHRASES = [
    "base set 2", "base set", "upper deck", "sp authentic", "sp game used",
    "national treasures", "totally certified", "metal universe", "court kings",
    "crown royale", "donruss optic", "panini one and one", "panini one",
    "diamond & pearl", "sword & shield", "scarlet & violet", "obsidian flames",
    "paldea evolved", "paradox rift", "temporal forces", "twilight masquerade",
    "stellar crown", "shrouded fable", "prismatic evolutions", "shining fates",
    "hidden fates", "champions path", "evolving skies", "brilliant stars",
    "astral radiance", "lost origin", "silver tempest", "crown zenith",
    "fusion strike", "chilling reign", "battle styles", "darkness ablaze",
    "rebel clash", "vivid voltage", "team rocket", "gym heroes", "gym challenge",
    "neo genesis", "neo discovery", "neo revelation", "neo destiny",
    "ex ruby", "ex sandstorm", "ex dragon", "ex deoxys", "ex emerald",
    "black & white", "sun & moon",
]

# 系列「單字」（高信心、不易與球員名撞詞的品牌/系列詞）
KNOWN_SET_WORDS = {
    "topps", "panini", "donruss", "fleer", "upper", "deck", "bowman",
    "chrome", "select", "contenders", "hoops", "revolution", "leaf",
    "exquisite", "flawless", "origins", "obsidian", "spectra", "noir",
    "prestige", "score", "elite", "threads", "illusions", "chronicles",
    "courtside", "absolute", "certified", "immaculate", "prizm", "optic",
    "mosaic", "pokemon", "jungle", "fossil", "rocket", "heroes", "challenge",
    "genesis", "discovery", "revelation", "destiny", "expedition", "aquapolis",
    "skyridge", "ruby", "sapphire", "sandstorm", "dragon", "holon", "deoxys",
    "emerald", "guardians", "majestic", "platinum", "arceus", "heartgold",
    "soulsilver", "unleashed", "undaunted", "triumphant", "plasma", "flashfire",
    "primal", "breakthrough", "breakpoint", "evolutions", "crimson", "celestial",
    "unbroken", "champion", "vivid", "voltage", "battle", "styles", "chilling",
    "reign", "evolving", "skies", "fusion", "strike", "brilliant", "stars",
    "astral", "radiance", "tempest", "zenith", "scarlet", "violet", "paldea",
    "evolved", "flames", "rift", "temporal", "twilight", "masquerade", "stellar",
    "shrouded", "fable", "prismatic", "destined", "rivals", "journey",
    "national", "treasures", "kings", "royale", "metal", "universe", "151",
}

# 噪音詞：從身份 token 中剔除（例如 "rare"、"rookie"、"card"）
STOP_WORDS = {"rare", "rookie", "rc", "card", "trading", "english", "holo",
              "promo", "numbered"}


def _clean_title(title: str) -> str:
    """清掉 eBay 標題前後常見雜訊字樣。"""
    if not title:
        return ""
    text = str(title).replace("\u00a0", " ")
    text = re.sub(r"(?i)^\s*new listing\s*", "", text)
    text = re.sub(r"(?i)^\s*sponsored\s*", "", text)
    text = re.sub(r"(?i)opens in a new window or tab", "", text)
    text = re.sub(r"(?i)new listing", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _norm(s) -> str:
    return " ".join(str(s or "").lower().split())


def _toks(s) -> set:
    return set(str(s or "").lower().split())


# ---------------------------------------------------------------------------
# 正則解析主體
# ---------------------------------------------------------------------------

def regex_parse_card_title(title: str) -> CardFeature:
    """純正則 + 關鍵字字典解析標題 → CardFeature。"""
    feature = CardFeature()
    text = _clean_title(title)
    if not text:
        return feature
    # 「One of One / 1 of 1」先正規化成「1/1」，讓後續 token 解析視為極稀缺限量（1/1）
    text = ONE_OF_ONE_RE.sub("1/1", text)
    lower = text.lower()

    # 1) 先移除「系列多字片語」（最長優先），避免 "base set" 被拆成 parallel "base"
    set_phrases: List[str] = []
    for phrase in sorted(KNOWN_SET_PHRASES, key=len, reverse=True):
        pattern = r"(?<![a-z0-9])" + re.escape(phrase) + r"(?![a-z0-9])"
        if re.search(pattern, lower):
            set_phrases.append(phrase)
            lower = re.sub(pattern, " ", lower, count=1)

    tokens = lower.split()
    n = len(tokens)
    consumed = [False] * n

    # 2) 評級機構 + 分數
    for i, tok in enumerate(tokens):
        if consumed[i]:
            continue
        if tok in GRADING_COMPANIES:
            feature.grading_company = GRADING_COMPANIES[tok]
            consumed[i] = True
            # 往後找分數（限定最多 6 個 token，允許 "gem mint" 等修飾詞）
            for j in range(i + 1, min(i + 7, n)):
                if consumed[j]:
                    continue
                if re.fullmatch(r"\d{1,2}(?:\.\d+)?", tokens[j]):
                    feature.grade = tokens[j]
                    consumed[j] = True
                    break
                if tokens[j] in {"gem", "mint", "grade", "nm", "mt"}:
                    consumed[j] = True
                    continue
                break
        elif tok in RAW_MARKERS:
            feature.grading_company = "Raw"
            consumed[i] = True
            break

    # 3) 簽名
    for i, tok in enumerate(tokens):
        if consumed[i]:
            continue
        if tok in AUTO_MARKERS or tok.startswith("auto"):
            feature.is_autograph = True
            consumed[i] = True

    # 4) 年份
    for i, tok in enumerate(tokens):
        if consumed[i]:
            continue
        if re.fullmatch(r"(19|20)\d{2}", tok):
            feature.year = tok
            consumed[i] = True
            break

    # 5) 卡號 / 限量編號
    serial_parts: List[str] = []
    for i, tok in enumerate(tokens):
        if consumed[i]:
            continue
        m = re.fullmatch(r"#(\d{1,4})", tok)
        if m:
            feature.card_number = m.group(1)
            consumed[i] = True
            continue
        m = re.fullmatch(r"(\d{1,3})/(\d{1,4})", tok)
        if m:
            denom = int(m.group(2))
            if denom in SERIAL_PRINT_RUNS:
                serial_parts.append(tok)   # 例 4/10 → 限量編號
            else:
                feature.card_number = tok  # 例 4/102 → 卡號/總張數
            consumed[i] = True
            continue
        m = re.fullmatch(r"/(\d{1,4})", tok)
        if m:
            # 例 "/10"（無流水號前綴，eBay 標題常這樣寫）→ 限量編號
            denom = int(m.group(1))
            if denom in SERIAL_PRINT_RUNS:
                serial_parts.append(tok)
            else:
                feature.card_number = tok
            consumed[i] = True
            continue
        if tok in {"no.", "no"}:
            # "No. 4" → 卡號
            for j in range(i + 1, min(i + 3, n)):
                if consumed[j]:
                    continue
                if re.fullmatch(r"\d{1,4}", tokens[j]):
                    feature.card_number = tokens[j]
                    consumed[j] = True
                    break
            consumed[i] = True

    # 6) 平行版本關鍵字
    parallel_parts: List[str] = []
    for i, tok in enumerate(tokens):
        if consumed[i]:
            continue
        if tok in PARALLEL_KEYWORDS:
            parallel_parts.append(tok)
            consumed[i] = True

    combined = sorted(set(serial_parts + parallel_parts))
    feature.parallel_or_serial = " ".join(combined)

    # 7) 剩餘 token → 系列 or 球員（噪音詞直接略過）
    set_words: List[str] = []
    player_words: List[str] = []
    for i, tok in enumerate(tokens):
        if consumed[i]:
            continue
        if tok in STOP_WORDS:
            continue
        if tok in KNOWN_SET_WORDS:
            set_words.append(tok)
        else:
            player_words.append(tok)

    feature.set_name = " ".join(set_phrases + set_words).strip()
    feature.player_or_character = " ".join(player_words).strip()
    return feature


# ---------------------------------------------------------------------------
# DeepSeek JSON 結構化解析（選填）
# ---------------------------------------------------------------------------

def card_feature_from_dict(data: dict) -> CardFeature:
    """把解析後的 JSON dict 轉成 CardFeature。"""
    feature = CardFeature()
    feature.player_or_character = str(data.get("player_or_character") or "").strip()
    feature.year = str(data.get("year") or "").strip()
    feature.set_name = str(data.get("set_name") or "").strip()
    feature.card_number = str(data.get("card_number") or "").strip()
    feature.parallel_or_serial = str(data.get("parallel_or_serial") or "").strip()
    feature.grading_company = str(data.get("grading_company") or "").strip()
    feature.grade = str(data.get("grade") or "").strip()

    auto = data.get("is_autograph", False)
    if isinstance(auto, str):
        feature.is_autograph = auto.strip().lower() in ("true", "1", "yes", "y")
    else:
        feature.is_autograph = bool(auto)
    return feature


def deepseek_parse_card_title(title: str, api_key: str,
                              base_url: str = "https://api.deepseek.com") -> CardFeature:
    """呼叫 DeepSeek 把標題結構化成 JSON，回傳 CardFeature。

    失敗時由呼叫端（parse_card_title）自動退回正則解析。
    """
    import requests  # 延後匯入，未用 DeepSeek 時不影響

    url = base_url.rstrip("/") + "/chat/completions"
    system_prompt = (
        "你是運動卡 / 集換式卡牌的標題解析器。請把使用者給的 eBay 商品標題拆解成 JSON，"
        "欄位固定為：player_or_character、year、set_name、card_number、"
        "parallel_or_serial、grading_company、grade、is_autograph。"
        "所有欄位都回傳字串（空字串表示未知），is_autograph 回傳 true/false。"
        "只輸出 JSON 物件，不要輸出其他任何文字。"
    )
    payload = {
        "model": "deepseek-chat",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": str(title)},
        ],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    resp = requests.post(
        url,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=30,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    return card_feature_from_dict(json.loads(content))


def parse_card_title(title: str, settings=None) -> CardFeature:
    """統一的解析入口：有 DeepSeek key 就優先 DeepSeek，否則走正則。"""
    if settings is not None and getattr(settings, "deepseek_api_key", ""):
        try:
            return deepseek_parse_card_title(
                title, settings.deepseek_api_key, settings.deepseek_base_url
            )
        except Exception:
            pass
    return regex_parse_card_title(title)


# ---------------------------------------------------------------------------
# 嚴格比對（模組 D 的關鍵防呆）
# ---------------------------------------------------------------------------

def _canonical_parallel(s) -> str:
    """平行/編號正規化：Base 與「未標示」都視為普卡（空字串）。

    另外把限量編號統一成「張數」：4/10、/10 都正規化成 "10"，
    避免同一款 /10 卡因「有沒有流水號前綴」而被誤判為不同卡。
    """
    toks = set()
    for t in _toks(s):
        m = re.fullmatch(r"(\d{1,3})?/(\d{1,4})", t)
        if m:
            toks.add(m.group(2))   # 只保留限量張數（4/10、/10 → 10）
        else:
            toks.add(t)
    if toks <= {"base"}:
        return ""
    return ",".join(sorted(toks))


def is_base_card(feature: CardFeature) -> bool:
    """判斷是否為普卡（無簽名且非限量/平行/編號）。

    供 price_engine 在計算「普卡歷史基準價」時，先行判斷查詢目標是否為普卡；
    若是，則對成交標題套用 title_has_scarcity_signal 第二道防呆。
    """
    return (not feature.is_autograph) and _canonical_parallel(feature.parallel_or_serial) == ""


def title_has_scarcity_signal(title: str) -> bool:
    """以「原始標題文字」判斷是否含限量 / 簽名訊號（第二道防呆）。

    不依賴結構化解析結果，直接掃標題，涵蓋：
      * 簽名：auto / autograph / signature / signed / sign / sig
      * 極稀缺：1/1、one of one、1 of 1
      * 低編號限量：/1、/5、/10、/25、/49、/50、/75、/99 …（對齊 SERIAL_PRINT_RUNS）

    用途：普卡基準價計算前，把帶有這些訊號的成交紀錄嚴格排除，
    避免 Auto / 簽名 / 1 of 1 / 低編號平行把普卡歷史價拉高。
    """
    if not title:
        return False
    lower = str(title).lower()
    tokens = set(re.findall(r"[a-z0-9'/]+", lower))
    if tokens & AUTO_MARKERS:
        return True
    if ONE_OF_ONE_RE.search(lower):
        return True
    for m in re.finditer(r"/(\d{1,4})", lower):
        if int(m.group(1)) in SERIAL_PRINT_RUNS:
            return True
    return False


def strict_match(target: CardFeature, candidate: CardFeature) -> Tuple[bool, List[str]]:
    """判斷 candidate（成交紀錄）是否與 target（查詢卡）為「同一款卡」。

    規則（只有特徵完全吻合才算同一款卡）：
      1. 身份 token（球員 ∪ 系列）集合必須完全相等（順序無關）。
      2. 平行/編號必須完全相等（Base 與未標示視為相同）→ 嚴禁 /10 與普卡混用。
      3. 年份 / 卡號 / 評級 / 分數：target 有指定就必須完全相等。
      4. 簽名雙向隔離：普卡（無簽）與簽名卡不得混用，反之亦然。

    回傳 (是否吻合, 不吻合原因清單)。
    """
    reasons: List[str] = []

    t_identity = _toks(target.player_or_character) | _toks(target.set_name)
    c_identity = _toks(candidate.player_or_character) | _toks(candidate.set_name)
    if t_identity and t_identity != c_identity:
        reasons.append("identity")

    if _canonical_parallel(target.parallel_or_serial) != _canonical_parallel(candidate.parallel_or_serial):
        reasons.append("parallel_or_serial")

    for field, tval, cval in (
        ("year", target.year, candidate.year),
        ("card_number", target.card_number, candidate.card_number),
        ("grading_company", target.grading_company, candidate.grading_company),
        ("grade", target.grade, candidate.grade),
    ):
        if _norm(tval) and _norm(tval) != _norm(cval):
            reasons.append(field)

    # 雙向隔離：普卡基準價排除簽名卡成交紀錄；簽名卡基準價亦排除普卡成交紀錄。
    if target.is_autograph != candidate.is_autograph:
        reasons.append("is_autograph")

    return (not reasons), reasons


def same_card(a: CardFeature, b: CardFeature) -> bool:
    """指紋完全相等即同一款卡（供快速比對用）。"""
    return a.fingerprint() == b.fingerprint()


