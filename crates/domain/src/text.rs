//! Text rules of the JavaScript runtime that the wire contract depends on.

/// True for a character that `String.prototype.trim` removes: the
/// ECMAScript `WhiteSpace` and `LineTerminator` code points.
///
/// Rust's `char::is_whitespace` differs: it includes U+0085 and excludes
/// U+FEFF.
#[must_use]
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`.
#[must_use]
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// The length of a JavaScript string: the number of UTF-16 code units. The
/// Node server validated text lengths with this count.
#[must_use]
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_like_javascript() {
        assert_eq!(js_trim("\u{feff} a b \r\n"), "a b");
        assert_eq!(js_trim("\u{85}x\u{85}"), "\u{85}x\u{85}");
        assert_eq!(js_trim("\t\u{3000}"), "");
    }

    #[test]
    fn counts_utf16_code_units() {
        assert_eq!(utf16_len(""), 0);
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("ä"), 1);
        assert_eq!(utf16_len("✅"), 1);
        assert_eq!(utf16_len("☑️"), 2);
        assert_eq!(utf16_len("😀"), 2);
    }
}
