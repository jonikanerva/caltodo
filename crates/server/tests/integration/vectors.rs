//! Byte compatibility with the Node server: the stored token format, the
//! action token hashes, and the action pages. The vectors come from the
//! Node code (`tests/fixtures/node/`).

use caltodo::config::Secret;
use caltodo::http::html;
use caltodo::security::action_tokens::TokenHasher;
use caltodo::security::token_cipher::TokenCipher;
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/node/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn nonce_of(stored: &str) -> [u8; 12] {
    use base64::Engine as _;
    let part = stored.split(':').nth(2).unwrap();
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(part)
        .unwrap()
        .try_into()
        .unwrap()
}

#[test]
fn decrypts_node_tokens_and_writes_the_same_bytes() {
    let vectors = fixture("token_crypto.vectors.json");
    let cipher = TokenCipher::new(&Secret::new(vectors["key"].as_str().unwrap()));
    let encrypted = vectors["encrypted"].as_array().unwrap();
    assert_eq!(encrypted.len(), 5);
    for vector in encrypted {
        let plaintext = vector["plaintext"].as_str().unwrap();
        let stored = vector["stored"].as_str().unwrap();
        assert_eq!(cipher.decrypt(stored).as_deref(), Some(plaintext));
        // With the nonce of the Node value, the Rust output is the Node
        // output byte for byte, so the Node parser accepts Rust values.
        assert_eq!(
            cipher.encrypt_with_nonce(plaintext, nonce_of(stored)),
            stored
        );
        // A fresh Rust value decrypts too and has the Node layout.
        let fresh = cipher.encrypt(plaintext).unwrap();
        let parts: Vec<&str> = fresh.split(':').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!((parts[0], parts[1]), ("enc", "v1"));
        assert_eq!(parts[2].len(), 16);
        assert_eq!(parts[3].len(), 22);
        assert!(!fresh.contains('='));
        assert_eq!(cipher.decrypt(&fresh).as_deref(), Some(plaintext));
    }
}

#[test]
fn reads_malformed_values_like_the_node_server() {
    let vectors = fixture("token_crypto.vectors.json");
    let cipher = TokenCipher::new(&Secret::new(vectors["key"].as_str().unwrap()));
    for case in vectors["decrypt"].as_array().unwrap() {
        let expected = case["decrypted"].as_str();
        assert_eq!(
            cipher.decrypt(case["stored"].as_str().unwrap()).as_deref(),
            expected,
            "{}",
            case["name"]
        );
    }
}

#[test]
fn hashes_action_tokens_like_the_node_server() {
    let vectors = fixture("action_tokens.vectors.json");
    let hasher = TokenHasher::new(Secret::new(vectors["secret"].as_str().unwrap()));
    for vector in vectors["generated"].as_array().unwrap() {
        assert_eq!(
            hasher.hash(vector["token"].as_str().unwrap()),
            vector["tokenHash"].as_str().unwrap()
        );
    }
    for vector in vectors["hashed"].as_array().unwrap() {
        let token = vector["token"].as_str().unwrap();
        match vector["tokenHash"].as_str() {
            Some(hash) => assert_eq!(hasher.hash(token), hash),
            // The Node lookup skipped an empty token.
            None => assert_eq!(token, ""),
        }
    }
    assert_eq!(
        caltodo::security::action_tokens::TOKEN_LIFETIME.as_millis(),
        i128::from(vectors["expiryMs"].as_i64().unwrap())
    );
}

#[test]
fn renders_the_action_pages_byte_for_byte() {
    let golden = fixture("action_flow.golden.json");
    let csrf = "csrf<\"&'>token";
    for page in golden["pages"].as_array().unwrap() {
        let name = page["name"].as_str().unwrap();
        let token = page["tokenParam"].as_str().unwrap();
        let (status, rendered) = match name {
            "signed out" => (
                200,
                html::shell("Sign in required", &html::sign_in_required(token)),
            ),
            "invalid token" => (400, html::shell("Invalid Link", html::EXPIRED_LINK)),
            "other user" => (403, html::shell("Not authorized", html::NOT_AUTHORIZED)),
            "deleted event" => (404, html::shell("Task not found", html::TASK_DELETED)),
            "foreign event" => (404, html::shell("Task not found", html::TASK_UNMAPPABLE)),
            "manage open task" => (
                200,
                html::shell(
                    "Manage task",
                    &html::manage(token, "Water <plants> & \"more\"", false, csrf),
                ),
            ),
            "manage completed task" => (
                200,
                html::shell(
                    "Manage task",
                    &html::manage(token, "Water <plants> & \"more\"", true, csrf),
                ),
            ),
            "manage untitled task" => (
                200,
                html::shell("Manage task", &html::manage(token, "", false, csrf)),
            ),
            other => panic!("unknown page {other}"),
        };
        assert_eq!(page["status"], status, "{name}");
        assert_eq!(page["html"].as_str().unwrap(), rendered, "{name}");
    }
    let error_page = golden["results"][1]["body"].as_str().unwrap();
    assert_eq!(
        error_page,
        html::shell("Error", &html::action_failed("Invalid or expired link."))
    );
}
