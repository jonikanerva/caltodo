//! The server-rendered pages of the action links (`server/handlers/common.ts`
//! and `server/handlers/actionRoutes.ts`).
//!
//! The markup and the texts are byte for byte the markup of the Node server.
//! `script/node-fixtures` extracted the template strings from its source.

/// The `escapeHtml` of the Node server.
#[must_use]
pub fn escape_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#039;"),
            other => out.push(other),
        }
    }
    out
}

/// `encodeURIComponent`: every byte except `A-Z a-z 0-9 - _ . ! ~ * ' ( )`
/// is percent-encoded.
#[must_use]
pub fn encode_uri_component(input: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            // Writing to a String cannot fail.
            write!(out, "%{byte:02X}").ok();
        }
    }
    out
}

/// `renderActionShell(title, body)`.
#[must_use]
pub fn shell(title: &str, body: &str) -> String {
    ["\n    <!DOCTYPE html>\n    <html>\n    <head>\n      <title>", &escape_html(title), "</title>\n      <meta charset=\"utf-8\" />\n      <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n      <style>\n        body { font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 32px; }\n        .card { max-width: 520px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08); }\n        h1 { font-size: 20px; margin: 0 0 12px; }\n        p { margin: 0 0 16px; color: #334155; }\n        .actions { display: flex; gap: 12px; flex-wrap: wrap; }\n        .actions form { margin: 0; }\n        button, .button-link { background: #2563eb; color: #fff; border: none; padding: 10px 16px; border-radius: 8px; font-size: 14px; cursor: pointer; text-decoration: none; display: inline-block; }\n        button.secondary { background: #0f172a; }\n        button:disabled { background: #94a3b8; cursor: not-allowed; }\n        .status { margin-top: 16px; font-size: 14px; color: #475569; }\n        .muted { color: #64748b; font-size: 13px; }\n      </style>\n    </head>\n    <body>\n      <div class=\"card\">\n        ", body, "\n      </div>\n    </body>\n    </html>\n  "].concat()
}

/// The page of a missing token.
pub const INVALID_LINK: &str = "\n          <h1>Invalid link</h1>\n          <p>This action link is not valid.</p>\n          <a class=\"button-link\" href=\"/\">Go to Todo</a>\n        ";
/// The page of an unknown, used, or expired token.
pub const EXPIRED_LINK: &str = "\n          <h1>Invalid or expired link</h1>\n          <p>This action link is no longer valid. Please use the app to manage your tasks.</p>\n          <a class=\"button-link\" href=\"/\">Go to Todo</a>\n        ";
/// The page of a token of another user.
pub const NOT_AUTHORIZED: &str = "\n          <h1>Not authorized</h1>\n          <p>This action link belongs to a different account.</p>\n          <a class=\"button-link\" href=\"/\">Go to Todo</a>\n        ";
/// The page of a deleted or unreadable event.
pub const TASK_DELETED: &str = "\n          <h1>Task not found</h1>\n          <p>This task may have been deleted.</p>\n          <a class=\"button-link\" href=\"/\">Go to Todo</a>\n        ";
/// The page of an event that is no task anymore.
pub const TASK_UNMAPPABLE: &str = "\n          <h1>Task not found</h1>\n          <p>This link is no longer valid for that task.</p>\n          <a class=\"button-link\" href=\"/\">Go to Todo</a>\n        ";
/// The page of an unexpected failure of the action page.
pub const SOMETHING_WRONG: &str = "\n        <h1>Something went wrong</h1>\n        <p>Please try again or use the app to manage your tasks.</p>\n        <a class=\"button-link\" href=\"/\">Go to Todo</a>\n      ";

/// The sign-in page of a signed-out visitor.
#[must_use]
pub fn sign_in_required(token: &str) -> String {
    let login_url = format!(
        "/api/auth/google?actionToken={}",
        encode_uri_component(token)
    );
    ["\n          <h1>Sign in required</h1>\n          <p>Sign in to manage this task with your Todo account.</p>\n          <a class=\"button-link\" href=\"", &escape_html(&login_url), "\">Sign in with Google</a>\n        "].concat()
}

/// The manage page with the two action forms.
#[must_use]
pub fn manage(token: &str, title: &str, completed: bool, csrf_token: &str) -> String {
    let shown_title = if title.is_empty() { "Task" } else { title };
    let action_url = escape_html(&format!("/api/action/{}", encode_uri_component(token)));
    let csrf_input = format!(
        r#"<input type="hidden" name="csrfToken" value="{}" />"#,
        escape_html(csrf_token)
    );
    let completed_note = if completed {
        r#"<p class="muted">This task is already marked complete.</p>"#
    } else {
        ""
    };
    [
        "\n        <h1>Manage task</h1>\n        <p>\"",
        &escape_html(shown_title),
        "\"</p>\n        ",
        completed_note,
        "\n        <div class=\"actions\">\n          <form method=\"POST\" action=\"",
        &action_url,
        "\">\n            ",
        &csrf_input,
        "\n            <input type=\"hidden\" name=\"action\" value=\"complete\" />\n            <button type=\"submit\" ",
        if completed { "disabled" } else { "" },
        ">Mark complete</button>\n          </form>\n          <form method=\"POST\" action=\"",
        &action_url,
        "\">\n            ",
        &csrf_input,
        "\n            <input type=\"hidden\" name=\"action\" value=\"reschedule\" />\n            <button type=\"submit\" class=\"secondary\">Reschedule</button>\n          </form>\n        </div>\n      ",
    ]
    .concat()
}

/// The confirmation page of a done action.
#[must_use]
pub fn action_done(label: &str, title: &str) -> String {
    let shown_title = if title.is_empty() { "Task" } else { title };
    ["\n          <h1>", &escape_html(label), "</h1>\n          <p>", &escape_html(shown_title), " has been updated.</p>\n          <a class=\"button-link\" href=\"/\">Go to Todo</a>\n        "].concat()
}

/// The error page of a failed action.
#[must_use]
pub fn action_failed(message: &str) -> String {
    [
        "\n          <h1>",
        &escape_html("Something went wrong"),
        "</h1>\n          <p>",
        &escape_html(message),
        "</p>\n          <a class=\"button-link\" href=\"/\">Go to Todo</a>\n        ",
    ]
    .concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_the_node_server() {
        assert_eq!(
            escape_html(r#"<a href="x">'&'</a>"#),
            "&lt;a href=&quot;x&quot;&gt;&#039;&amp;&#039;&lt;/a&gt;"
        );
        assert_eq!(encode_uri_component("a b/c?d=é"), "a%20b%2Fc%3Fd%3D%C3%A9");
        assert_eq!(encode_uri_component("Az09-_.!~*'()"), "Az09-_.!~*'()");
    }

    #[test]
    fn renders_the_manage_page() {
        let page = shell(
            "Manage task",
            &manage("tok", "Water <plants>", true, "csrf\"1"),
        );
        assert!(page.starts_with("\n    <!DOCTYPE html>"));
        assert!(page.contains("<title>Manage task</title>"));
        assert!(page.contains("<p>\"Water &lt;plants&gt;\"</p>"));
        assert!(page.contains(r#"action="/api/action/tok""#));
        assert!(page.contains(r#"value="csrf&quot;1""#));
        assert!(page.contains("<button type=\"submit\" disabled>Mark complete</button>"));
        assert!(page.contains("This task is already marked complete."));
    }
}
